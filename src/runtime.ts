import { consumeLines, type JsonRpcNotification, JsonRpcPeer } from "./jsonrpc";
import {
	type DaemonModuleManifest,
	discoverDaemonManifests,
	resolveModulesRoot,
} from "./module-manifest";
import { createSandboxLaunchSpec, type SandboxLaunchSpec } from "./sandbox";

type DaemonState = "starting" | "running" | "stopping" | "stopped" | "failed";

type StartedDaemon = {
	manifest: DaemonModuleManifest;
	process: Bun.Subprocess<"pipe", "pipe", "pipe">;
	peer: JsonRpcPeer;
	state: DaemonState;
	restartAttempts: number;
	// stdout can fail immediately after initialize resolves but before the
	// caller observes the daemon as running. Preserve that fatal signal so
	// supervision handles it without changing the initialize startup boundary.
	fatalError?: Error;
	// Shutdown must wait for a restart that already spawned a replacement;
	// otherwise stopDaemons() can return before that replacement is stopped.
	restartTask?: Promise<void>;
	restartAbortController?: AbortController;
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

type DaemonFailureHandler = (daemon: StartedDaemon, error: Error) => void;

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
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

function parseEventNotificationParams(
	moduleName: string,
	params: unknown,
): Record<string, unknown> & { type: "event.v1" } {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new Error(`${moduleName}: event params must be an object`);
	}

	const { type } = params as { type?: unknown };

	if (type !== "event.v1") {
		throw new Error(`${moduleName}: event type must be "event.v1"`);
	}

	return params as Record<string, unknown> & { type: "event.v1" };
}

async function terminateDaemonProcess(daemon: StartedDaemon): Promise<void> {
	if (daemon.process.exitCode === null) {
		signalDaemonProcessGroup(daemon, "SIGTERM");
		try {
			await withTimeout(daemon.process.exited, SHUTDOWN_TIMEOUT_MS, () => {
				return new Error(
					`${daemon.manifest.name}: process did not exit after SIGTERM`,
				);
			});
		} catch {
			signalDaemonProcessGroup(daemon, "SIGKILL");
			await withTimeout(daemon.process.exited, KILL_TIMEOUT_MS, () => {
				return new Error(
					`${daemon.manifest.name}: process did not exit after SIGKILL`,
				);
			});
		}
	}

	await terminateDaemonProcessGroup(daemon);
}

async function cleanupFailedStartupDaemon(
	daemon: StartedDaemon,
	error: Error,
): Promise<void> {
	daemon.state = "failed";
	try {
		await withTimeout(
			daemon.peer.request("shutdown"),
			SHUTDOWN_TIMEOUT_MS,
			() => new Error(`${daemon.manifest.name}: shutdown timed out`),
		);
		await withTimeout(daemon.process.exited, SHUTDOWN_TIMEOUT_MS, () => {
			return new Error(
				`${daemon.manifest.name}: process did not exit after shutdown`,
			);
		});
		await terminateDaemonProcessGroup(daemon);
		return;
	} catch {
		// Startup still failed, but a daemon that reached the protocol should get
		// the same cleanup opportunity as normal shutdown before signals.
	}

	daemon.peer.close(error);
	await terminateDaemonProcess(daemon).catch(() => undefined);
}

function signalDaemonProcessGroup(
	daemon: StartedDaemon,
	signal: NodeJS.Signals,
): void {
	try {
		process.kill(-daemon.process.pid, signal);
	} catch {
		daemon.process.kill(signal);
	}
}

async function terminateDaemonProcessGroup(
	daemon: StartedDaemon,
): Promise<void> {
	if (!daemonProcessGroupExists(daemon)) {
		return;
	}

	signalDaemonProcessGroup(daemon, "SIGTERM");
	try {
		await withTimeout(
			waitForDaemonProcessGroupExit(daemon),
			SHUTDOWN_TIMEOUT_MS,
			() => {
				return new Error(
					`${daemon.manifest.name}: process group did not exit after SIGTERM`,
				);
			},
		);
		return;
	} catch {}

	signalDaemonProcessGroup(daemon, "SIGKILL");
	await withTimeout(
		waitForDaemonProcessGroupExit(daemon),
		KILL_TIMEOUT_MS,
		() => {
			return new Error(
				`${daemon.manifest.name}: process group did not exit after SIGKILL`,
			);
		},
	);
}

