import { consumeLines, type JsonRpcNotification, JsonRpcPeer } from "./jsonrpc";
import {
	type DaemonModuleManifest,
	discoverDaemonManifests,
	resolveModulesRoot,
} from "./module-manifest";
import { createSandboxLaunchSpec, type SandboxLaunchSpec } from "./sandbox";

type StartedDaemon = {
	manifest: DaemonModuleManifest;
	process: Bun.Subprocess<"pipe", "pipe", "pipe">;
	peer: JsonRpcPeer;
	stopping: boolean;
	tools: unknown[];
};

type BootstrapRuntimeOptions = {
	abortSignal?: AbortSignal;
	homeDir?: string;
	initializeTimeoutMs?: number;
	sandboxFactory?: (
		manifest: DaemonModuleManifest,
	) => Promise<SandboxLaunchSpec>;
	startedDaemons?: StartedDaemon[];
};

const INITIALIZE_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 1_000;
const KILL_TIMEOUT_MS = 1_000;

function createAbortError(): Error {
	return new Error("Runtime startup interrupted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
	if (!signal) {
		return new Promise(() => {});
	}

	if (signal.aborted) {
		return Promise.reject(createAbortError());
	}

	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(createAbortError()), {
			once: true,
		});
	});
}

function createTimeout(
	ms: number,
	createError: () => Error,
): {
	cancel: () => void;
	promise: Promise<never>;
} {
	let timeout: ReturnType<typeof setTimeout>;
	const promise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			reject(createError());
		}, ms);
	});

	return {
		cancel: () => {
			clearTimeout(timeout);
		},
		promise,
	};
}

async function withTimeout<T>(
	operation: Promise<T>,
	ms: number,
	createError: () => Error,
): Promise<T> {
	const timeout = createTimeout(ms, createError);
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		timeout.cancel();
	}
}

function parseInitializeResult(moduleName: string, result: unknown): unknown[] {
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		throw new Error(`${moduleName}: initialize result must be an object`);
	}

	const tools = (result as { tools?: unknown }).tools;
	if (tools === undefined) {
		return [];
	}

	if (!Array.isArray(tools)) {
		throw new Error(
			`${moduleName}: initialize result "tools" must be an array`,
		);
	}

	return tools;
}

async function pipeStdout(daemon: StartedDaemon): Promise<void> {
	try {
		await consumeLines(daemon.process.stdout, (line) => {
			daemon.peer.handleLine(line);
		});
		const error = new Error(
			`${daemon.manifest.name}: stdout closed unexpectedly`,
		);
		if (!daemon.stopping) {
			console.error(`[${daemon.manifest.name}] ${error.message}`);
		}
		daemon.peer.close(error);
	} catch (error) {
		const peerError = error instanceof Error ? error : new Error(String(error));
		if (!daemon.stopping) {
			console.error(`[${daemon.manifest.name}] ${peerError.message}`);
		}
		daemon.peer.close(peerError);
	}
}

async function pipeStderr(daemon: StartedDaemon): Promise<void> {
	try {
		await consumeLines(daemon.process.stderr, (line) => {
			console.error(`[${daemon.manifest.name}] ${line}`);
		});
	} catch (error) {
		console.error(
			`[${daemon.manifest.name}] failed to read stderr: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function createPeer(
	manifest: DaemonModuleManifest,
	process: Bun.Subprocess<"pipe", "pipe", "pipe">,
): JsonRpcPeer {
	return new JsonRpcPeer({
		name: manifest.name,
		sendLine: (line) => {
			void process.stdin.write(`${line}\n`);
		},
		onNotification: (message: JsonRpcNotification) => {
			if (message.method === "event") {
				// Placeholder until the LLM event queue exists: keep module events
				// visible without treating stderr as the protocol destination.
				console.error(
					`[${manifest.name}] event ${JSON.stringify(message.params ?? {})}`,
				);
				return;
			}

			console.error(
				`[${manifest.name}] ignoring unsupported notification ${message.method}`,
			);
		},
	});
}

export async function startDaemon(
	manifest: DaemonModuleManifest,
	options: Pick<
		BootstrapRuntimeOptions,
		"abortSignal" | "sandboxFactory" | "initializeTimeoutMs"
	> & {
		onSpawned?: (daemon: StartedDaemon) => void;
	} = {},
): Promise<StartedDaemon> {
	throwIfAborted(options.abortSignal);
	const sandboxSpec = await (options.sandboxFactory ?? createSandboxLaunchSpec)(
		manifest,
	);
	throwIfAborted(options.abortSignal);
	const process = Bun.spawn({
		cmd: sandboxSpec.cmd,
		cwd: sandboxSpec.cwd,
		env: sandboxSpec.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const peer = createPeer(manifest, process);
	const daemon: StartedDaemon = {
		manifest,
		process,
		peer,
		stopping: false,
		tools: [],
	};

	void pipeStdout(daemon);
	void pipeStderr(daemon);
	options.onSpawned?.(daemon);

	try {
		const initializeResult = await withTimeout(
			Promise.race([
				peer.request("initialize"),
				waitForAbort(options.abortSignal),
			]),
			options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
			() => new Error(`${manifest.name}: initialize timed out`),
		);
		daemon.tools = parseInitializeResult(manifest.name, initializeResult);
		return daemon;
	} catch (error) {
		await stopDaemon(daemon);
		throw error;
	}
}

export async function stopDaemon(daemon: StartedDaemon): Promise<void> {
	daemon.stopping = true;
	try {
		await withTimeout(
			daemon.peer.request("shutdown"),
			SHUTDOWN_TIMEOUT_MS,
			() => new Error(`${daemon.manifest.name}: shutdown timed out`),
		);
	} catch {
		daemon.process.kill();
	}

	try {
		await withTimeout(daemon.process.exited, SHUTDOWN_TIMEOUT_MS, () => {
			return new Error(
				`${daemon.manifest.name}: process did not exit after shutdown`,
			);
		});
	} catch {
		daemon.process.kill("SIGKILL");
		await withTimeout(daemon.process.exited, KILL_TIMEOUT_MS, () => {
			return new Error(
				`${daemon.manifest.name}: process did not exit after SIGKILL`,
			);
		}).catch(() => undefined);
	}
}

export async function bootstrapRuntime(
	options: BootstrapRuntimeOptions = {},
): Promise<{
	modulesRoot: string;
	daemons: StartedDaemon[];
}> {
	const modulesRoot = resolveModulesRoot(
		process.env.JUSTCLAW_HOME,
		options.homeDir,
	);
	const manifests = await discoverDaemonManifests(modulesRoot);
	if (manifests.length === 0) {
		throw new Error(`No modules available in ${modulesRoot}`);
	}
	const daemons = options.startedDaemons ?? [];

	try {
		for (const manifest of manifests) {
			throwIfAborted(options.abortSignal);
			await startDaemon(manifest, {
				abortSignal: options.abortSignal,
				initializeTimeoutMs: options.initializeTimeoutMs,
				sandboxFactory: options.sandboxFactory,
				onSpawned: (daemon) => {
					daemons.push(daemon);
				},
			});
		}
	} catch (error) {
		await stopDaemons(daemons);
		daemons.length = 0;
		throw error;
	}

	return { modulesRoot, daemons };
}

export async function stopDaemons(daemons: StartedDaemon[]): Promise<void> {
	await Promise.allSettled(
		daemons.map(async (daemon) => {
			await stopDaemon(daemon);
		}),
	);
}

export type { StartedDaemon };
