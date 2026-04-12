import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcPeer } from "./jsonrpc";
import {
	discoverDaemonManifests,
	parseDaemonManifest,
	resolveModulesRoot,
} from "./module-manifest";
import { bootstrapRuntime, type StartedDaemon, stopDaemons } from "./runtime";
import {
	createDarwinSandboxProfile,
	createLinuxBubblewrapCommand,
	createSandboxLaunchSpec,
	resolveSandboxBackend,
	type SandboxLaunchSpec,
} from "./sandbox";

const tempDirs: string[] = [];
const originalJustclawHome = process.env.JUSTCLAW_HOME;

beforeEach(() => {
	delete process.env.JUSTCLAW_HOME;
});

afterEach(async () => {
	if (originalJustclawHome === undefined) {
		delete process.env.JUSTCLAW_HOME;
	} else {
		process.env.JUSTCLAW_HOME = originalJustclawHome;
	}

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

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await delay(10);
	}

	throw new Error("Timed out waiting for condition");
}

function createModuleScript({
	initializeResponse = '{"tools":[]}',
	shutdownResponse = '"ok"',
	stderrLine,
	malformedStdout = false,
	exitImmediately = false,
	closeStdoutWithoutExit = false,
	ignoreInitialize = false,
	ignoreShutdown = false,
	ignoreTerminate = false,
	exitAfterShutdown = true,
	shutdownSideEffectPath,
}: {
	initializeResponse?: string;
	shutdownResponse?: string;
	stderrLine?: string;
	malformedStdout?: boolean;
	exitImmediately?: boolean;
	closeStdoutWithoutExit?: boolean;
	ignoreInitialize?: boolean;
	ignoreShutdown?: boolean;
	ignoreTerminate?: boolean;
	exitAfterShutdown?: boolean;
	shutdownSideEffectPath?: string;
} = {}): string {
	return `#!/usr/bin/env bun
import { closeSync } from "node:fs";
${stderrLine ? `console.error(${JSON.stringify(stderrLine)});\n` : ""}${ignoreTerminate ? 'process.on("SIGTERM", () => {});\n' : ""}${exitImmediately ? "process.exit(0);\n" : ""}${closeStdoutWithoutExit ? "closeSync(1);\nsetInterval(() => {}, 1000);\n" : ""}const lines = [];
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
			${ignoreInitialize ? "continue;" : ""}
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${initializeResponse} }));
		} else if (message.method === "shutdown") {
			${
				shutdownSideEffectPath
					? `await Bun.write(${JSON.stringify(shutdownSideEffectPath)}, "shutdown\\n");`
					: ""
			}
			${ignoreShutdown ? "continue;" : ""}
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: ${shutdownResponse} }));
			${exitAfterShutdown ? "process.exit(0);" : ""}
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
	const moduleDir = path.join(
		resolveModulesRoot(undefined, homeDir),
		moduleName,
	);
	await mkdir(moduleDir, { recursive: true });
	await writeFile(path.join(moduleDir, "module.json"), manifestText);
	const scriptPath = path.join(moduleDir, "module.ts");
	await writeFile(scriptPath, script);
	await chmod(scriptPath, 0o755);
}

function createStdoutClosingShellScript(): string {
	return `#!/bin/sh
exec 1>&-
sleep 10
`;
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

	test("rejects absolute exec paths", () => {
		expect(() =>
			parseDaemonManifest(
				"/tmp/example",
				"example",
				JSON.stringify({
					name: "example",
					exec: "/usr/bin/python",
					mode: "daemon",
				}),
			),
		).toThrow('"exec" must be relative to the module directory');
	});

	test("rejects exec paths that escape the module directory", () => {
		expect(() =>
			parseDaemonManifest(
				"/tmp/example",
				"example",
				JSON.stringify({ name: "example", exec: "../run", mode: "daemon" }),
			),
		).toThrow('"exec" must stay inside the module directory');
	});

	test("accepts exec paths that start with dots but stay inside the module directory", () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./..bin/run", mode: "daemon" }),
		);

		expect(manifest.execPath).toBe(path.resolve("/tmp/example/..bin/run"));
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
		expect(profile).toContain('(subpath "/System")');
		expect(profile).toContain('(subpath "/usr")');
		expect(profile).toContain('(subpath "/opt")');
		expect(profile).toContain('(subpath "/Library")');
		expect(profile).toContain('(subpath "/private/etc")');
		expect(profile).toContain('(subpath "/tmp")');
		expect(profile).toContain('(subpath "/private/tmp")');
		expect(profile).not.toContain('(subpath "/")');
		expect(profile).toContain("(allow network*)");
	});

	test("includes inherited TMPDIR in the darwin profile", () => {
		const profile = createDarwinSandboxProfile("/tmp/module", {
			...process.env,
			TMPDIR: "/var/folders/example/T/",
		});

		expect(profile).toContain('(subpath "/var/folders/example/T")');
		expect(profile).toContain('(subpath "/private/var/folders/example/T")');
	});

	test("allows a darwin shebang interpreter installed under HOME for reads only", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			env: { ...process.env, PATH: "/Users/test/.bun/bin:/usr/bin" },
			lookupExecutable: async (command) => {
				if (command === "sandbox-exec") {
					return "/usr/bin/sandbox-exec";
				}
				if (command === "bun") {
					return "/Users/test/.bun/bin/bun";
				}
				return null;
			},
			readTextFile: async () => "#!/usr/bin/env bun\nconsole.log('hi')\n",
		});

		const profile = spec.cmd[2] ?? "";
		expect(profile).toContain('(subpath "/Users/test/.bun/bin")');
		expect(profile.slice(profile.indexOf("(allow file-write*"))).not.toContain(
			'(subpath "/Users/test/.bun/bin")',
		);
	});

	test("allows both lookup and real target paths for a symlinked darwin shebang interpreter", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			env: { ...process.env, PATH: "/Users/test/.bun/bin:/usr/bin" },
			lookupExecutable: async (command) => {
				if (command === "sandbox-exec") {
					return "/usr/bin/sandbox-exec";
				}
				if (command === "bun") {
					return "/Users/test/.bun/bin/bun";
				}
				return null;
			},
			realPath: async (candidatePath) =>
				candidatePath === "/Users/test/.bun/bin/bun"
					? "/Users/test/.bun/install/bin/bun"
					: candidatePath,
			readTextFile: async () => "#!/usr/bin/env bun\nconsole.log('hi')\n",
		});

		const profile = spec.cmd[2] ?? "";
		expect(profile).toContain('(subpath "/Users/test/.bun/bin")');
		expect(profile).toContain('(subpath "/Users/test/.bun/install/bin")');
	});

	test("allows a root-level darwin shebang interpreter without exposing root", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			lookupExecutable: async (command) =>
				command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			readTextFile: async () => "#!/bun\nconsole.log('hi')\n",
		});

		const profile = spec.cmd[2] ?? "";
		expect(profile).toContain('(subpath "/bun")');
		expect(profile).not.toContain('(subpath "/")');
	});

	test("allows a darwin shebang interpreter as a file when its parent contains the module directory", async () => {
		const moduleDir = "/Users/alice/justclaw/modules/example";
		const interpreterPath = "/Users/alice/justclaw/bun";
		const manifest = parseDaemonManifest(
			moduleDir,
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "darwin",
			lookupExecutable: async (command) =>
				command === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
			readTextFile: async () => `#!${interpreterPath}\nconsole.log('hi')\n`,
		});

		const profile = spec.cmd[2] ?? "";
		expect(profile).toContain(`(subpath "${moduleDir}")`);
		expect(profile).toContain(`(subpath "${interpreterPath}")`);
		expect(profile).not.toContain('(subpath "/Users/alice/justclaw")');
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
			"/nix",
			"/tmp/example",
			"/tmp",
		]);
		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) => existingPaths.has(candidatePath),
		});

		expect(cmd.slice(0, 3)).toEqual([
			"/usr/bin/bwrap",
			"--die-with-parent",
			"--new-session",
		]);
		expect(cmd).toContain("--unshare-pid");
		expect(cmd).toContain("/usr");
		expect(cmd).toContain("/usr/local");
		expect(cmd).not.toContain("/run");
		expect(cmd).not.toContain("/var/run");
		expect(cmd).toContain("--ro-bind");
		expect(cmd).toContain("--bind");
		expect(cmd).toContain("--proc");
		expect(cmd).toContain("--dev");
		expect(cmd).toContain(path.resolve("/tmp/example", "./run"));
	});

	test("creates bwrap mountpoints for home module directories", async () => {
		const moduleDir = "/home/test/justclaw/modules/example";
		const manifest = parseDaemonManifest(
			moduleDir,
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp" || candidatePath === moduleDir,
		});

		expect(cmd).toContain("/home");
		expect(cmd).toContain("/home/test");
		expect(cmd).toContain("/home/test/justclaw");
		expect(cmd).toContain("/home/test/justclaw/modules");
		expect(cmd).toContain(moduleDir);
		expect(cmd).toContain("--bind");
	});

	test("adds a mount for a shebang interpreter resolved via env", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			env: { ...process.env, PATH: "/home/test/.bun/bin:/usr/bin" },
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/home/test/.bun/bin",
			lookupExecutable: async (command) =>
				command === "bun" ? "/home/test/.bun/bin/bun" : null,
			readTextFile: async () => "#!/usr/bin/env bun\nconsole.log('hi')\n",
		});

		expect(cmd).toContain("--dir");
		expect(cmd).toContain("/home");
		expect(cmd).toContain("/home/test");
		expect(cmd).toContain("/home/test/.bun");
		expect(cmd).toContain("/home/test/.bun/bin");
		expect(cmd).toContain("--ro-bind");
		expect(cmd).toContain("/home/test/.bun/bin");
	});

	test("mounts both lookup and real target paths for a symlinked linux shebang interpreter", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			env: { ...process.env, PATH: "/home/test/.bun/bin:/usr/bin" },
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/home/test/.bun/bin" ||
				candidatePath === "/opt/bun/bin",
			lookupExecutable: async (command) =>
				command === "bun" ? "/home/test/.bun/bin/bun" : null,
			realPath: async (candidatePath) =>
				candidatePath === "/home/test/.bun/bin/bun"
					? "/opt/bun/bin/bun"
					: candidatePath,
			readTextFile: async () => "#!/usr/bin/env bun\nconsole.log('hi')\n",
		});

		expect(cmd).toContain("/opt");
		expect(cmd).toContain("/opt/bun");
		expect(cmd).toContain("/opt/bun/bin");
		expect(cmd).toContain("/home/test/.bun/bin");
	});

	test("skips env assignments when resolving an env -S shebang interpreter", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			env: { ...process.env, PATH: "/home/test/.bun/bin:/usr/bin" },
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/home/test/.bun/bin",
			lookupExecutable: async (command) =>
				command === "bun" ? "/home/test/.bun/bin/bun" : null,
			readTextFile: async () =>
				"#!/usr/bin/env -S BUN_INSTALL=$HOME/.bun bun\nconsole.log('hi')\n",
		});

		expect(cmd).toContain("--dir");
		expect(cmd).toContain("/home");
		expect(cmd).toContain("/home/test");
		expect(cmd).toContain("/home/test/.bun");
		expect(cmd).toContain("/home/test/.bun/bin");
		expect(cmd).toContain("--ro-bind");
		expect(cmd).toContain("/home/test/.bun/bin");
	});

	test("applies PATH assignments when resolving an env -S shebang interpreter", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			env: { ...process.env, PATH: "/usr/bin" },
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/opt/bun/bin",
			lookupExecutable: async (command, env) =>
				command === "bun" && env.PATH === "/opt/bun/bin"
					? "/opt/bun/bin/bun"
					: null,
			readTextFile: async () =>
				"#!/usr/bin/env -S PATH=/opt/bun/bin bun\nconsole.log('hi')\n",
		});

		expect(cmd).toContain("/opt/bun/bin");
	});

	test("skips env options that consume the next token when resolving an env -S shebang interpreter", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			env: { ...process.env, PATH: "/home/test/.bun/bin:/usr/bin" },
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/home/test/.bun/bin",
			lookupExecutable: async (command) =>
				command === "bun" ? "/home/test/.bun/bin/bun" : null,
			readTextFile: async () =>
				"#!/usr/bin/env -S -u NODE_OPTIONS bun\nconsole.log('hi')\n",
		});

		expect(cmd).toContain("/home/test/.bun/bin");
	});

	test("adds a mount for an absolute shebang interpreter outside the allowlist", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/custom/runtime/bin",
			readTextFile: async () => "#!/custom/runtime/bin/bun\n",
		});

		expect(cmd).toContain("/custom");
		expect(cmd).toContain("/custom/runtime");
		expect(cmd).toContain("/custom/runtime/bin");
		expect(cmd).toContain("--ro-bind");
	});

	test("mounts a root-level linux shebang interpreter as a file", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/bun",
			readTextFile: async () => "#!/bun\n",
		});

		expect(
			cmd.some(
				(token, index) =>
					token === "--ro-bind" &&
					cmd[index + 1] === "/bun" &&
					cmd[index + 2] === "/bun",
			),
		).toBe(true);
		expect(
			cmd.some(
				(token, index) =>
					token === "--ro-bind" &&
					cmd[index + 1] === "/" &&
					cmd[index + 2] === "/",
			),
		).toBe(false);
	});

	test("mounts a linux shebang interpreter as a file when its parent contains the module directory", async () => {
		const moduleDir = "/home/alice/justclaw/modules/example";
		const interpreterPath = "/home/alice/justclaw/bun";
		const manifest = parseDaemonManifest(
			moduleDir,
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === moduleDir ||
				candidatePath === "/tmp" ||
				candidatePath === interpreterPath,
			readTextFile: async () => `#!${interpreterPath}\n`,
		});

		expect(
			cmd.some(
				(token, index) =>
					token === "--ro-bind" &&
					cmd[index + 1] === interpreterPath &&
					cmd[index + 2] === interpreterPath,
			),
		).toBe(true);
		expect(
			cmd.some(
				(token, index) =>
					token === "--ro-bind" &&
					cmd[index + 1] === "/home/alice/justclaw" &&
					cmd[index + 2] === "/home/alice/justclaw",
			),
		).toBe(false);
	});

	test("does not add an extra interpreter mount when the shebang is already covered", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);
		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/usr",
			readTextFile: async () => "#!/usr/bin/env bun\n",
			lookupExecutable: async (command) =>
				command === "bun" ? "/usr/bin/bun" : null,
		});

		expect(
			cmd.filter(
				(token, index) => token === "--ro-bind" && cmd[index + 1] === "/usr",
			),
		).toHaveLength(1);
	});

	test("omits missing optional linux readonly mounts", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" || candidatePath === "/tmp",
		});

		expect(cmd).not.toContain("/sys");
		expect(cmd).not.toContain("/var");
		expect(cmd).not.toContain("/var/tmp");
		expect(cmd).not.toContain("/usr/local");
		expect(cmd).toContain("/tmp/example");
		expect(cmd).toContain("/tmp");
	});

	test("mounts the linux resolver symlink target without exposing /run wholesale", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/etc" ||
				candidatePath === "/etc/resolv.conf" ||
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp",
			realPath: async (candidatePath) =>
				candidatePath === "/etc/resolv.conf"
					? "/run/systemd/resolve/stub-resolv.conf"
					: candidatePath,
		});

		expect(cmd).toContain("/run");
		expect(cmd).toContain("/run/systemd");
		expect(cmd).toContain("/run/systemd/resolve");
		expect(cmd).toContain("/run/systemd/resolve/stub-resolv.conf");
		expect(
			cmd.filter(
				(token, index) => token === "--ro-bind" && cmd[index + 1] === "/run",
			),
		).toHaveLength(0);
	});

	test("ignores a shebang interpreter path when its directory does not exist", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		const cmd = await createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" || candidatePath === "/tmp",
			readTextFile: async () => "#!/missing/bin/bun\n",
		});

		expect(cmd).not.toContain("/missing/bin");
	});

	test("fails when a required writable linux sandbox path is unavailable", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);

		await expect(
			createLinuxBubblewrapCommand("/usr/bin/bwrap", manifest, {
				pathExists: async (candidatePath) => candidatePath === "/tmp/example",
			}),
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

	test("normalizes TMPDIR to /tmp in the linux launch spec", async () => {
		const manifest = parseDaemonManifest(
			"/tmp/example",
			"example",
			JSON.stringify({ name: "example", exec: "./run", mode: "daemon" }),
		);
		const env = { ...process.env, TMPDIR: "/var/tmp/custom" };

		const spec = await createSandboxLaunchSpec(manifest, {
			platform: "linux",
			env,
			lookupExecutable: async () => "/usr/bin/bwrap",
			pathExists: async (candidatePath) =>
				candidatePath === "/tmp/example" ||
				candidatePath === "/tmp" ||
				candidatePath === "/usr",
		});

		expect(spec.env.TMPDIR).toBe("/tmp");
	});
});

