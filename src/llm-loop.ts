import path from "node:path";
import {
	Agent,
	type AgentInputItem,
	type FunctionToolResult,
	Runner,
	setDefaultOpenAIClient,
	setOpenAIAPI,
	setTracingDisabled,
	type Tool,
	tool,
} from "@openai/agents";
import OpenAI from "openai";
import {
	loadAgentContext,
	loadHomeAgentsFile,
	loadSkillsIndex,
	readInitContent,
} from "./agent-context";
import { notifyEventDropped } from "./event-dropped";
import {
	ACTIVE_SESSION_META_KEY,
	type EventQueue,
	LAST_REPLYABLE_TARGET_META_KEY,
	type QueuedEvent,
	timestampFromUUIDv7,
} from "./event-queue";
import {
	type BootstrapRuntimeOptions,
	reloadModules,
	type StartedDaemon,
	type TimerScheduler,
} from "./runtime";
import type { SessionStore } from "./session-store";
import { buildSystemPrompt } from "./system-prompt";
import { runReadFileBase64 } from "./workspace";

setTracingDisabled(true);

export function resolveModelConfig(): string {
	const apiKey = process.env.JUSTCLAW_OPENAI_API_KEY;
	const model = process.env.JUSTCLAW_OPENAI_MODEL;
	const baseURL = process.env.JUSTCLAW_OPENAI_BASE_URL;
	if (!apiKey) {
		throw new Error("JUSTCLAW_OPENAI_API_KEY is required");
	}
	if (!model) {
		throw new Error("JUSTCLAW_OPENAI_MODEL is required");
	}

	setDefaultOpenAIClient(
		new OpenAI({
			apiKey,
			...(baseURL !== undefined && baseURL !== "" ? { baseURL } : {}),
		}),
	);
	setOpenAIAPI("chat_completions");
	return model;
}

// Maximum agent turns (LLM call -> tool calls -> repeat) per event before the
// runner gives up. Defaults to 10, matching the @openai/agents default.
export function resolveMaxTurns(): number {
	const raw = process.env.JUSTCLAW_MAX_TURNS;
	if (raw === undefined || raw === "") {
		return 10;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(
			`JUSTCLAW_MAX_TURNS must be a positive integer, got ${JSON.stringify(raw)}`,
		);
	}
	return parsed;
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assertValidXmlKey(key: string): void {
	if (!/^[a-zA-Z_][\w.-]*$/.test(key)) {
		throw new Error(`Invalid XML element name: ${JSON.stringify(key)}`);
	}
}

function valueToXml(tag: string, value: unknown, indent: string): string {
	assertValidXmlKey(tag);
	if (value === null || value === undefined) {
		return "";
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => valueToXml(tag, item, indent))
			.filter(Boolean)
			.join("\n");
	}
	if (typeof value === "object") {
		const inner = objectToXml(value as Record<string, unknown>, `${indent}  `);
		return inner
			? `${indent}<${tag}>\n${inner}\n${indent}</${tag}>`
			: `${indent}<${tag}></${tag}>`;
	}
	return `${indent}<${tag}>${escapeXml(String(value))}</${tag}>`;
}

function objectToXml(obj: Record<string, unknown>, indent = "  "): string {
	return Object.entries(obj)
		.map(([k, v]) => valueToXml(k, v, indent))
		.filter(Boolean)
		.join("\n");
}

export function eventToXml(event: QueuedEvent): string {
	const timestamp = timestampFromUUIDv7(event.id);
	const { type, ...rest } = event.params;
	// For multimodal envelopes the base64 `data` rides a separate input_image /
	// input_file content part (see the userInput builder below). Keep it out of
	// the XML so the bytes are not sent twice; the text copy blows past the
	// context window. The small descriptive fields (mediaType, filename) stay.
	if (type === "image.send.v1" || type === "file.send.v1") {
		delete (rest as Record<string, unknown>).data;
	}
	const inner = objectToXml(rest);
	const attrs = `source="${escapeXml(event.source)}" timestamp="${escapeXml(timestamp)}"`;
	return inner
		? `<event ${attrs}>\n${inner}\n</event>`
		: `<event ${attrs}></event>`;
}

function inferImageMediaType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/jpeg";
	}
}

