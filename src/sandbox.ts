import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import path from "node:path";
import type {
	DaemonModuleManifest,
	TimerModuleManifest,
} from "./module-manifest";

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
	realPath?: (path: string) => Promise<string>;
	readTextFile?: (path: string) => Promise<string>;
};

type LinuxBubblewrapOptions = {
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => Promise<boolean>;
	realPath?: (path: string) => Promise<string>;
	lookupExecutable?: (
		command: string,
		env: NodeJS.ProcessEnv,
	) => Promise<string | null>;
	readTextFile?: (path: string) => Promise<string>;
};

export type LinuxWorkspaceBwrapOptions = {
	pathExists?: (path: string) => Promise<boolean>;
	realPath?: (path: string) => Promise<string>;
	/** When false, skip --ro-bind for history (directory missing on host). */
	bindHistoryDir?: boolean;
	/** Optional agent `character/` directory; rw-mounted when present on the host. */
	characterDir?: string;
	/** Runtime modules root; rw-mounted when present on the host (same visibility as characterDir). */
	modulesRoot?: string;
};

export type WorkspaceSandboxBaseOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	pathExists?: (path: string) => Promise<boolean>;
	realPath?: (path: string) => Promise<string>;
	lookupExecutable?: (
		command: string,
		env: NodeJS.ProcessEnv,
	) => Promise<string | null>;
	/** Optional agent `character/` directory; rw-mounted in the workspace sandbox when set. */
	characterDir?: string;
	/** Runtime modules root; rw-mounted in the workspace sandbox when set. */
	modulesRoot?: string;
};

type ResolvedShebangInterpreter = {
	lookupPath: string;
	realPath: string;
};

type ParsedShebangInterpreter = {
	command: string;
	env: NodeJS.ProcessEnv;
};

const DARWIN_TMP_PATHS = ["/tmp", "/private/tmp"] as const;
const DARWIN_READONLY_PATHS = [
	"/System",
	"/usr",
	"/bin",
	"/sbin",
	"/opt",
	"/Library",
	"/private/etc",
	"/private/var/run",
] as const;
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

async function defaultReadTextFile(path: string): Promise<string> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(4096);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}