async function waitForDaemonProcessGroupExit(
	daemon: StartedDaemon,
): Promise<void> {
	while (daemonProcessGroupExists(daemon)) {
		await sleep(10);
	}
}

function daemonProcessGroupExists(daemon: StartedDaemon): boolean {
	try {
		process.kill(-daemon.process.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function pipeStdout(
	daemon: StartedDaemon,
	onFailure: DaemonFailureHandler,
): Promise<void> {
	try {
		await consumeLines(daemon.process.stdout, (line) => {
			daemon.peer.handleLine(line);
		});
		const error = new Error(
			`${daemon.manifest.name}: stdout closed unexpectedly`,
		);
		if (daemon.state === "running") {
			console.error(`[${daemon.manifest.name}] ${error.message}`);
		}
		daemon.fatalError = error;
		daemon.peer.close(error);
		onFailure(daemon, error);
	} catch (error) {
		const peerError = error instanceof Error ? error : new Error(String(error));
		if (daemon.state === "running") {
			console.error(`[${daemon.manifest.name}] ${peerError.message}`);
		}
		daemon.fatalError = peerError;
		daemon.peer.close(peerError);
		onFailure(daemon, peerError);
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
				const params = parseEventNotificationParams(
					manifest.name,
					message.params,
				);
				// Placeholder until the LLM event queue exists: keep module events
				// visible without treating stderr as the protocol destination.
				console.error(`[${manifest.name}] event ${JSON.stringify(params)}`);
				return;
			}

			console.error(
				`[${manifest.name}] ignoring unsupported notification ${message.method}`,
			);
		},
	});
}

