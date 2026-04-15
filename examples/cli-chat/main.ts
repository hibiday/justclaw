#!/usr/bin/env bun
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const justclawHome = process.env.JUSTCLAW_HOME;
if (!justclawHome) {
	console.error("cli-chat: JUSTCLAW_HOME is not set");
	process.exit(1);
}
// Matches the module layout under the runtime: $JUSTCLAW_HOME/modules/cli-chat/
const socketPath = path.join(
	justclawHome,
	"modules",
	"cli-chat",
	"cli-chat.sock",
);

let currentClient: Bun.Socket<undefined> | null = null;
const pendingMessages: string[] = [];
let socketLineBuffer = "";
/** Replaced in open() so each accepted socket gets a fresh stream decoder. */
let socketUtf8Decoder = new TextDecoder();

const stdinUtf8Decoder = new TextDecoder();

function appendSocketLines(chunk: string): void {
	socketLineBuffer += chunk;
	let newlineIndex = socketLineBuffer.indexOf("\n");
	while (newlineIndex >= 0) {
		const rawLine = socketLineBuffer.slice(0, newlineIndex);
		socketLineBuffer = socketLineBuffer.slice(newlineIndex + 1);
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length > 0) {
			emitEvent({ kind: "message.received", text: line });
		}
		newlineIndex = socketLineBuffer.indexOf("\n");
	}
}

function writeLine(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitEvent(params: Record<string, unknown>): void {
	writeLine({
		jsonrpc: "2.0",
		method: "event",
		params: { type: "event.v1", ...params },
	});
}

function deliverToClient(text: string): void {
	if (currentClient) {
		currentClient.write(`${text}\n`);
	} else {
		pendingMessages.push(text);
	}
}

function removeSocketFile(): void {
	try {
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
	} catch {
		// ignore
	}
}

process.on("exit", removeSocketFile);
process.on("SIGTERM", () => process.exit(0));

removeSocketFile();

Bun.listen({
	unix: socketPath,
	socket: {
		open(socket) {
			if (currentClient) {
				socket.end();
				return;
			}
			currentClient = socket;
			socketUtf8Decoder = new TextDecoder();
			socketLineBuffer = "";
			const queued = pendingMessages.splice(0);
			for (const t of queued) {
				socket.write(`${t}\n`);
			}
		},
		data(_socket, data) {
			appendSocketLines(socketUtf8Decoder.decode(data, { stream: true }));
		},
		close(socket) {
			if (currentClient === socket) {
				appendSocketLines(socketUtf8Decoder.decode());
				currentClient = null;
				socketLineBuffer = "";
			}
		},
	},
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function handleStdinLine(line: string): void {
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}

	if (!isRecord(msg) || msg.jsonrpc !== "2.0") {
		return;
	}

	if (typeof msg.id === "number" && typeof msg.method === "string") {
		if (msg.method === "initialize") {
			writeLine({
				jsonrpc: "2.0",
				id: msg.id,
				result: { tools: [] },
			});
			return;
		}
		if (msg.method === "shutdown") {
			writeLine({ jsonrpc: "2.0", id: msg.id, result: "ok" });
			process.exit(0);
			return;
		}
		writeLine({
			jsonrpc: "2.0",
			id: msg.id,
			error: { code: -32601, message: "Method not found" },
		});
		return;
	}

	if (msg.method !== "event" || !isRecord(msg.params)) {
		return;
	}

	const params = msg.params;
	const pType = params.type;

	if (pType === "message.send.v1" && typeof params.text === "string") {
		deliverToClient(params.text);
		return;
	}

	if (pType === "event.dropped.v1") {
		deliverToClient(`[error] event dropped: ${JSON.stringify(params.params)}`);
	}
}

async function readStdinLoop(): Promise<void> {
	const reader = Bun.stdin.stream().getReader();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += stdinUtf8Decoder.decode(value, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const rawLine = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (line.length > 0) {
				handleStdinLine(line);
			}
			newlineIndex = buffer.indexOf("\n");
		}
	}

	buffer += stdinUtf8Decoder.decode();
	const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
	if (tail.length > 0) {
		handleStdinLine(tail);
	}
}

void readStdinLoop();
