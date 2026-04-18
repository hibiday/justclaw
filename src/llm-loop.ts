import {
	Agent,
	type AgentInputItem,
	Runner,
	setDefaultOpenAIClient,
	setOpenAIAPI,
	setTracingDisabled,
	type Tool,
	tool,
} from "@openai/agents";
import OpenAI from "openai";
import { notifyEventDropped } from "./event-dropped";
import {
	ACTIVE_SESSION_META_KEY,
	type EventQueue,
	type QueuedEvent,
	timestampFromUUIDv7,
} from "./event-queue";
import type { StartedDaemon } from "./runtime";
import type { SessionStore } from "./session-store";

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

function wrapWithNotification(
	t: Tool,
	getTarget: () => string,
	daemons: StartedDaemon[],
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
			const daemon = daemons.find((d) => d.manifest.name === getTarget());
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
	daemons: StartedDaemon[],
	onSend: (moduleName: string) => void,
): Tool {
	return tool({
		name: "send_message",
		description:
			"Send a message to a module. Use this to reply to the user or deliver a message to a specific module.",
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
			const daemon = daemons.find((d) => d.manifest.name === moduleName);
			if (!daemon) {
				return `error: module "${moduleName}" not found`;
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
	workspaceInstructions?: string;
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
	daemons: StartedDaemon[],
	model: string,
	options?: LlmLoopOptions,
): Promise<void> {
	const runner = options?.runner ?? new Runner({ tracingDisabled: true });
	const sessionStore = options?.sessionStore;
	const instructions = [
		options?.workspaceInstructions,
		"You are a helpful assistant.",
	]
		.filter(Boolean)
		.join("\n");
	const baseAgent = new Agent({
		name: "justclaw",
		model,
		instructions,
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
				notifyEventDropped(daemons, event);
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
				notifyEventDropped(daemons, event);
			}
			eventQueue.complete(event.id);
			continue;
		}

		// QueuedEvent.params is untyped; only event.v1 may reach the LLM.
		if (event.params.type !== "event.v1") {
			console.warn(
				`[core] unsupported internal event type for ${event.source} (id=${event.id}): ${String(event.params.type)} (expected event.v1); dropping`,
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
				notifyEventDropped(daemons, event);
				eventQueue.complete(event.id);
				continue;
			}
		}
		if (sessionStore && session.currentSessionId === null) {
			console.error(
				`[core] no active session for event from ${event.source} (id=${event.id}); add a session history file or call sessions.switch.v1 — dropping`,
			);
			notifyEventDropped(daemons, event);
			eventQueue.complete(event.id);
			continue;
		}

		let currentTarget = event.source;

		const tools: Tool[] = [
			...(options?.workspaceTools ?? []).map((toolItem) =>
				wrapWithNotification(toolItem, () => currentTarget, daemons),
			),
			...buildModuleTools(daemons).map((toolItem) =>
				wrapWithNotification(toolItem, () => currentTarget, daemons),
			),
			buildSendMessageTool(daemons, (name) => {
				currentTarget = name;
			}),
		];

		const agent = baseAgent.clone({ tools });
		const xml = eventToXml(event);

		try {
			const result = await runner.run(
				agent,
				session.history.length > 0
					? [
							...session.history,
							{ role: "user", content: xml } as AgentInputItem,
						]
					: xml,
			);
			const text = result.finalOutput;
			if (text?.trim()) {
				const targetDaemon = daemons.find(
					(d) => d.manifest.name === currentTarget,
				);
				targetDaemon?.peer.notify("event", { type: "message.send.v1", text });
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
			notifyEventDropped(daemons, event);
			eventQueue.complete(event.id);
		}
	}
}