describe("bootstrapRuntime", () => {
	test("fails when HOME is unavailable", async () => {
		await expect(bootstrapRuntime({ homeDir: "" })).rejects.toThrow(
			"HOME is not set and JUSTCLAW_HOME is not set",
		);
	});

	test("fails when runtime modules directory does not exist", async () => {
		const homeDir = await createTempDir("justclaw-home-");

		await expect(bootstrapRuntime({ homeDir })).rejects.toThrow(
			"No modules directory found at",
		);
	});

	test("ignores directories without a manifest file", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const moduleDir = path.join(
			resolveModulesRoot(undefined, homeDir),
			"missing-manifest",
		);
		await mkdir(moduleDir, { recursive: true });

		const manifests = await discoverDaemonManifests(
			resolveModulesRoot(undefined, homeDir),
		);

		expect(manifests).toHaveLength(0);
	});

	test("fails fast when no valid modules are installed", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const modulesRoot = resolveModulesRoot(undefined, homeDir);
		await mkdir(modulesRoot, { recursive: true });
		await mkdir(path.join(modulesRoot, "notes"), { recursive: true });
		await writeFile(path.join(modulesRoot, ".DS_Store"), "noise");

		await expect(bootstrapRuntime({ homeDir })).rejects.toThrow(
			`No modules available in ${modulesRoot}`,
		);
	});

	test("ignores non-module filesystem noise in the modules root", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const modulesRoot = resolveModulesRoot(undefined, homeDir);
		await mkdir(modulesRoot, { recursive: true });
		await writeFile(path.join(modulesRoot, ".DS_Store"), "noise");
		await mkdir(path.join(modulesRoot, "notes"), { recursive: true });
		await writeDaemonModule(homeDir, "echo", createModuleScript());

		const manifests = await discoverDaemonManifests(modulesRoot);

		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.name).toBe("echo");
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
		).rejects.toThrow("stdout closed unexpectedly");
	});

	test("fails immediately when stdout closes before initialize responds", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stdout-closed",
			createStdoutClosingShellScript(),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow("stdout closed unexpectedly");
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

	test("fails when initialize does not respond before the configured timeout", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"init-timeout",
			createModuleScript({ ignoreInitialize: true }),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				initializeTimeoutMs: 50,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow("initialize timed out");
	});

	test("registers spawned daemons before initialize completes", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"init-pending",
			createModuleScript({ ignoreInitialize: true }),
		);
		const startedDaemons: StartedDaemon[] = [];

		const bootstrap = bootstrapRuntime({
			homeDir,
			initializeTimeoutMs: 5_000,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			startedDaemons,
		});
		await waitUntil(() => startedDaemons.length === 1);
		await stopDaemons(startedDaemons);

		await expect(bootstrap).rejects.toThrow();
	});

	test('fails when initialize result "tools" is not an array', async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const cleanupMarker = path.join(homeDir, "bad-tools-cleanup.txt");
		await writeDaemonModule(
			homeDir,
			"bad-tools",
			createModuleScript({
				initializeResponse: '{"tools":"not-an-array"}',
				shutdownSideEffectPath: cleanupMarker,
			}),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow('initialize result "tools" must be an array');
		await expect(readFile(cleanupMarker, "utf8")).resolves.toContain(
			"shutdown",
		);
	});

	test("rejects array initialize results", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"array-init",
			createModuleScript({
				initializeResponse: "[]",
			}),
		);

		await expect(
			bootstrapRuntime({
				homeDir,
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			}),
		).rejects.toThrow("initialize result must be an object");
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

	test("terminates a started daemon after stdout closes", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stdout-closes-late",
			`#!/bin/sh
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
exec 1>&-
sleep 10
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		try {
			await expect(
				Promise.race([
					daemon?.process.exited,
					delay(1_000).then(() => {
						throw new Error("daemon was not terminated");
					}),
				]),
			).resolves.toBeNumber();
		} finally {
			if (daemon?.process.exitCode === null) {
				daemon.process.kill("SIGKILL");
			}
		}
	});

	test("kills a started daemon that ignores SIGTERM after stdout closes", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"stdout-closes-stubborn",
			`#!/bin/sh
trap '' TERM
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
exec 1>&-
sleep 10
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		try {
			await expect(
				Promise.race([
					daemon?.process.exited,
					delay(3_000).then(() => {
						throw new Error("daemon was not killed");
					}),
				]),
			).resolves.toBeNumber();
		} finally {
			if (daemon?.process.exitCode === null) {
				daemon.process.kill("SIGKILL");
			}
		}
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
		).rejects.toThrow("stdout closed unexpectedly");
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

	test("waits for a daemon to exit after a shutdown response", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const cleanupMarker = path.join(homeDir, "shutdown-cleanup.txt");
		await writeDaemonModule(
			homeDir,
			"async-shutdown",
			`#!/usr/bin/env bun
const chunks = [];
for await (const chunk of Bun.stdin.stream()) {
	chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	const lines = text.split(/\\r?\\n/);
	while (lines.length > 1) {
		const line = lines.shift();
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.method === "initialize") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
		} else if (message.method === "shutdown") {
			console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
			await new Promise((resolve) => setTimeout(resolve, 100));
			await Bun.write(${JSON.stringify(cleanupMarker)}, "cleanup\\n");
			process.exit(0);
		}
	}
	chunks.length = 0;
	if (lines[0]) {
		chunks.push(Buffer.from(lines[0]));
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});

		await stopDaemons(runtime.daemons);

		await expect(readFile(cleanupMarker, "utf8")).resolves.toContain("cleanup");
	});

	test("kills a daemon with SIGKILL when it ignores shutdown and SIGTERM", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"sigkill-stubborn",
			createModuleScript({ ignoreShutdown: true, ignoreTerminate: true }),
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const daemon = runtime.daemons[0];
		expect(daemon).toBeDefined();

		await stopDaemons(runtime.daemons);
		await expect(daemon?.process.exited).resolves.toBeNumber();
	});

	test("terminates daemon child processes on shutdown", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const childPidPath = path.join(homeDir, "child.pid");
		await writeDaemonModule(
			homeDir,
			"child-spawner",
			`#!/usr/bin/env bun
const child = Bun.spawn(["sleep", "10"]);
await Bun.write(${JSON.stringify(childPidPath)}, String(child.pid));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		setInterval(() => {}, 1000);
	}
}
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const childPid = Number(await readFile(childPidPath, "utf8"));
		expect(childPid).toBeGreaterThan(0);

		await stopDaemons(runtime.daemons);

		await waitUntil(() => {
			try {
				process.kill(childPid, 0);
				return false;
			} catch {
				return true;
			}
		});
	});

	test("terminates daemon child processes after graceful daemon exit", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		const childPidPath = path.join(homeDir, "graceful-child.pid");
		await writeDaemonModule(
			homeDir,
			"graceful-child-spawner",
			`#!/bin/sh
sleep 10 &
echo "$!" > ${childPidPath}
IFS= read -r line
echo '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
IFS= read -r line
echo '{"jsonrpc":"2.0","id":2,"result":"ok"}'
exit 0
`,
		);

		const runtime = await bootstrapRuntime({
			homeDir,
			sandboxFactory: async (manifest) =>
				createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
		});
		const childPid = Number(await readFile(childPidPath, "utf8"));
		expect(childPid).toBeGreaterThan(0);

		await stopDaemons(runtime.daemons);

		await waitUntil(() => {
			try {
				process.kill(childPid, 0);
				return false;
			} catch {
				return true;
			}
		});
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

	test("logs event notifications until the LLM queue exists", async () => {
		const homeDir = await createTempDir("justclaw-home-");
		await writeDaemonModule(
			homeDir,
			"event-module",
			`#!/usr/bin/env bun
console.log(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.received", text: "hello" } }));
for await (const chunk of Bun.stdin.stream()) {
	const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
	if (message.method === "initialize") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
	} else if (message.method === "shutdown") {
		console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "ok" }));
		process.exit(0);
	}
}
`,
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
			messages.some((message) =>
				message.includes(
					'[event-module] event {"type":"message.received","text":"hello"}',
				),
			),
		).toBe(true);
	});

	test("resolveModulesRoot rejects empty HOME", () => {
		expect(() => resolveModulesRoot("", "")).toThrow(
			"HOME is not set and JUSTCLAW_HOME is not set",
		);
	});

	test("resolveModulesRoot prefers JUSTCLAW_HOME", () => {
		expect(resolveModulesRoot("/tmp/justclaw-home", "/tmp/ignored-home")).toBe(
			"/tmp/justclaw-home/modules",
		);
	});

	test("resolveModulesRoot returns an absolute path for relative JUSTCLAW_HOME", () => {
		expect(
			resolveModulesRoot("relative-justclaw-home", "/tmp/ignored-home"),
		).toBe(path.resolve("relative-justclaw-home", "modules"));
	});

	test("bootstrapRuntime respects JUSTCLAW_HOME", async () => {
		const justclawHome = await createTempDir("justclaw-home-override-");
		const originalJustclawHome = process.env.JUSTCLAW_HOME;
		const originalHome = process.env.HOME;
		process.env.JUSTCLAW_HOME = justclawHome;
		process.env.HOME = "/tmp/ignored-home";

		try {
			const moduleDir = path.join(justclawHome, "modules", "echo");
			await mkdir(moduleDir, { recursive: true });
			await writeFile(
				path.join(moduleDir, "module.json"),
				JSON.stringify({ name: "echo", exec: "./module.ts", mode: "daemon" }),
			);
			await writeFile(path.join(moduleDir, "module.ts"), createModuleScript());
			await chmod(path.join(moduleDir, "module.ts"), 0o755);

			const runtime = await bootstrapRuntime({
				sandboxFactory: async (manifest) =>
					createUnsandboxedSpec(manifest.moduleDir, manifest.execPath),
			});
			expect(runtime.modulesRoot).toBe(path.join(justclawHome, "modules"));
			await stopDaemons(runtime.daemons);
		} finally {
			if (originalJustclawHome === undefined) {
				delete process.env.JUSTCLAW_HOME;
			} else {
				process.env.JUSTCLAW_HOME = originalJustclawHome;
			}
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
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
