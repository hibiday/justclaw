import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { DaemonModuleManifest } from "./module-manifest";

export type SandboxBackend = "bwrap" | "sandbox-exec";

export type SandboxLaunchSpec = {
	backend: SandboxBackend;
	cmd: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
};

type SandboxOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	lookupExecutable?: (
		command: string,
		env: NodeJS.ProcessEnv,
	) => Promise<string | null>;
	pathExists?: (path: string) => Promise<boolean>;
};

const DARWIN_TMP_PATHS = ["/tmp", "/private/tmp"] as const;
const LINUX_READONLY_PATHS = [
	"/bin",
	"/sbin",
	"/usr",
	"/usr/local",
	"/usr/sbin",
	"/opt",
	"/etc",
	"/lib",
	"/lib64",
	"/run",
	"/var/run",
	"/nix",
] as const;

async function defaultPathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function defaultLookupExecutable(
	command: string,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	if (command.includes("/")) {
		try {
			await access(command, constants.X_OK);
			return command;
		} catch {
			return null;
		}
	}

	const pathEnv = env.PATH ?? "";
	for (const dir of pathEnv.split(":")) {
		if (!dir) {
			continue;
		}

		const candidate = `${dir}/${command}`;
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}

	return null;
}

export function resolveSandboxBackend(
	platform: NodeJS.Platform,
): SandboxBackend {
	switch (platform) {
		case "darwin":
			return "sandbox-exec";
		case "linux":
			return "bwrap";
		default:
			throw new Error(`Unsupported sandbox platform: ${platform}`);
	}
}

function quoteSandboxString(value: string): string {
	return JSON.stringify(value);
}

export function createDarwinSandboxProfile(moduleDir: string): string {
	const allowedTempSubpaths = DARWIN_TMP_PATHS.map(
		(tempPath) => `  (subpath ${quoteSandboxString(tempPath)})`,
	).join("\n");

	return [
		"(version 1)",
		"(deny default)",
		'(import "system.sb")',
		"(allow process*)",
		'(allow file-read* file-map-executable (subpath "/"))',
		"(allow file-write*",
		`  (subpath ${quoteSandboxString(moduleDir)})`,
		allowedTempSubpaths,
		")",
		"(allow network*)",
	].join("\n");
}

export async function createLinuxBubblewrapCommand(
	bwrapPath: string,
	manifest: DaemonModuleManifest,
	pathExists: (path: string) => Promise<boolean> = defaultPathExists,
): Promise<string[]> {
	const cmd = [bwrapPath, "--die-with-parent", "--new-session"];

	for (const readonlyPath of LINUX_READONLY_PATHS) {
		if (await pathExists(readonlyPath)) {
			cmd.push("--ro-bind", readonlyPath, readonlyPath);
		}
	}

	for (const writablePath of [manifest.moduleDir, "/tmp"]) {
		if (!(await pathExists(writablePath))) {
			throw new Error(
				`Required writable sandbox path is unavailable: ${writablePath}`,
			);
		}
		cmd.push("--bind", writablePath, writablePath);
	}

	cmd.push(
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--chdir",
		manifest.moduleDir,
		"--",
		manifest.execPath,
	);

	return cmd;
}

export async function createSandboxLaunchSpec(
	manifest: DaemonModuleManifest,
	options: SandboxOptions = {},
): Promise<SandboxLaunchSpec> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const lookupExecutable = options.lookupExecutable ?? defaultLookupExecutable;
	const pathExists = options.pathExists ?? defaultPathExists;
	const backend = resolveSandboxBackend(platform);

	if (backend === "sandbox-exec") {
		const sandboxExecPath = await lookupExecutable("sandbox-exec", env);
		if (!sandboxExecPath) {
			throw new Error("sandbox-exec backend is unavailable");
		}

		return {
			backend,
			cmd: [
				sandboxExecPath,
				"-p",
				createDarwinSandboxProfile(manifest.moduleDir),
				"--",
				manifest.execPath,
			],
			cwd: manifest.moduleDir,
			env,
		};
	}

	const bwrapPath = await lookupExecutable("bwrap", env);
	if (!bwrapPath) {
		throw new Error("bwrap backend is unavailable");
	}

	return {
		backend,
		cmd: await createLinuxBubblewrapCommand(bwrapPath, manifest, pathExists),
		cwd: manifest.moduleDir,
		env,
	};
}
