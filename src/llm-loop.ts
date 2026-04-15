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
	type EventQueue,
	type QueuedEvent,
	timestampFromUUIDv7,
} from "./event-queue";
import type { StartedDaemon } from "./runtime";

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
};

export async function runLlmLoop(
	eventQueue: EventQueue,
	daemons: StartedDaemon[],
	model: string,
	options?: LlmLoopOptions,
): Promise<void> {
	const runner = options?.runner ?? new Runner({ tracingDisabled: true });
	const baseAgent = new Agent({
		name: "justclaw",
		model,
		instructions: "You are a helpful assistant.",
		tools: [],
	});

	let history: AgentInputItem[] = [];

	while (true) {
		const event = await eventQueue.next();
		if (!event) {
			break;
		}

		let currentTarget = event.source;

		const tools: Tool[] = [
			...buildModuleTools(daemons),
			buildSendMessageTool(daemons, (name) => {
				currentTarget = name;
			}),
		];

		const agent = baseAgent.clone({ tools });
		const xml = eventToXml(event);

		try {
			const result = await runner.run(
				agent,
				history.length > 0
					? [...history, { role: "user", content: xml } as AgentInputItem]
					: xml,
			);
			const text = result.finalOutput;
			if (text?.trim()) {
				const targetDaemon = daemons.find(
					(d) => d.manifest.name === currentTarget,
				);
				targetDaemon?.peer.notify("event", { type: "message.send.v1", text });
			}
			history = result.history;
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