async function defaultRealPath(path: string): Promise<string> {
	return realpath(path);
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

function normalizeDarwinTempPath(tempPath: string): string[] {
	const normalized = tempPath.endsWith("/") ? tempPath.slice(0, -1) : tempPath;
	if (normalized.length === 0) {
		return [];
	}

	if (normalized.startsWith("/private/")) {
		return [normalized, normalized.slice("/private".length)];
	}

	if (normalized.startsWith("/var/")) {
		return [normalized, `/private${normalized}`];
	}

	return [normalized];
}

function getDarwinTempPaths(env: NodeJS.ProcessEnv): string[] {
	const tempPaths = new Set<string>(DARWIN_TMP_PATHS);
	if (!env.TMPDIR) {
		return [...tempPaths];
	}

	for (const tempPath of normalizeDarwinTempPath(env.TMPDIR)) {
		tempPaths.add(tempPath);
	}

	return [...tempPaths];
}

export function createDarwinSandboxProfile(
	moduleDir: string,
	env: NodeJS.ProcessEnv = process.env,
	extraReadonlyPaths: string[] = [],
): string {
	// sandbox-exec's (subpath moduleDir) does not grant read access to parent
	// directories themselves, but Bun reads ancestor directories on startup.
	// Use (literal …) for each ancestor up to the filesystem root (excluding /).
	const moduleDirAncestorLiterals: string[] = [];
	let ancestor = path.dirname(moduleDir);
	while (ancestor !== path.dirname(ancestor)) {
		moduleDirAncestorLiterals.push(
			`  (literal ${quoteSandboxString(ancestor)})`,
		);
		ancestor = path.dirname(ancestor);
	}

	const allowedReadonlySubpaths = [
		moduleDir,
		...DARWIN_READONLY_PATHS,
		...getDarwinTempPaths(env),
		...extraReadonlyPaths,
	]
		.map((readonlyPath) => `  (subpath ${quoteSandboxString(readonlyPath)})`)
		.join("\n");
	const allowedTempSubpaths = getDarwinTempPaths(env)
		.map((tempPath) => `  (subpath ${quoteSandboxString(tempPath)})`)
		.join("\n");

	return [
		"(version 1)",
		"(deny default)",
		'(import "system.sb")',
		"(allow process*)",
		"(allow file-read-metadata)",
		"(allow file-read* file-map-executable",
		allowedReadonlySubpaths,
		...moduleDirAncestorLiterals,
		")",
		"(allow file-write*",
		`  (subpath ${quoteSandboxString(moduleDir)})`,
		allowedTempSubpaths,
		")",
		"(allow network*)",
	].join("\n");
}

function collectDarwinAncestorLiterals(dir: string): string[] {
	const literals: string[] = [];
	let ancestor = path.dirname(dir);
	while (ancestor !== path.dirname(ancestor)) {
		literals.push(`  (literal ${quoteSandboxString(ancestor)})`);
		ancestor = path.dirname(ancestor);
	}
	return literals;
}

/**
 * sandbox-exec profile for a workspace (rw) and optional session history (ro).
 * When {@link includeHistoryDir} is false, {@link historyDir} is omitted from the profile
 * (host directory does not exist yet).
 */
export function createDarwinWorkspaceSandboxProfile(
	workspaceDir: string,
	historyDir: string,
	env: NodeJS.ProcessEnv = process.env,
	includeHistoryDir = true,
	characterDir?: string,
	modulesRoot?: string,
): string {
	const workspaceAncestors = collectDarwinAncestorLiterals(workspaceDir);
	const historyAncestors = includeHistoryDir
		? collectDarwinAncestorLiterals(historyDir)
		: [];
	const characterAncestors = characterDir
		? collectDarwinAncestorLiterals(characterDir)
		: [];
	const modulesAncestors = modulesRoot
		? collectDarwinAncestorLiterals(modulesRoot)
		: [];

	const readonlySubpathEntries = [
		workspaceDir,
		...(includeHistoryDir ? [historyDir] : []),
		...(characterDir ? [characterDir] : []),
		...(modulesRoot ? [modulesRoot] : []),
		...DARWIN_READONLY_PATHS,
		...getDarwinTempPaths(env),
	]
		.map((p) => `  (subpath ${quoteSandboxString(p)})`)
		.join("\n");
	const allowedTempSubpaths = getDarwinTempPaths(env)
		.map((tempPath) => `  (subpath ${quoteSandboxString(tempPath)})`)
		.join("\n");

	return [
		"(version 1)",
		"(deny default)",
		'(import "system.sb")',
		"(allow process*)",
		"(allow file-read-metadata)",
		"(allow file-read* file-map-executable",
		readonlySubpathEntries,
		...workspaceAncestors,
		...historyAncestors,
		...characterAncestors,
		...modulesAncestors,
		")",
		"(allow file-write*",
		`  (subpath ${quoteSandboxString(workspaceDir)})`,
		...(characterDir
			? [`  (subpath ${quoteSandboxString(characterDir)})`]
			: []),
		...(modulesRoot ? [`  (subpath ${quoteSandboxString(modulesRoot)})`] : []),
		allowedTempSubpaths,
		")",
		"(allow network*)",
	].join("\n");
}

function isPathCovered(
	candidatePath: string,
	mountedRoots: Iterable<string>,
): boolean {
	for (const root of mountedRoots) {
		if (candidatePath === root || candidatePath.startsWith(`${root}/`)) {
			return true;
		}
	}

	return false;
}

function parseShebangInterpreter(
	shebang: string,
	env: NodeJS.ProcessEnv,
): ParsedShebangInterpreter | null {
	const tokens = shebang
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) {
		return null;
	}

	const [interpreter, ...args] = tokens;
	if (!interpreter) {
		return null;
	}

	if (!interpreter.endsWith("/env")) {
		return { command: interpreter, env };
	}

	if (args.length === 0) {
		return null;
	}

	let commandIndex = 0;
	if (args[0] === "-S") {
		commandIndex = 1;
	}

	const shebangEnv = { ...env };
	while (commandIndex < args.length) {
		const token = args[commandIndex] ?? "";
		if (isEnvAssignmentToken(token)) {
			const [name, value] = splitEnvAssignmentToken(token);
			shebangEnv[name] = value;
			commandIndex += 1;
			continue;
		}
		if (envOptionConsumesNextToken(token)) {
			commandIndex += 2;
			continue;
		}
		if (token.startsWith("-")) {
			commandIndex += 1;
			continue;
		}
		break;
	}

	const command = args[commandIndex];
	return command ? { command, env: shebangEnv } : null;
}

