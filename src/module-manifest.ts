import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type RawManifest = {
	name?: unknown;
	exec?: unknown;
	mode?: unknown;
};

export type DaemonModuleManifest = {
	name: string;
	mode: "daemon";
	exec: string;
	moduleDir: string;
	execPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function resolveModulesRoot(homeDir = process.env.HOME): string {
	if (!homeDir) {
		throw new Error("HOME is not set; cannot resolve runtime module directory");
	}

	return path.join(homeDir, "justclaw", "modules");
}

export async function discoverDaemonManifests(
	modulesRoot: string,
): Promise<DaemonModuleManifest[]> {
	let entries: string[];
	try {
		entries = await readdir(modulesRoot);
	} catch (error) {
		throw new Error(
			`Failed to read runtime modules directory ${modulesRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const manifests = await Promise.all(
		entries.map(async (entry) => {
			const moduleDir = path.join(modulesRoot, entry);
			const manifestPath = path.join(moduleDir, "module.json");
			const manifestText = await readFile(manifestPath, "utf8").catch(
				(error) => {
					throw new Error(
						`Failed to read manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
					);
				},
			);

			return parseDaemonManifest(moduleDir, entry, manifestText);
		}),
	);

	return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseDaemonManifest(
	moduleDir: string,
	directoryName: string,
	manifestText: string,
): DaemonModuleManifest {
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

	const { name, exec, mode } = parsed satisfies RawManifest;

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

	if (mode !== "daemon") {
		if (mode === "timer") {
			throw new Error(`Timer modules are not implemented yet: ${name}`);
		}
		throw new Error(
			`Manifest ${path.join(moduleDir, "module.json")} must declare mode "daemon"`,
		);
	}

	return {
		name,
		mode: "daemon",
		exec,
		moduleDir,
		execPath: path.resolve(moduleDir, exec),
	};
}