function inferFileMediaType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".pdf":
			return "application/pdf";
		case ".txt":
			return "text/plain";
		case ".csv":
			return "text/csv";
		default:
			return "application/octet-stream";
	}
}

function wrapWithNotification(
	t: Tool,
	getTarget: () => string,
	daemonsRef: { current: StartedDaemon[] },
): Tool {
	if (t.type !== "function") {
		return t;
	}
	const originalInvoke = t.invoke.bind(t);
	return {
		...t,
		invoke: async (runContext, input, details) => {
			const output = await originalInvoke(runContext, input, details);
			let inputForNotify: unknown = input;
			try {
				inputForNotify = JSON.parse(input) as unknown;
			} catch {
				// keep raw string when invoke receives non-JSON input
			}
			const outputStr =
				typeof output === "string" ? output : JSON.stringify(output);
			const daemon = daemonsRef.current.find(
				(d) => d.manifest.name === getTarget(),
			);
			daemon?.peer.notify("event", {
				type: "tool_call.v1",
				tool: t.name,
				input: inputForNotify,
				output: outputStr,
			});
			return output;
		},
	};
}

function buildModuleTools(daemons: StartedDaemon[]): Tool[] {
	return daemons.flatMap((daemon) =>
		daemon.tools.map((toolDef) =>
			tool({
				name: `${daemon.manifest.name}__${toolDef.name}`,
				description: toolDef.description,
				// biome-ignore lint/suspicious/noExplicitAny: avoid @openai/agents-core subpath types for parameters
				parameters: toolDef.parameters as any,
				strict: false,
				execute: async (input: unknown) => {
					const result = await daemon.peer.request(
						`tool/${toolDef.name}`,
						input ?? {},
					);
					return JSON.stringify(result);
				},
			}),
		),
	);
}

function buildRouteMessageTool(
	daemonsRef: { current: StartedDaemon[] },
	getTarget: () => string,
	onSend: (moduleName: string) => void,
): Tool {
	return tool({
		name: "route_message",
		description:
			"Route a message to a replyable module other than the current delivery target. Use this only when forwarding output to a different module. To reply to the sender of the current event, emit free-form text instead — it is delivered automatically. Calling it with the current delivery target as the destination returns an error.",
		parameters: {
			type: "object",
			properties: {
				module: {
					type: "string",
					description:
						"Target module name (must differ from the current delivery target)",
				},
				text: { type: "string", description: "Message body" },
			},
			required: ["module", "text"],
			additionalProperties: false,
		},
		strict: true,
		execute: async (input: unknown) => {
			const { module: moduleName, text } = input as {
				module: string;
				text: string;
			};
			if (moduleName === getTarget()) {
				return `error: "${moduleName}" is already the current delivery target; emit free-form text to reply to the current sender`;
			}
			const daemon = daemonsRef.current.find(
				(d) => d.manifest.name === moduleName,
			);
			if (!daemon) {
				return `error: module "${moduleName}" not found`;
			}
			if (daemon.manifest.replyable !== true) {
				return `error: module "${moduleName}" is not replyable`;
			}
			daemon.peer.notify("event", { type: "message.send.v1", text });
			onSend(moduleName);
			return "ok";
		},
	});
}

export type LlmLoopOptions = {
	runner?: Runner;
	sessionStore?: SessionStore;
	workspaceTools?: Tool[];
	workspaceDir?: string;
	historyDir?: string;
	characterDir?: string;
	contextInstructions?: string;
	homeDir?: string;
	modulesRoot?: string;
	skillsDir?: string;
	sandboxFactory?: BootstrapRuntimeOptions["sandboxFactory"];
	initializeTimeoutMs?: BootstrapRuntimeOptions["initializeTimeoutMs"];
	abortSignal?: BootstrapRuntimeOptions["abortSignal"];
	timerSchedulerRef?: { current: TimerScheduler };
};

function resetSessionState(state: {
	currentSessionId: string | null;
	history: AgentInputItem[];
}): void {
	state.currentSessionId = null;
	state.history = [];
}

async function loadSessionIntoState(
	id: string,
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	sessionStore: SessionStore,
	context: string,
): Promise<boolean> {
	try {
		const loaded = await sessionStore.load(id);
		if (loaded === null) {
			return false;
		}
		state.history = loaded;
		state.currentSessionId = id;
		return true;
	} catch (error) {
		console.warn(
			`[core] ${context}: session "${id}" is invalid or unreadable (${error instanceof Error ? error.message : String(error)})`,
		);
		return false;
	}
}

