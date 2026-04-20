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
import { loadAgentContext } from "./agent-context";
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
	reloadDaemons,
	type StartedDaemon,
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
	const { type: _type, ...rest } = event.params;
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

function buildSendMessageTool(
	daemonsRef: { current: StartedDaemon[] },
	onSend: (moduleName: string) => void,
): Tool {
	return tool({
		name: "send_message",
		description:
			"Send a message to a replyable module. Use this to reply to the user or deliver a message to a specific module.",
		parameters: {
			type: "object",
			properties: {
				module: { type: "string", description: "Target module name" },
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
	operatorContext?: string;
	modulesRoot?: string;
	sandboxFactory?: BootstrapRuntimeOptions["sandboxFactory"];
	initializeTimeoutMs?: BootstrapRuntimeOptions["initializeTimeoutMs"];
	abortSignal?: BootstrapRuntimeOptions["abortSignal"];
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
		const event = await eventQueue.next();
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
				await adoptSessionFromMetadata(session, eventQueue, sessionStore);
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
				"Reload daemon modules from the modules directory (reflects adds/removes and manifest changes). Discovery runs first; on failure existing processes stay up and the tool returns an error. On success, processes update immediately and the current LLM run ends after this tool call; pass non-empty continuation to enqueue a follow-up event.v1 (source fixed to current event source) so the next event runs with the reloaded module set. Pass an empty string when no follow-up is needed.",
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
					await reloadDaemons(daemonsRef, options.modulesRoot, eventQueue, {
						sessionStore,
						sandboxFactory: options.sandboxFactory,
						initializeTimeoutMs: options.initializeTimeoutMs,
						abortSignal: options.abortSignal,
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
			buildSendMessageTool(daemonsRef, (name) => {
				currentTarget = name;
			}),
			restartModulesTool,
			tool({
				name: "send_image",
				description:
					"Read a local image file and deliver it to the LLM as image input on the next event. " +
					"The current run continues normally after this call; the image arrives in the next cycle.",
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
				name: "send_file",
				description:
					"Read a local file and deliver it as file content to the LLM on the next event. " +
					"Suitable for PDFs and other documents. The file arrives in the next cycle.",
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

		const characterContext = options?.characterDir
			? await loadAgentContext(options.characterDir)
			: options?.contextInstructions;
		const contextInstructions =
			[options?.operatorContext, characterContext]
				.filter(Boolean)
				.join("\n\n") || undefined;
		const modules = daemonsRef.current.map((d) => ({
			name: d.manifest.name,
			replyable: d.manifest.replyable,
			tools: d.tools.map((t) => t.name),
		}));
		const instructions = buildSystemPrompt({
			contextInstructions,
			workspaceDir: options?.workspaceDir,
			historyDir: options?.historyDir,
			characterDir: options?.characterDir,
			modulesRoot: options?.modulesRoot,
			modules,
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

		try {
			const runInput: string | AgentInputItem[] =
				session.history.length > 0
					? [...session.history, userInput]
					: event.params.type === "event.v1"
						? xml
						: [userInput];
			const result = await runner.run(agent, runInput);
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
			eventQueue.complete(event.id);
		} catch (error) {
			console.error(
				`[core] LLM cycle failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			notifyEventDropped(daemonsRef.current, event);
			eventQueue.complete(event.id);
		}
	}
}