function terminateDaemonAfterDirectFailure(
	daemon: StartedDaemon,
	error: Error,
): void {
	if (daemon.state !== "running") {
		return;
	}

	daemon.state = "failed";
	daemon.peer.close(error);
	void terminateDaemonProcess(daemon).catch((terminationError) => {
		console.error(
			`[${daemon.manifest.name}] failed to terminate after failure: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
		);
	});
}

export async function startDaemon(
	manifest: DaemonModuleManifest,
	options: Pick<
		BootstrapRuntimeOptions,
		"abortSignal" | "sandboxFactory" | "initializeTimeoutMs"
	> & {
		onSpawned?: (daemon: StartedDaemon) => void;
		onFailure?: DaemonFailureHandler;
		restartAttempts?: number;
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
		detached: true,
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
		state: "starting",
		restartAttempts: options.restartAttempts ?? 0,
		tools: [],
	};

	void pipeStdout(
		daemon,
		options.onFailure ?? terminateDaemonAfterDirectFailure,
	);
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
		daemon.state = "running";
		if (daemon.fatalError) {
			const fatalError = daemon.fatalError;
			daemon.fatalError = undefined;
			(options.onFailure ?? terminateDaemonAfterDirectFailure)(
				daemon,
				fatalError,
			);
		}
		return daemon;
	} catch (error) {
		await cleanupFailedStartupDaemon(
			daemon,
			error instanceof Error ? error : new Error(String(error)),
		);
		throw error;
	}
}

export async function stopDaemon(daemon: StartedDaemon): Promise<void> {
	if (daemon.state === "stopped") {
		return;
	}

	if (daemon.state === "failed") {
		daemon.state = "stopping";
		daemon.restartAbortController?.abort();
		await terminateDaemonProcess(daemon).catch(() => undefined);
		await daemon.restartTask;
		daemon.state = "stopped";
		return;
	}

	daemon.state = "stopping";
	try {
		await withTimeout(
			daemon.peer.request("shutdown"),
			SHUTDOWN_TIMEOUT_MS,
			() => new Error(`${daemon.manifest.name}: shutdown timed out`),
		);
		await withTimeout(daemon.process.exited, SHUTDOWN_TIMEOUT_MS, () => {
			return new Error(
				`${daemon.manifest.name}: process did not exit after shutdown`,
			);
		});
		await terminateDaemonProcessGroup(daemon);
		daemon.state = "stopped";
		return;
	} catch {
		// Continue to process termination below. Once graceful shutdown fails,
		// the transport may already be closed, unable to return a response, or
		// unable to make the daemon exit after acknowledging shutdown.
	}

	await terminateDaemonProcess(daemon).catch(() => undefined);
	daemon.state = "stopped";
}

function superviseDaemon(
	daemon: StartedDaemon,
	options: Pick<
		BootstrapRuntimeOptions,
		"abortSignal" | "sandboxFactory" | "initializeTimeoutMs"
	>,
	daemons: StartedDaemon[],
): void {
	void daemon.process.exited.then(() => {
		handleDaemonFailure(
			daemon,
			new Error(`${daemon.manifest.name}: process exited unexpectedly`),
			options,
			daemons,
		);
	});
}

function handleDaemonFailure(
	daemon: StartedDaemon,
	error: Error,
	options: Pick<
		BootstrapRuntimeOptions,
		"abortSignal" | "sandboxFactory" | "initializeTimeoutMs"
	>,
	daemons: StartedDaemon[],
): void {
	if (daemon.state !== "running") {
		return;
	}

	daemon.state = "failed";
	daemon.peer.close(error);

	const restartAbortController = new AbortController();
	daemon.restartAbortController = restartAbortController;
	const restartTask = restartFailedDaemon(
		daemon,
		error,
		options,
		daemons,
		restartAbortController.signal,
	);
	daemon.restartTask = restartTask;
	void restartTask.finally(() => {
		if (daemon.restartTask === restartTask) {
			daemon.restartTask = undefined;
		}
		if (daemon.restartAbortController === restartAbortController) {
			daemon.restartAbortController = undefined;
		}
	});
}

async function restartFailedDaemon(
	daemon: StartedDaemon,
	error: Error,
	options: Pick<
		BootstrapRuntimeOptions,
		"abortSignal" | "sandboxFactory" | "initializeTimeoutMs"
	>,
	daemons: StartedDaemon[],
	restartSignal: AbortSignal,
): Promise<void> {
	try {
		await terminateDaemonProcess(daemon);
	} catch (terminationError) {
		console.error(
			`[${daemon.manifest.name}] failed to terminate after failure: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
		);
		return;
	}

	if (daemon.state !== "failed") {
		return;
	}

	const daemonIndex = daemons.indexOf(daemon);
	if (daemonIndex < 0) {
		return;
	}

	if (daemon.restartAttempts >= 1) {
		// One automatic restart recovers transient process failure without
		// introducing restart-loop policy before config exists.
		console.error(
			`[${daemon.manifest.name}] daemon failed after restart: ${error.message}`,
		);
		return;
	}

	if (
		restartSignal.aborted ||
		options.abortSignal?.aborted ||
		daemon.state !== "failed"
	) {
		return;
	}

	const abortController = new AbortController();
	const abortRestart = () => {
		abortController.abort();
	};
	restartSignal.addEventListener("abort", abortRestart, { once: true });
	options.abortSignal?.addEventListener("abort", abortRestart, { once: true });
	if (restartSignal.aborted || options.abortSignal?.aborted) {
		abortRestart();
	}

	try {
		const replacement = await startDaemon(daemon.manifest, {
			abortSignal: abortController.signal,
			initializeTimeoutMs: options.initializeTimeoutMs,
			restartAttempts: daemon.restartAttempts + 1,
			sandboxFactory: options.sandboxFactory,
			onFailure: (failedDaemon, failureError) => {
				handleDaemonFailure(failedDaemon, failureError, options, daemons);
			},
		});
		if (daemon.state !== "failed" || daemons[daemonIndex] !== daemon) {
			await stopDaemon(replacement);
			return;
		}
		daemons[daemonIndex] = replacement;
		superviseDaemon(replacement, options, daemons);
		console.error(`[${daemon.manifest.name}] restarted after failure`);
	} catch (restartError) {
		if (restartSignal.aborted) {
			return;
		}
		console.error(
			`[${daemon.manifest.name}] restart failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`,
		);
	} finally {
		restartSignal.removeEventListener("abort", abortRestart);
		options.abortSignal?.removeEventListener("abort", abortRestart);
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
				onFailure: (daemon, error) => {
					handleDaemonFailure(daemon, error, options, daemons);
				},
				onSpawned: (daemon) => {
					daemons.push(daemon);
				},
			}).then((daemon) => {
				superviseDaemon(daemon, options, daemons);
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

export type { DaemonState, StartedDaemon };