async function applySessionSwitch(
	newId: string,
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	eventQueue: EventQueue,
	sessionStore: SessionStore,
): Promise<boolean> {
	if (newId === state.currentSessionId) {
		eventQueue.setMeta(ACTIVE_SESSION_META_KEY, newId);
		return true;
	}
	if (state.currentSessionId !== null) {
		if (await shouldPersistCurrentSession(state, eventQueue)) {
			await sessionStore.save(state.currentSessionId, state.history);
		}
	}
	if (
		!(await loadSessionIntoState(
			newId,
			state,
			sessionStore,
			"sessions.switch.v1 apply",
		))
	) {
		console.error(
			`[core] sessions.switch.v1: history for session "${newId}" is missing or unreadable at apply time; switch not applied`,
		);
		return false;
	}
	eventQueue.setMeta(ACTIVE_SESSION_META_KEY, newId);
	return true;
}

async function adoptSessionFromMetadata(
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	eventQueue: EventQueue,
	sessionStore: SessionStore,
): Promise<boolean> {
	const metaSessionId = eventQueue.getMeta(ACTIVE_SESSION_META_KEY);
	if (metaSessionId !== null) {
		if (
			await loadSessionIntoState(
				metaSessionId,
				state,
				sessionStore,
				"active_session_id metadata adopt",
			)
		) {
			return true;
		}
		console.warn(
			`[core] active session metadata points to unreadable session "${metaSessionId}"; falling back to newest readable session`,
		);
	}

	const fallbackId = sessionStore.newestReadableSessionId();
	if (fallbackId === null) {
		return false;
	}
	if (
		!(await loadSessionIntoState(
			fallbackId,
			state,
			sessionStore,
			"newest readable fallback adopt",
		))
	) {
		return false;
	}
	eventQueue.setMeta(ACTIVE_SESSION_META_KEY, fallbackId);
	return true;
}

async function shouldPersistCurrentSession(
	state: { currentSessionId: string | null; history: AgentInputItem[] },
	eventQueue: EventQueue,
): Promise<boolean> {
	if (state.currentSessionId === null) {
		return false;
	}
	return state.currentSessionId === eventQueue.getMeta(ACTIVE_SESSION_META_KEY);
}

function isSessionsSwitchV1(
	params: Record<string, unknown>,
): params is { type: "sessions.switch.v1"; id: string } {
	return (
		params.type === "sessions.switch.v1" &&
		typeof params.id === "string" &&
		params.id !== ""
	);
}