function envOptionConsumesNextToken(token: string): boolean {
	return (
		token === "-u" ||
		token === "--unset" ||
		token === "-C" ||
		token === "--chdir"
	);
}

function isEnvAssignmentToken(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function splitEnvAssignmentToken(token: string): [string, string] {
	const assignmentIndex = token.indexOf("=");
	return [token.slice(0, assignmentIndex), token.slice(assignmentIndex + 1)];
}

async function resolveShebangInterpreterPath(
	manifest: DaemonModuleManifest | TimerModuleManifest,
	env: NodeJS.ProcessEnv,
	lookupExecutable: (
		command: string,
		env: NodeJS.ProcessEnv,
	) => Promise<string | null>,
	realPath: (path: string) => Promise<string>,
	readTextFile: (path: string) => Promise<string>,
): Promise<ResolvedShebangInterpreter | null> {
	let manifestText: string;
	try {
		manifestText = await readTextFile(manifest.execPath);
	} catch {
		return null;
	}

	const firstLine = manifestText.split(/\r?\n/, 1)[0];
	if (!firstLine?.startsWith("#!")) {
		return null;
	}

	const interpreter = parseShebangInterpreter(firstLine.slice(2), env);
	if (!interpreter) {
		return null;
	}

	const interpreterPath = interpreter.command.startsWith("/")
		? interpreter.command
		: await lookupExecutable(interpreter.command, interpreter.env);
	if (!interpreterPath) {
		return null;
	}

	try {
		return {
			lookupPath: interpreterPath,
			realPath: await realPath(interpreterPath),
		};
	} catch {
		return {
			lookupPath: interpreterPath,
			realPath: interpreterPath,
		};
	}
}

function getUniqueShebangInterpreterPaths(
	interpreter: ResolvedShebangInterpreter,
): string[] {
	return [...new Set([interpreter.lookupPath, interpreter.realPath])];
}

function getInterpreterReadonlyMountPath(
	interpreterPath: string,
	moduleDir?: string,
): string {
	const interpreterDir = path.dirname(interpreterPath);
	if (
		interpreterDir === "/" ||
		(moduleDir !== undefined && isPathCovered(moduleDir, [interpreterDir]))
	) {
		return interpreterPath;
	}
	return interpreterDir;
}

function appendReadonlyMount(cmd: string[], mountPath: string): void {
	appendDestinationAncestors(cmd, mountPath);
	cmd.push("--ro-bind", mountPath, mountPath);
}

function appendReadonlyFileMount(cmd: string[], mountPath: string): void {
	appendDestinationAncestors(cmd, path.dirname(mountPath));
	cmd.push("--ro-bind", mountPath, mountPath);
}

function appendWritableMount(cmd: string[], mountPath: string): void {
	appendDestinationAncestors(cmd, mountPath);
	cmd.push("--bind", mountPath, mountPath);
}

function appendDestinationAncestors(
	cmd: string[],
	destinationPath: string,
): void {
	const ancestors = destinationPath
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((_, index, segments) => `/${segments.slice(0, index + 1).join("/")}`);

	for (const ancestor of ancestors) {
		cmd.push("--dir", ancestor);
	}
}

export async function createLinuxBubblewrapCommand(
	bwrapPath: string,
	manifest: DaemonModuleManifest | TimerModuleManifest,
	options: LinuxBubblewrapOptions = {},
): Promise<string[]> {
	const env = options.env ?? process.env;
	const pathExists = options.pathExists ?? defaultPathExists;
	const realPath = options.realPath ?? defaultRealPath;
	const lookupExecutable = options.lookupExecutable ?? defaultLookupExecutable;
	const readTextFile = options.readTextFile ?? defaultReadTextFile;
	const cmd = [
		bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
	];
	const mountedRoots = new Set<string>();

	for (const readonlyPath of LINUX_READONLY_PATHS) {
		if (await pathExists(readonlyPath)) {
			appendReadonlyMount(cmd, readonlyPath);
			mountedRoots.add(readonlyPath);
		}
	}

	if (await pathExists("/etc/resolv.conf")) {
		try {
			const resolverPath = await realPath("/etc/resolv.conf");
			if (!isPathCovered(resolverPath, mountedRoots)) {
				appendReadonlyFileMount(cmd, resolverPath);
				mountedRoots.add(resolverPath);
			}
		} catch {}
	}

	for (const writablePath of [...new Set(["/tmp", manifest.moduleDir])]) {
		if (!(await pathExists(writablePath))) {
			throw new Error(
				`Required writable sandbox path is unavailable: ${writablePath}`,
			);
		}
		appendWritableMount(cmd, writablePath);
		mountedRoots.add(writablePath);
	}

	const interpreter = await resolveShebangInterpreterPath(
		manifest,
		env,
		lookupExecutable,
		realPath,
		readTextFile,
	);
	for (const interpreterPath of interpreter
		? getUniqueShebangInterpreterPaths(interpreter)
		: []) {
		const mountPath = getInterpreterReadonlyMountPath(
			interpreterPath,
			manifest.moduleDir,
		);
		if (
			(await pathExists(mountPath)) &&
			!isPathCovered(interpreterPath, mountedRoots)
		) {
			if (mountPath === interpreterPath) {
				appendReadonlyFileMount(cmd, mountPath);
			} else {
				appendReadonlyMount(cmd, mountPath);
			}
			mountedRoots.add(mountPath);
		}
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

export async function createLinuxWorkspaceBwrapCommand(
	bwrapPath: string,
	workspaceDir: string,
	historyDir: string,
	options: LinuxWorkspaceBwrapOptions = {},
): Promise<string[]> {
	const pathExists = options.pathExists ?? defaultPathExists;
	const realPath = options.realPath ?? defaultRealPath;
	const bindHistoryDir = options.bindHistoryDir ?? true;

	const cmd = [
		bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
	];
	const mountedRoots = new Set<string>();

	for (const readonlyPath of LINUX_READONLY_PATHS) {
		if (await pathExists(readonlyPath)) {
			appendReadonlyMount(cmd, readonlyPath);
			mountedRoots.add(readonlyPath);
		}
	}

	if (await pathExists("/etc/resolv.conf")) {
		try {
			const resolverPath = await realPath("/etc/resolv.conf");
			if (!isPathCovered(resolverPath, mountedRoots)) {
				appendReadonlyFileMount(cmd, resolverPath);
				mountedRoots.add(resolverPath);
			}
		} catch {}
	}

	if (!(await pathExists(workspaceDir))) {
		throw new Error(
			`Required workspace sandbox path is unavailable: ${workspaceDir}`,
		);
	}
	appendWritableMount(cmd, workspaceDir);
	mountedRoots.add(workspaceDir);

	const characterDir = options.characterDir;
	if (
		characterDir !== undefined &&
		characterDir !== "" &&
		(await pathExists(characterDir))
	) {
		appendWritableMount(cmd, characterDir);
		mountedRoots.add(characterDir);
	}

	const modulesRoot = options.modulesRoot;
	if (
		modulesRoot !== undefined &&
		modulesRoot !== "" &&
		(await pathExists(modulesRoot))
	) {
		appendWritableMount(cmd, modulesRoot);
		mountedRoots.add(modulesRoot);
	}

	if (bindHistoryDir) {
		if (await pathExists(historyDir)) {
			appendReadonlyMount(cmd, historyDir);
			mountedRoots.add(historyDir);
		}
	}

	const tmpPath = "/tmp";
	if (!(await pathExists(tmpPath))) {
		throw new Error(
			`Required writable sandbox path is unavailable: ${tmpPath}`,
		);
	}
	appendWritableMount(cmd, tmpPath);
	mountedRoots.add(tmpPath);

	cmd.push("--proc", "/proc", "--dev", "/dev", "--chdir", workspaceDir, "--");

	return cmd;
}

export async function createWorkspaceSandboxBaseCommand(
	workspaceDir: string,
	historyDir: string,
	options: WorkspaceSandboxBaseOptions = {},
): Promise<{
	backend: SandboxBackend;
	cmdPrefix: string[];
	env: NodeJS.ProcessEnv;
}> {
	const platform = options.platform ?? process.platform;
	const envBase = options.env ?? process.env;
	const pathExists = options.pathExists ?? defaultPathExists;
	const lookupExecutable = options.lookupExecutable ?? defaultLookupExecutable;
	const realPath = options.realPath ?? defaultRealPath;
	const characterDir = options.characterDir;
	const modulesRoot = options.modulesRoot;

	const historyExists = await pathExists(historyDir);

	if (platform === "darwin") {
		const env = { ...envBase };
		const sandboxExecPath = await lookupExecutable("sandbox-exec", env);
		if (!sandboxExecPath) {
			throw new Error("sandbox-exec backend is unavailable");
		}
		const profile = createDarwinWorkspaceSandboxProfile(
			workspaceDir,
			historyDir,
			env,
			historyExists,
			characterDir,
			modulesRoot,
		);
		return {
			backend: "sandbox-exec",
			cmdPrefix: [sandboxExecPath, "-p", profile, "--"],
			env,
		};
	}

	if (platform === "linux") {
		const env = { ...envBase, TMPDIR: "/tmp" };
		const bwrapPath = await lookupExecutable("bwrap", env);
		if (!bwrapPath) {
			throw new Error("bwrap backend is unavailable");
		}
		const cmdPrefix = await createLinuxWorkspaceBwrapCommand(
			bwrapPath,
			workspaceDir,
			historyDir,
			{
				pathExists,
				realPath,
				bindHistoryDir: historyExists,
				characterDir,
				modulesRoot,
			},
		);
		return {
			backend: "bwrap",
			cmdPrefix,
			env,
		};
	}

	throw new Error(`Unsupported sandbox platform: ${platform}`);
}

export async function createSandboxLaunchSpec(
	manifest: DaemonModuleManifest | TimerModuleManifest,
	options: SandboxOptions = {},
): Promise<SandboxLaunchSpec> {
	const platform = options.platform ?? process.platform;
	const env =
		platform === "linux"
			? { ...(options.env ?? process.env), TMPDIR: "/tmp" }
			: { ...(options.env ?? process.env) };
	const lookupExecutable = options.lookupExecutable ?? defaultLookupExecutable;
	const pathExists = options.pathExists ?? defaultPathExists;
	const readTextFile = options.readTextFile ?? defaultReadTextFile;
	const realPath = options.realPath ?? defaultRealPath;
	const backend = resolveSandboxBackend(platform);

	if (backend === "sandbox-exec") {
		const sandboxExecPath = await lookupExecutable("sandbox-exec", env);
		if (!sandboxExecPath) {
			throw new Error("sandbox-exec backend is unavailable");
		}
		const extraReadonlyPaths: string[] = [];
		const interpreter = await resolveShebangInterpreterPath(
			manifest,
			env,
			lookupExecutable,
			realPath,
			readTextFile,
		);
		for (const interpreterPath of interpreter
			? getUniqueShebangInterpreterPaths(interpreter)
			: []) {
			const mountPath = getInterpreterReadonlyMountPath(
				interpreterPath,
				manifest.moduleDir,
			);
			if (
				!isPathCovered(interpreterPath, [
					manifest.moduleDir,
					...DARWIN_READONLY_PATHS,
					...getDarwinTempPaths(env),
					...extraReadonlyPaths,
				])
			) {
				extraReadonlyPaths.push(mountPath);
			}
		}

		return {
			backend,
			cmd: [
				sandboxExecPath,
				"-p",
				createDarwinSandboxProfile(manifest.moduleDir, env, extraReadonlyPaths),
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
		cmd: await createLinuxBubblewrapCommand(bwrapPath, manifest, {
			env,
			pathExists,
			realPath,
			lookupExecutable,
			readTextFile,
		}),
		cwd: manifest.moduleDir,
		env,
	};
}
