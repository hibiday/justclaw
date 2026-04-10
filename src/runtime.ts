import { setTimeout as delay } from "node:timers/promises";
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
	tools: unknown[];
};

type BootstrapRuntimeOptions = {
	homeDir?: string;
	sandboxFactory?: (
		manifest: DaemonModuleManifest,
	) => Promise<SandboxLaunchSpec>;
};

const SHUTDOWN_TIMEOUT_MS = 1_000;

function parseInitializeResult(moduleName: string, result: unknown): unknown[] {
	if (typeof result !== "object" || result === null) {
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
		const exitCode = await daemon.process.exited;
		daemon.peer.close(
			new Error(
				`${daemon.manifest.name}: process exited with code ${exitCode}`,
			),
		);
	} catch (error) {
		daemon.peer.close(
			error instanceof Error ? error : new Error(String(error)),
		);
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
			if (message.method !== "event") {
				console.error(
					`[${manifest.name}] ignoring unsupported notification ${message.method}`,
				);
			}
		},
	});
}

export async function startDaemon(
	manifest: DaemonModuleManifest,
	options: Pick<BootstrapRuntimeOptions, "sandboxFactory"> = {},
): Promise<StartedDaemon> {
	const sandboxSpec = await (options.sandboxFactory ?? createSandboxLaunchSpec)(
		manifest,
	);
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
		tools: [],
	};

	void pipeStdout(daemon);
	void pipeStderr(daemon);

	const initializeResult = await peer.request("initialize");
	daemon.tools = parseInitializeResult(manifest.name, initializeResult);
	return daemon;
}

export async function stopDaemon(daemon: StartedDaemon): Promise<void> {
	try {
		await Promise.race([
			daemon.peer.request("shutdown"),
			delay(SHUTDOWN_TIMEOUT_MS).then(() => {
				throw new Error(`${daemon.manifest.name}: shutdown timed out`);
			}),
		]);
	} catch {
		daemon.process.kill();
	}

	try {
		await Promise.race([
			daemon.process.exited,
			delay(SHUTDOWN_TIMEOUT_MS).then(() => {
				throw new Error(
					`${daemon.manifest.name}: process did not exit after shutdown`,
				);
			}),
		]);
	} catch {
		daemon.process.kill();
		await daemon.process.exited.catch(() => undefined);
	}
}

export async function bootstrapRuntime(
	options: BootstrapRuntimeOptions = {},
): Promise<{
	modulesRoot: string;
	daemons: StartedDaemon[];
}> {
	const modulesRoot = resolveModulesRoot(options.homeDir);
	const manifests = await discoverDaemonManifests(modulesRoot);
	const daemons: StartedDaemon[] = [];

	try {
		for (const manifest of manifests) {
			daemons.push(
				await startDaemon(manifest, {
					sandboxFactory: options.sandboxFactory,
				}),
			);
		}
	} catch (error) {
		await stopDaemons(daemons);
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