export async function runLlmLoop(
	eventQueue: EventQueue,
	daemonsRef: { current: StartedDaemon[] },
	model: string,
	options?: LlmLoopOptions,
): Promise<void> {
	const runner = options?.runner ?? new Runner({ tracingDisabled: true });
	const maxTurns = resolveMaxTurns();
	const sessionStore = options?.sessionStore;
	const baseAgent = new Agent({
		name: "justclaw",
		model,
		instructions: "",
		tools: [],
	});

	const session = {
		currentSessionId: null as string | null,
		history: [] as AgentInputItem[],
	};

	while (true) {
		// Interrupt slot takes priority over the persistent queue. Interrupt events
		// are synthetic (not stored in the DB), so complete() is skipped for them.
		const interrupt = eventQueue.consumeInterrupt();
		const isInterrupt = interrupt !== null;
		const event = isInterrupt
			? {
					id: Bun.randomUUIDv7(),
					source: interrupt.source,
					params: interrupt.params,
				}
			: await eventQueue.next();
		if (!event) {
			break;
		}

		if (
			session.currentSessionId !== eventQueue.getMeta(ACTIVE_SESSION_META_KEY)
		) {
			resetSessionState(session);
		}

		if (isSessionsSwitchV1(event.params)) {
			if (!sessionStore) {
				console.warn(
					`[core] sessions.switch.v1 requires a configured session store; dropping switch for "${event.params.id}"`,
				);
				notifyEventDropped(daemonsRef.current, event);
				eventQueue.complete(event.id);
				continue;
			}
			let applied = false;
			try {
				applied = await applySessionSwitch(
					event.params.id,
					session,
					eventQueue,
					sessionStore,
				);
			} catch (error) {
				console.error(
					`[core] sessions.switch.v1 failed for "${event.params.id}": ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			if (!applied) {
				notifyEventDropped(daemonsRef.current, event);
			}
			eventQueue.complete(event.id);
			continue;
		}

		// QueuedEvent.params is untyped; only LLM-bound envelope types reach the model.
		const envelopeType = event.params.type;
		if (
			envelopeType !== "event.v1" &&
			envelopeType !== "image.send.v1" &&
			envelopeType !== "file.send.v1"
		) {
			console.warn(
				`[core] unsupported internal event type for ${event.source} (id=${event.id}): ${String(envelopeType)} (expected event.v1, image.send.v1, or file.send.v1); dropping`,
			);
			eventQueue.complete(event.id);
			continue;
		}

		if (sessionStore && session.currentSessionId === null) {
			try {
				const adopted = await adoptSessionFromMetadata(
					session,
					eventQueue,
					sessionStore,
				);
				// Fires once when a new empty session is first adopted at bootstrap.
				// Explicit-switch cases are handled in sessions.switch.v1 before "ok" is returned.
				if (adopted && session.history.length === 0 && options?.characterDir) {
					const initText = await readInitContent(options.characterDir);
					if (initText) {
						eventQueue.enqueue(event.source, {
							type: "event.v1",
							text: initText,
						});
					}
				}
			} catch (error) {
				console.error(
					`[core] failed to adopt initial session for event from ${event.source} (id=${event.id}): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				notifyEventDropped(daemonsRef.current, event);
				eventQueue.complete(event.id);
				continue;
			}
		}
		if (sessionStore && session.currentSessionId === null) {
			console.error(
				`[core] no active session for event from ${event.source} (id=${event.id}); add a session history file or call sessions.switch.v1 — dropping`,
			);
			notifyEventDropped(daemonsRef.current, event);
			eventQueue.complete(event.id);
			continue;
		}

		const sourceDaemon = daemonsRef.current.find(
			(d) => d.manifest.name === event.source,
		);
		if (sourceDaemon?.manifest.replyable === true) {
			eventQueue.setMeta(LAST_REPLYABLE_TARGET_META_KEY, event.source);
		}
		const fallbackTarget =
			eventQueue.getMeta(LAST_REPLYABLE_TARGET_META_KEY) ?? event.source;
		let currentTarget =
			sourceDaemon?.manifest.replyable === true ? event.source : fallbackTarget;

		const restartModulesTool = tool({
			name: "restart_modules",
			description:
				"Reload all modules (daemon and timer) from the modules directory (reflects adds/removes and manifest changes). Discovery runs first; on failure existing processes stay up and the tool returns an error. On success, processes update immediately (modules that fail to start are skipped with a warning) and the current LLM run ends after this tool call; pass non-empty continuation to enqueue a follow-up event.v1 (source fixed to current event source) so the next event runs with the reloaded module set. Pass an empty string when no follow-up is needed.",
			parameters: {
				type: "object",
				properties: {
					continuation: {
						type: "string",
						description:
							'After a successful reload, non-whitespace continuation enqueues one event.v1 (source = current event source, params = { type: "event.v1", text: continuation }). Pass empty string when no follow-up is needed.',
					},
				},
				required: ["continuation"],
				additionalProperties: false,
			},
			strict: true,
			execute: async (input: unknown) => {
				if (options?.modulesRoot === undefined || options.modulesRoot === "") {
					return "error: modules root not configured";
				}
				if (!sessionStore) {
					return "error: session store not configured";
				}
				try {
					await reloadModules(daemonsRef, options.modulesRoot, eventQueue, {
						sessionStore,
						sandboxFactory: options.sandboxFactory,
						initializeTimeoutMs: options.initializeTimeoutMs,
						abortSignal: options.abortSignal,
						timerSchedulerRef: options.timerSchedulerRef,
					});
					const rawContinuation =
						(input as { continuation: string }).continuation ?? "";
					if (rawContinuation.trim() !== "") {
						eventQueue.enqueue(event.source, {
							type: "event.v1",
							text: rawContinuation.trim(),
						});
					}
					return `ok: loaded ${daemonsRef.current.length} module(s)`;
				} catch (e) {
					return `error: ${e instanceof Error ? e.message : String(e)}`;
				}
			},
		});

		const tools: Tool[] = [
			...(options?.workspaceTools ?? []).map((toolItem) =>
				wrapWithNotification(toolItem, () => currentTarget, daemonsRef),
			),
			...buildModuleTools(daemonsRef.current).map((toolItem) =>
				wrapWithNotification(toolItem, () => currentTarget, daemonsRef),
			),
			buildRouteMessageTool(
				daemonsRef,
				() => currentTarget,
				(name) => {
					currentTarget = name;
				},
			),
			restartModulesTool,
			tool({
				name: "turn_end",
				description:
					"End the current turn immediately without sending any message to the user or any module. " +
					"Use this when the task is complete and no reply is needed — for example after a background " +
					"task, a timer event, or any event that requires action but not a user-facing response. " +
					"Do NOT use this when you have something to say; emit free-form text instead.",
				parameters: {
					type: "object",
					properties: {},
					required: [],
					additionalProperties: false,
				},
				strict: true,
				execute: async () => "ok",
			}),
			tool({
				name: "attach_image",
				description:
					"Read a local image file and attach it to the LLM input on the next event cycle. " +
					"The current run continues normally after this call; the image arrives in the next cycle. " +
					"The path must be within a sandbox-accessible directory (workspace, character, modules, skills, history, or standard OS read-only paths).",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Path to the image file",
						},
					},
					required: ["path"],
					additionalProperties: false,
				},
				strict: true,
				execute: async (input: unknown) => {
					if (
						options === undefined ||
						options.workspaceDir === undefined ||
						options.workspaceDir === ""
					) {
						return "error: workspace not configured";
					}
					const {
						workspaceDir,
						historyDir: historyDirOpt,
						characterDir,
						modulesRoot,
						skillsDir,
					} = options;
					const historyDir = historyDirOpt ?? workspaceDir;
					const { path: pathArg } = input as { path: string };
					const resolved = path.resolve(pathArg);
					const read = await runReadFileBase64(
						workspaceDir,
						historyDir,
						process.platform,
						resolved,
						characterDir,
						modulesRoot,
						skillsDir,
					);
					if (!read.ok) {
						return `error: ${read.stderr.trim() || "read failed"}`;
					}
					const data = read.content;
					const mediaType = inferImageMediaType(resolved);
					eventQueue.enqueue(event.source, {
						type: "image.send.v1",
						data,
						mediaType,
					});
					return "ok";
				},
			}),
			tool({
				name: "attach_file",
				description:
					"Read a local file and attach it to the LLM input on the next event cycle. " +
					"Suitable for PDFs and other documents. The file arrives in the next cycle. " +
					"The path must be within a sandbox-accessible directory (workspace, character, modules, skills, history, or standard OS read-only paths).",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Path to the file",
						},
					},
					required: ["path"],
					additionalProperties: false,
				},
				strict: true,
				execute: async (input: unknown) => {
					if (
						options === undefined ||
						options.workspaceDir === undefined ||
						options.workspaceDir === ""
					) {
						return "error: workspace not configured";
					}
					const {
						workspaceDir,
						historyDir: historyDirOpt,
						characterDir,
						modulesRoot,
						skillsDir,
					} = options;
					const historyDir = historyDirOpt ?? workspaceDir;
					const { path: pathArg } = input as { path: string };
					const resolved = path.resolve(pathArg);
					const read = await runReadFileBase64(
						workspaceDir,
						historyDir,
						process.platform,
						resolved,
						characterDir,
						modulesRoot,
						skillsDir,
					);
					if (!read.ok) {
						return `error: ${read.stderr.trim() || "read failed"}`;
					}
					const data = read.content;
					const mediaType = inferFileMediaType(resolved);
					const filename = path.basename(resolved);
					eventQueue.enqueue(event.source, {
						type: "file.send.v1",
						data,
						mediaType,
						filename,
					});
					return "ok";
				},
			}),
		];

		const operatorContext = options?.homeDir
			? await loadHomeAgentsFile(options.homeDir)
			: undefined;
		const characterContext = options?.characterDir
			? await loadAgentContext(options.characterDir)
			: options?.contextInstructions;
		// Operator instructions live in a fixed file the agent cannot edit, so they
		// get their own tag distinct from the editable character files — the fence
		// keeps the trust boundary explicit and unforgeable by file content.
		const contextInstructions =
			[
				operatorContext
					? `<operator-instructions>\n${operatorContext}\n</operator-instructions>`
					: undefined,
				characterContext,
			]
				.filter(Boolean)
				.join("\n\n") || undefined;
		const modules = daemonsRef.current.map((d) => ({
			name: d.manifest.name,
			replyable: d.manifest.replyable,
			tools: d.tools.map((t) => t.name),
		}));
		const skills = options?.skillsDir
			? await loadSkillsIndex(options.skillsDir)
			: undefined;
		const instructions = buildSystemPrompt({
			contextInstructions,
			workspaceDir: options?.workspaceDir,
			historyDir: options?.historyDir,
			characterDir: options?.characterDir,
			modulesRoot: options?.modulesRoot,
			modules,
			skillsDir: options?.skillsDir,
			skills,
		});
		const agent = baseAgent.clone({
			tools,
			instructions,
			toolUseBehavior: (_context, toolResults: FunctionToolResult[]) => {
				const restartResult = toolResults.find(
					(result) =>
						result.type === "function_output" &&
						result.tool.name === "restart_modules" &&
						typeof result.output === "string" &&
						result.output.startsWith("ok:"),
				);
				if (restartResult) {
					return {
						isFinalOutput: true,
						isInterrupted: undefined,
						finalOutput: "",
					};
				}
				// The SDK loop cannot terminate without text output; turn_end provides
				// an explicit escape hatch that ends the run silently via isFinalOutput.
				const turnEndResult = toolResults.find(
					(result) =>
						result.type === "function_output" &&
						result.tool.name === "turn_end" &&
						result.output === "ok",
				);
				if (turnEndResult) {
					return {
						isFinalOutput: true,
						isInterrupted: undefined,
						finalOutput: "",
					};
				}
				return { isFinalOutput: false, isInterrupted: undefined };
			},
		});
		const xml = eventToXml(event);
		const userInput: AgentInputItem =
			event.params.type === "image.send.v1"
				? ({
						role: "user",
						content: [
							{ type: "input_text", text: xml },
							{
								type: "input_image",
								image: `data:${String(event.params.mediaType)};base64,${String(event.params.data)}`,
							},
						],
					} as AgentInputItem)
				: event.params.type === "file.send.v1"
					? ({
							role: "user",
							content: [
								{ type: "input_text", text: xml },
								{
									type: "input_file",
									file: `data:${String(event.params.mediaType)};base64,${String(event.params.data)}`,
								},
							],
						} as AgentInputItem)
					: ({ role: "user", content: xml } as AgentInputItem);

		const runController = new AbortController();
		// Propagate the process-level abort into the per-run controller so that
		// either a sessions.skip.v1 request or a process shutdown aborts the run.
		options?.abortSignal?.addEventListener(
			"abort",
			() => runController.abort(),
			{ once: true },
		);
		eventQueue.setRunController(runController);
		try {
			const runInput: string | AgentInputItem[] =
				session.history.length > 0
					? [...session.history, userInput]
					: event.params.type === "event.v1"
						? xml
						: [userInput];
			const result = await runner.run(agent, runInput, {
				signal: runController.signal,
				maxTurns,
			});
			const text = result.finalOutput;
			if (text?.trim()) {
				const targetDaemon = daemonsRef.current.find(
					(d) => d.manifest.name === currentTarget,
				);
				if (targetDaemon?.manifest.replyable === true) {
					targetDaemon.peer.notify("event", {
						type: "message.send.v1",
						text,
					});
				}
			}
			session.history = result.history;
			if (sessionStore && session.currentSessionId !== null) {
				if (await shouldPersistCurrentSession(session, eventQueue)) {
					await sessionStore.save(session.currentSessionId, session.history);
				} else {
					resetSessionState(session);
				}
			}
			if (!isInterrupt) eventQueue.complete(event.id);
		} catch (error) {
			console.error(
				`[core] LLM cycle failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			notifyEventDropped(daemonsRef.current, event);
			if (!isInterrupt) eventQueue.complete(event.id);
		} finally {
			eventQueue.setRunController(null);
		}
	}
}
