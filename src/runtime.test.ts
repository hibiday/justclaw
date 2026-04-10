import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonRpcPeer } from "./jsonrpc";
import { parseDaemonManifest, resolveModulesRoot } from "./module-manifest";
import { bootstrapRuntime, stopDaemons } from "./runtime";
import {
	createDarwinSandboxProfile,
	createLinuxBubblewrapCommand,
	createSandboxLaunchSpec,
	resolveSandboxBackend,
	type SandboxLaunchSpec,
} from "./sandbox";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createModuleScript({
	initializeResponse = '{"tools":[]}',
	shutdownResponse = '"ok"',
	stderrLine,
	malformedStdout = false,
	exitImmediately = false,
	ignoreShutdown = false,
	shutdownSideEffectPath,
}: {
	initializeResponse?: string;
	shutdownResponse?: string;
	stderrLine?: string;
	malformedStdout?: boolean;
	exitImmediately?: boolean;
	ignoreShutdown?: boolean;
	shutdownSideEffectPath?: string;
} = {}): string {
	return `#!/usr/bin/env bun
${stderrLine ? `console.error(${JSON.stringify(stderrLine)});\n` : ""}${exitImmediately ? "process.exit(0);\n" : ""}const lines = [];
for await (const chunk of Bun.stdin.stream()) {
	lines.push(chunk);
	const text = Buffer.concat(lines).toString("utf8");
	const inputLines = text.split(/\\r?\\n/);
	while (inputLines.length > 1) {
		const line = inputLines.shift();
		if (!line) continue;
		${malformedStdout ? 'console.log("{oops"); continue;' : ""}
		const message = JSON.parse(line);
		if (message.method === "initialize") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${initializeResponse} }));
		} else if (message.method === "shutdown") {
			${
				shutdownSideEffectPath
					? `await Bun.write(${JSON.stringify(shutdownSideEffectPath)}, "shutdown\\n");`
					: ""
			}
			${ignoreShutdown ? "continue;" : ""}
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${shutdownResponse} }));
			process.exit(0);
		}
	}
	lines.length = 0;
	if (inputLines[0]) {
		lines.push(Buffer.from(inputLines[0]));
	}
}`;
}

async function writeDaemonModule(
	homeDir: string,
	moduleName: string,
	script: string,
): Promise<void> {
	await writeRawDaemonModule(
		homeDir,
		moduleName,
		JSON.stringify({
			name: moduleName,
			exec: "./module.ts",
			mode: "daemon",
		}),
		script,
	);
}

async function writeRawDaemonModule(
	homeDir: string,
	moduleName: string,
	manifestText: string,
	script: string,
): Promise<void> {
	const moduleDir = path.join(resolveModulesRoot(homeDir), moduleName);
	await mkdir(moduleDir, { recursive: true });
	await writeFile(path.join(moduleDir, "module.json"), manifestText);
	const scriptPath = path.join(moduleDir, "module.ts");
	await writeFile(scriptPath, script);
	await chmod(scriptPath, 0o755);
}

function createUnsandboxedSpec(
	moduleDir: string,
	execPath: string,
): SandboxLaunchSpec {
	return {
		backend: "sandbox-exec",
		cmd: [execPath],
		cwd: moduleDir,
		env: process.env,
	};
}

describe("parseDaemonManifest", () => {
	test("accepts a valid daemon manifest", () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		expect(manifest.name).toBe("example");
		expect(manifest.execPath).toBe(path.resolve("/tmp/example", "./run"));
	});

	test("rejects timer mode", () => {
		expect(() =>
			parseDaemonManifest(
				"/tmp/example",
				"example",
				JSON.stringify({ name: "example", exec: "./run", mode: "timer" }),
			),
		).toThrow("Timer modules are not implemented yet");
	});

	test("rejects directory/name mismatch", () => {
		expect(() =>
			parseDaemonManifest(
				"/tmp/example",
				"example",
				JSON.stringify({ name: "other", exec: "./run", mode: "daemon" }),
			),
		).toThrow('name must match directory "example"');
	});

	test("rejects missing exec", () => {
		expect(() =>
			parseDaemonManifest(
				"/tmp/example",
				"example",
				JSON.stringify({ name: "example", mode: "daemon" }),
			),
		).toThrow('must contain a non-empty string "exec"');
	});

	test("rejects empty name", () => {
		expect(() =>
			parseDaemonManifest(
				"/tmp/example",
				"example",
				JSON.stringify({ name: "", exec: "./run", mode: "daemon" }),
			),
		).toThrow('must contain a non-empty string "name"');
	});

	test("rejects unsupported mode", () => {
		expect(() =>
			parseDaemonManifest(
				"/tmp/example",
				"example",
				JSON.stringify({ name: "example", exec: "./run", mode: "other" }),
			),
		).toThrow('must declare mode "daemon"');
	});
});

