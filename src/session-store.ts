import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentInputItem } from "@openai/agents";
import { Glob } from "bun";

export function resolveHistoryDir(
	justclawHome = process.env.JUSTCLAW_HOME,
	homeDir = process.env.HOME,
): string {
	if (justclawHome) {
		return path.resolve(justclawHome, "history");
	}

	if (!homeDir) {
		throw new Error(
			"HOME is not set and JUSTCLAW_HOME is not set; cannot resolve history directory",
		);
	}

	return path.resolve(homeDir, "justclaw", "history");
}

export class SessionStore {
	static readonly #UUID_RE =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	#historyDir: string;

	constructor(historyDir: string) {
		this.#historyDir = historyDir;
	}

	#filePath(id: string): string {
		if (!SessionStore.#UUID_RE.test(id)) {
			throw new Error(`invalid session id: "${id}"`);
		}
		return path.join(this.#historyDir, `${id}.json`);
	}

	async create(id: string): Promise<void> {
		await Bun.write(this.#filePath(id), "[]");
	}

	async ensureDefaultSessionIfEmpty(): Promise<void> {
		if (this.list().length > 0) {
			return;
		}
		const id = Bun.randomUUIDv7();
		await this.create(id);
		console.error(
			`[core] no session history on disk; created default session ${id}`,
		);
	}

	async load(id: string): Promise<AgentInputItem[] | null> {
		const pathStr = this.#filePath(id);
		const file = Bun.file(pathStr);
		if (!(await file.exists())) {
			return null;
		}
		try {
			const parsed = JSON.parse(await file.text());
			if (!Array.isArray(parsed)) {
				return null;
			}
			return parsed as AgentInputItem[];
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return null;
			}
			console.error(
				`[core] session history unreadable or invalid JSON (${pathStr}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	list(): string[] {
		try {
			const glob = new Glob("*.json");
			const ids: string[] = [];
			for (const name of glob.scanSync({ cwd: this.#historyDir })) {
				const id = name.slice(0, -".json".length);
				if (!SessionStore.#UUID_RE.test(id)) {
					continue;
				}
				try {
					const parsed = JSON.parse(
						readFileSync(path.join(this.#historyDir, name), "utf8"),
					) as unknown;
					if (Array.isArray(parsed)) {
						ids.push(id);
					}
				} catch {
					// unreadable file is not treated as a session
				}
			}
			ids.sort();
			return ids;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
	}

	// Lexicographic maximum of readable UUID session ids; for UUIDv7 that is the most recently generated readable id.
	newestReadableSessionId(): string | null {
		const ids = this.list();
		if (ids.length === 0) {
			return null;
		}
		return ids[ids.length - 1] ?? null;
	}

	async save(id: string, history: AgentInputItem[]): Promise<void> {
		await Bun.write(this.#filePath(id), JSON.stringify(history));
	}

	async delete(id: string): Promise<void> {
		try {
			await Bun.file(this.#filePath(id)).delete();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}
}
