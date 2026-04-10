export type JsonRpcId = number;

export type JsonRpcRequest = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
};

export type JsonRpcSuccessResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
};

export type JsonRpcErrorResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
};

export type JsonRpcNotification = {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

type JsonRpcPeerOptions = {
	name: string;
	sendLine: (line: string) => void;
	onNotification?: (message: JsonRpcNotification) => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatRemoteError(error: JsonRpcErrorResponse["error"]): string {
	return `${error.code}: ${error.message}`;
}

export class JsonRpcPeer {
	#name: string;
	#sendLine: (line: string) => void;
	#onNotification?: (message: JsonRpcNotification) => void;
	#nextId = 1;
	#pending = new Map<JsonRpcId, PendingRequest>();
	#closedError: Error | null = null;

	constructor(options: JsonRpcPeerOptions) {
		this.#name = options.name;
		this.#sendLine = options.sendLine;
		this.#onNotification = options.onNotification;
	}

	request(method: string, params?: unknown): Promise<unknown> {
		if (this.#closedError) {
			return Promise.reject(this.#closedError);
		}

		const id = this.#nextId++;
		const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };

		if (params !== undefined) {
			request.params = params;
		}

		const promise = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});

		try {
			this.#sendLine(JSON.stringify(request));
		} catch (error) {
			this.#pending.delete(id);
			const sendError =
				error instanceof Error
					? error
					: new Error(`${this.#name}: failed to send request`);
			return Promise.reject(sendError);
		}

		return promise;
	}

	handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			throw new Error(`${this.#name}: received invalid JSON-RPC line`);
		}

		if (!isObject(message) || message.jsonrpc !== "2.0") {
			throw new Error(`${this.#name}: received invalid JSON-RPC message`);
		}

		if ("method" in message) {
			this.#handleNotification(message);
			return;
		}

		this.#handleResponse(message);
	}

	close(error: Error): void {
		if (this.#closedError) {
			return;
		}

		this.#closedError = error;
		for (const [id, pending] of this.#pending) {
			pending.reject(error);
			this.#pending.delete(id);
		}
	}

	#handleNotification(message: Record<string, unknown>): void {
		if ("id" in message) {
			throw new Error(`${this.#name}: request handling is not supported`);
		}

		if (typeof message.method !== "string") {
			throw new Error(`${this.#name}: notification method must be a string`);
		}

		this.#onNotification?.({
			jsonrpc: "2.0",
			method: message.method,
			params: message.params,
		});
	}

	#handleResponse(message: Record<string, unknown>): void {
		if (typeof message.id !== "number") {
			throw new Error(`${this.#name}: response id must be a number`);
		}

		const pending = this.#pending.get(message.id);
		if (!pending) {
			throw new Error(
				`${this.#name}: received response for unknown request id ${message.id}`,
			);
		}

		this.#pending.delete(message.id);

		if ("error" in message) {
			const remoteError = message.error;
			if (
				!isObject(remoteError) ||
				typeof remoteError.code !== "number" ||
				typeof remoteError.message !== "string"
			) {
				pending.reject(
					new Error(
						`${this.#name}: received malformed JSON-RPC error response`,
					),
				);
				return;
			}

			pending.reject(
				new Error(
					`${this.#name}: ${formatRemoteError({
						code: remoteError.code,
						message: remoteError.message,
						data: remoteError.data,
					})}`,
				),
			);
			return;
		}

		if (!("result" in message)) {
			pending.reject(new Error(`${this.#name}: response missing result`));
			return;
		}

		pending.resolve(message.result);
	}
}

export async function consumeLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });

		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const rawLine = buffer.slice(0, newlineIndex);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length > 0) {
				onLine(line);
			}
			newlineIndex = buffer.indexOf("\n");
		}
	}

	buffer += decoder.decode();
	const finalLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
	if (finalLine.length > 0) {
		onLine(finalLine);
	}
}