describe("JsonRpcPeer", () => {
	test("increments request ids and resolves matching responses", async () => {
		const sentLines: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: (line) => {
				sentLines.push(line);
			},
		});

		const first = peer.request("initialize");
		const second = peer.request("shutdown");

		expect(JSON.parse(sentLines[0] ?? "{}").id).toBe(1);
		expect(JSON.parse(sentLines[1] ?? "{}").id).toBe(2);

		peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "bye" }));
		peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));

		await expect(first).resolves.toBe("ok");
		await expect(second).resolves.toBe("bye");
	});

	test("surfaces invalid JSON lines", () => {
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
		});

		expect(() => peer.handleLine("{oops")).toThrow(
			"received invalid JSON-RPC line",
		);
	});

	test("delivers notifications", () => {
		const methods: string[] = [];
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
			onNotification: (message) => {
				methods.push(message.method);
			},
		});

		peer.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "event",
				params: { type: "message.received" },
			}),
		);

		expect(methods).toEqual(["event"]);
	});

	test("rejects responses for unknown request ids", () => {
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
		});

		expect(() =>
			peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "ok" })),
		).toThrow("unknown request id 99");
	});

	test("rejects malformed error responses", async () => {
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
		});

		const request = peer.request("initialize");
		peer.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				error: { code: "bad", message: "nope" },
			}),
		);

		await expect(request).rejects.toThrow(
			"received malformed JSON-RPC error response",
		);
	});

	test("rejects inbound requests", () => {
		const peer = new JsonRpcPeer({
			name: "test",
			sendLine: () => {},
		});

		expect(() =>
			peer.handleLine(
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
			),
		).toThrow("request handling is not supported");
	});
});

describe("sandbox", () => {
	test("selects sandbox-exec on darwin", () => {
		expect(resolveSandboxBackend("darwin")).toBe("sandbox-exec");
	});

	test("selects bwrap on linux", () => {
		expect(resolveSandboxBackend("linux")).toBe("bwrap");
	});

	test("rejects unsupported platforms", () => {
		expect(() => resolveSandboxBackend("win32")).toThrow(
			"Unsupported sandbox platform",
		);
	});

	test("builds a darwin profile with module and temp write access", () => {
		const profile = createDarwinSandboxProfile("/tmp/module");
		expect(profile).toContain('(subpath "/tmp/module")');
		expect(profile).toContain('(subpath "/tmp")');
		expect(profile).toContain('(subpath "/private/tmp")');
		expect(profile).toContain("(allow network*)");
	});

	test("builds a linux bwrap command from the readonly allowlist", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);
		const existingPaths = new Set([
			"/bin",
			"/usr",
			"/usr/local",
			"/opt",
			"/etc",
			"/lib",
			"/run",
			"/nix",
			"/tmp/example",
			"/tmp",
		]);
		const cmd = await createLinuxBubblewrapCommand(
			"/usr/bin/bwrap",
			manifest,
			async (candidatePath) => existingPaths.has(candidatePath),
		);

		expect(cmd).toEqual([
			"/usr/bin/bwrap",
			"--die-with-parent",
			"--new-session",
			"--ro-bind",
			"/bin",
			"/bin",
			"--ro-bind",
			"/usr",
			"/usr",
			"--ro-bind",
			"/usr/local",
			"/usr/local",
			"--ro-bind",
			"/opt",
			"/opt",
			"--ro-bind",
			"/etc",
			"/etc",
			"--ro-bind",
			"/lib",
			"/lib",
			"--ro-bind",
			"/run",
			"/run",
			"--ro-bind",
			"/nix",
			"/nix",
			"--bind",
			"/tmp/example",
			"/tmp/example",
			"--bind",
			"/tmp",
			"/tmp",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--chdir",
			"/tmp/example",
			"--",
			path.resolve("/tmp/example", "./run"),
		]);
	});

	test("omits missing optional linux readonly mounts", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand(
			"/usr/bin/bwrap",
			manifest,
			async (candidatePath) =>
				candidatePath === "/tmp/example" || candidatePath === "/tmp",
		);

		expect(cmd).not.toContain("/sys");
		expect(cmd).not.toContain("/var");
		expect(cmd).not.toContain("/var/tmp");
		expect(cmd).not.toContain("/usr/local");
		expect(cmd).toContain("/tmp/example");
		expect(cmd).toContain("/tmp");
	});

	test("fails when a required writable linux sandbox path is unavailable", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		await expect(
			createLinuxBubblewrapCommand(
				"/usr/bin/bwrap",
				manifest,
				async (candidatePath) => candidatePath === "/tmp/example",
			),
		).rejects.toThrow("Required writable sandbox path is unavailable: /tmp");
	});

	test("fails closed when the darwin backend is missing", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		await expect(
			createSandboxLaunchSpec(manifest, {
				platform: "darwin",
				lookupExecutable: async () => null,
			}),
		).rejects.toThrow("sandbox-exec backend is unavailable");
	});

	test("fails closed when the linux backend is missing", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		await expect(
			createSandboxLaunchSpec(manifest, {
				platform: "linux",
				lookupExecutable: async () => null,
			}),
		).rejects.toThrow("bwrap backend is unavailable");
	});

	test("preserves environment variables in the launch spec", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);
		const env = { ...process.env, OPENAI_API_KEY: "test-key" };

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			env,
			lookupExecutable: async () => "/usr/bin/sandbox-exec",
		});

		expect(spec.env.OPENAI_API_KEY).toBe("test-key");
		expect(spec.cmd[0]).toBe("/usr/bin/sandbox-exec");
	});
});

