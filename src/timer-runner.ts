import type { EventQueue } from "./event-queue";
import { consumeLines, type JsonRpcNotification, JsonRpcPeer } from "./jsonrpc";
import type { TimerModuleManifest } from "./module-manifest";
import {
	createSessionRequestHandler,
	parseEventNotificationParams,
} from "./module-peer";
import { createSandboxLaunchSpec, type SandboxLaunchSpec } from "./sandbox";
import type { SessionStore } from "./session-store";

const INITIALIZE_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 1_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Schedules timer firings in-process with {@link Bun.cron.parse} (UTC) and
 * `setTimeout`, matching docs/spec.md.
 *
 * OS-level `Bun.cron(path, schedule, title)` runs a file on a schedule and
 * cannot hold references to this process's event queue, session store, or
 * sandbox launch spec. Timer modules must enqueue into the same runtime as
 * daemons, so the core owns the schedule and spawns the module subprocess on
 * each tick.
 */
function registerInProcessCron(
	cronExpression: string,
	onFire: () => void,
): { stop(): void } {
	let stopped = false;
	let handle: ReturnType<typeof setTimeout> | undefined;

	function scheduleFrom(anchorMs: number): void {
		if (stopped) {
			return;
		}
		const next = Bun.cron.parse(cronExpression, anchorMs);
		if (next === null) {
			console.error(
				`[timer] cron "${cronExpression}" has no upcoming match; stopping schedule`,
			);
			return;
		}
		const delay = Math.max(0, next.getTime() - Date.now());
		handle = setTimeout(() => {
			if (stopped) {
				return;
			}
			onFire();
			scheduleFrom(next.getTime());
		}, delay);
	}

	scheduleFrom(Date.now());

	return {
		stop() {
			stopped = true;
			if (handle !== undefined) {
				clearTimeout(handle);
			}
		},
	};
}

async function killProcess(proc: Bun.Subprocess): Promise<void> {
	if (proc.exitCode !== null) {
		await proc.exited;
		return;
	}
	proc.kill("SIGTERM");
	await Promise.race([proc.exited, sleep(KILL_TIMEOUT_MS)]);
	if (proc.exitCode === null) {
		proc.kill("SIGKILL");
	}
	await proc.exited;
}

function createTimerModulePeer(
	manifest: TimerModuleManifest,
	process: Bun.Subprocess<"pipe", "pipe", "pipe">,
	queue: EventQueue,
	sessionStore: SessionStore,
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
				queue.enqueue(manifest.name, params);
				return;
			}

			console.error(
				`[${manifest.name}] ignoring unsupported notification ${message.method}`,
			);
		},
		onRequest: createSessionRequestHandler(manifest.name, queue, sessionStore),
	});
}

export async function fireTimer(
	manifest: TimerModuleManifest,
	state: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null },
	queue: EventQueue,
	sessionStore: SessionStore,
	options: {
		sandboxFactory?: (
			manifest: TimerModuleManifest,
		) => Promise<SandboxLaunchSpec>;
		initializeTimeoutMs?: number;
	},
): Promise<void> {
	if (state.process !== null) {
		await killProcess(state.process);
	}

	let sandboxSpec: SandboxLaunchSpec;
	try {
		sandboxSpec = await (options.sandboxFactory ?? createSandboxLaunchSpec)(
			manifest,
		);
	} catch (error) {
		console.error(
			`[${manifest.name}] failed to create sandbox: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	try {
		proc = Bun.spawn({
			cmd: sandboxSpec.cmd,
			cwd: sandboxSpec.cwd,
			env: sandboxSpec.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		console.error(
			`[${manifest.name}] failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	state.process = proc;
	const peer = createTimerModulePeer(manifest, proc, queue, sessionStore);
	const stdoutTask = consumeLines(proc.stdout, (line) => peer.handleLine(line));
	void consumeLines(proc.stderr, (line) => {
		console.error(`[${manifest.name}] ${line}`);
	});

	const initTimeoutMs = options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const initTimeout = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(new Error(`${manifest.name}: initialize timed out`));
		}, initTimeoutMs);
	});

	try {
		await Promise.race([peer.request("initialize"), initTimeout]);
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
		await proc.exited;
	} catch (error) {
		console.error(
			`[${manifest.name}] ${error instanceof Error ? error.message : String(error)}`,
		);
		if (proc.exitCode === null) {
			proc.kill("SIGKILL");
		}
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
		await stdoutTask.catch(() => {});
		peer.close(new Error(`${manifest.name}: timer module process ended`));
		if (state.process === proc) {
			state.process = null;
		}
	}
}

export type TimerScheduler = { stop(): Promise<void> };

export function startTimerSchedulers(
	manifests: TimerModuleManifest[],
	queue: EventQueue,
	sessionStore: SessionStore,
	options: {
		sandboxFactory?: (
			manifest: TimerModuleManifest,
		) => Promise<SandboxLaunchSpec>;
		initializeTimeoutMs?: number;
	} = {},
): TimerScheduler {
	if (manifests.length === 0) {
		return { async stop() {} };
	}

	const states: { process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null }[] =
		[];
	const cronJobs: { stop(): void }[] = [];

	for (const manifest of manifests) {
		const state: {
			process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null;
		} = { process: null };
		states.push(state);
		cronJobs.push(
			registerInProcessCron(manifest.cron, () => {
				void fireTimer(manifest, state, queue, sessionStore, options);
			}),
		);
	}

	return {
		async stop() {
			for (const job of cronJobs) {
				job.stop();
			}
			await Promise.all(
				states.map((state) => {
					const proc = state.process;
					return proc !== null ? killProcess(proc) : Promise.resolve();
				}),
			);
		},
	};
}
