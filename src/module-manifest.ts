import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type RawManifest = {
	name?: unknown;
	exec?: unknown;
	mode?: unknown;
	replyable?: unknown;
	cron?: unknown;
};

export type DaemonModuleManifest = {
	name: string;
	mode: "daemon";
	exec: string;
	moduleDir: string;
	execPath: string;
	replyable: boolean;
};

export type TimerModuleManifest = {
	name: string;
	mode: "timer";
	exec: string;
	moduleDir: string;
	execPath: string;
	cron: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function resolveModuleExecPath(moduleDir: string, exec: string): string {
	if (path.isAbsolute(exec)) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} "exec" must be relative to the module directory`,
		);
	}

	const resolvedExecPath = path.resolve(moduleDir, exec);
	const relativeExecPath = path.relative(moduleDir, resolvedExecPath);
	if (
		relativeExecPath === "" ||
		relativeExecPath === ".." ||
		relativeExecPath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeExecPath)
	) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} "exec" must stay inside the module directory`,
		);
	}

	return resolvedExecPath;
}

export function resolveModulesRoot(
	justclawHome = process.env.JUSTCLAW_HOME,
	homeDir = process.env.HOME,
): string {
	if (justclawHome) {
		return path.resolve(justclawHome, "modules");
	}

	if (!homeDir) {
		throw new Error(
			"HOME is not set and JUSTCLAW_HOME is not set; cannot resolve runtime module directory",
		);
	}

	return path.resolve(homeDir, "justclaw", "modules");
}

export async function discoverDaemonManifests(
	modulesRoot: string,
): Promise<DaemonModuleManifest[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(modulesRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`No modules directory found at ${modulesRoot}`);
		}

		throw new Error(
			`Failed to read runtime modules directory ${modulesRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const manifests = await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isDirectory()) {
				return null;
			}

			const moduleDir = path.join(modulesRoot, entry.name);
			const manifestPath = path.join(moduleDir, "module.json");
			const manifestText = await readFile(manifestPath, "utf8").catch(
				(error) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return null;
					}

					throw new Error(
						`Failed to read manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
					);
				},
			);

			if (manifestText === null) {
				return null;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(manifestText);
			} catch {
				throw new Error(
					`Manifest ${path.join(moduleDir, "module.json")} is not valid JSON`,
				);
			}

			if (!isRecord(parsed)) {
				throw new Error(
					`Manifest ${path.join(moduleDir, "module.json")} must be a JSON object`,
				);
			}

			if (parsed.mode === "timer") {
				return null;
			}

			return parseDaemonManifest(moduleDir, entry.name, parsed);
		}),
	);

	return manifests
		.filter((manifest) => manifest !== null)
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseDaemonManifest(
	moduleDir: string,
	directoryName: string,
	parsed: unknown,
): DaemonModuleManifest {
	if (!isRecord(parsed)) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must be a JSON object`,
		);
	}

	const { name, exec, mode, replyable } = parsed satisfies RawManifest;

	if (typeof name !== "string" || name.length === 0) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must contain a non-empty string "name"`,
		);
	}

	if (name !== directoryName) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} name must match directory "${directoryName}"`,
		);
	}

	if (typeof exec !== "string" || exec.length === 0) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must contain a non-empty string "exec"`,
		);
	}

	const execPath = resolveModuleExecPath(moduleDir, exec);

	if (mode !== "daemon") {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must declare mode "daemon"`,
		);
	}

	return {
		name,
		mode: "daemon",
		exec,
		moduleDir,
		execPath,
		replyable: replyable === true,
	};
}

export function parseTimerManifest(
	moduleDir: string,
	directoryName: string,
	parsed: unknown,
): TimerModuleManifest {
	if (!isRecord(parsed)) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must be a JSON object`,
		);
	}

	const { name, exec, mode, cron } = parsed satisfies RawManifest;

	if (typeof name !== "string" || name.length === 0) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must contain a non-empty string "name"`,
		);
	}

	if (name !== directoryName) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} name must match directory "${directoryName}"`,
		);
	}

	if (typeof exec !== "string" || exec.length === 0) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must contain a non-empty string "exec"`,
		);
	}

	const execPath = resolveModuleExecPath(moduleDir, exec);

	if (mode !== "timer") {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must declare mode "timer"`,
		);
	}

	if (typeof cron !== "string" || cron.length === 0) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must contain a non-empty string "cron"`,
		);
	}

	let cronValid: boolean;
	try {
		cronValid = Bun.cron.parse(cron, new Date()) !== null;
	} catch {
		cronValid = false;
	}
	if (!cronValid) {
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} "cron" is not a valid cron expression or has no upcoming occurrences: "${cron}"`,
		);
	}

	return {
		name,
		mode: "timer",
		exec,
		moduleDir,
		execPath,
		cron,
	};
}

export async function discoverTimerManifests(
	modulesRoot: string,
): Promise<TimerModuleManifest[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(modulesRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`No modules directory found at ${modulesRoot}`);
		}

		throw new Error(
			`Failed to read runtime modules directory ${modulesRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const manifests = await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isDirectory()) {
				return null;
			}

			const moduleDir = path.join(modulesRoot, entry.name);
			const manifestPath = path.join(moduleDir, "module.json");
			const manifestText = await readFile(manifestPath, "utf8").catch(
				(error) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						return null;
					}

					throw new Error(
						`Failed to read manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
					);
				},
			);

			if (manifestText === null) {
				return null;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(manifestText);
			} catch {
				throw new Error(`Manifest ${manifestPath} is not valid JSON`);
			}

			if (!isRecord(parsed) || parsed.mode !== "timer") {
				return null;
			}

			return parseTimerManifest(moduleDir, entry.name, parsed);
		}),
	);

	return manifests
		.filter((manifest) => manifest !== null)
		.sort((left, right) => left.name.localeCompare(right.name));
}