describe("bootstrapRuntime", () => {
	test("fails when HOME is unavailable", async () => {
		await expect(bootstrapRuntime({ homeDir: "" })).rejects.toThrow(
			"HOME is not set",
		);
	});

	test("fails when runtime modules directory does not exist", async () => {
		const homeDir = await createTempDir("justclaw-home-");

		await expect(bootstrapRuntime({ homeDir })).rejects.toThrow(
			"Failed to read runtime modules directory",
		);
	});

	test("fails when manifest file is missing", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const moduleDir = path.join(
			resolveModulesRoot(homeDir),
			"missing-manifest",
		);
		await mkdir(moduleDir, { recursive: true });

		await expect(bootstrapRuntime({ homeDir })).rejects.toThrow(
			"Failed to read manifest",
		);
	});

	test("fails when manifest JSON is invalid", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeRawDaemonModule(
			homeDir,
			"bad-manifest",
			"{oops",
			createModuleScript(),
		);

		await expect(bootstrapRuntime({ homeDir })).rejects.toThrow(
			"is not valid JSON",
		);
	});

	test("discovers, initializes, and shuts down a daemon module", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"echo",
			createModuleScript({ stderrLine: "booted" }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		expect(runtime.modulesRoot).toBe(path.join(homeDir, "justclaw", "modules"));
		expect(runtime.daemons).toHaveLength(1);
		expect(runtime.daemons[0]?.tools).toEqual([]);

		await stopDaemons(runtime.daemons);
	});

	test("fails when a daemon exits before initialize responds", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"early-exit",
			createModuleScript({ exitImmediately: true }),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow("process exited with code 0");
	});

	test("fails when initialize returns a JSON-RPC error", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"init-error",
			createModuleScript({
				initializeResponse: "undefined",
			}).replace(
				'console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: undefined }));',
				'console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "init failed" } }));',
			),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow("init failed");
	});

	test('fails when initialize result "tools" is not an array', async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"bad-tools",
			createModuleScript({
				initializeResponse: '{"tools":"not-an-array"}',
			}),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow('initialize result "tools" must be an array');
	});

	test("fails when stdout emits malformed JSON", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"bad-json",
			createModuleScript({ malformedStdout: true }),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow("received invalid JSON-RPC line");
	});

	test("shuts down already-started daemons when a later daemon fails", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const cleanupMarker = path.join(homeDir, "cleanup-marker.txt");
		await writeDaemonModule(
			homeDir,
			"a-good",
			createModuleScript({
				shutdownSideEffectPath: cleanupMarker,
			}),
		);
		await writeDaemonModule(
			homeDir,
			"z-bad",
			createModuleScript({ exitImmediately: true }),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow("process exited with code 0");
		await expect(readFile(cleanupMarker, "utf8")).resolves.toContain(
			"shutdown",
		);
	});

	test("kills a daemon when shutdown does not return", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stubborn",
			createModuleScript({ ignoreShutdown: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		await stopDaemons(runtime.daemons);

		const processInfo = daemon?.process;
		expect(processInfo).toBeDefined();
		await expect(processInfo?.exited).resolves.toBeNumber();
	});

	test("prefixes module stderr output", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stderr-module",
			createModuleScript({ stderrLine: "booted" }),
		);

		const messages: string[] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]) => {
			messages.push(args.join(" "));
		};

		try {
			const runtime = await bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			});
			await stopDaemons(runtime.daemons);
		} finally {
			console.error = originalConsoleError;
		}

		expect(
			messages.some((message) => message.includes("[stderr-module] booted")),
		).toBe(true);
	});

	test("resolveModulesRoot rejects empty HOME", () => {
		expect(() => resolveModulesRoot("")).toThrow("HOME is not set");
	});

	test("cleanup marker is absent before shutdown side effect runs", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const cleanupMarker = path.join(homeDir, "cleanup-marker.txt");
		await writeDaemonModule(
			homeDir,
			"idle",
			createModuleScript({
				shutdownSideEffectPath: cleanupMarker,
			}),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		await expect(stat(cleanupMarker)).rejects.toThrow();
		await stopDaemons(runtime.daemons);
	});
});
