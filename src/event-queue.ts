import { Database } from "bun:sqlite";
import path from "node:path";

export type QueuedEvent = {
	id: string;
	source: string;
	params: Record<string, unknown> & { type: "event.v1" };
};

export function timestampFromUUIDv7(uuid: string): string {
	return new Date(
		parseInt(uuid.replace(/-/g, "").slice(0, 12), 16),
	).toISOString();
}

export function resolveEventQueuePath(
	justclawHome = process.env.JUSTCLAW_HOME,
	homeDir = process.env.HOME,
): string {
	if (justclawHome) {
		return path.resolve(justclawHome, "events.db");
	}

	if (!homeDir) {
		throw new Error(
			"HOME is not set and JUSTCLAW_HOME is not set; cannot resolve event queue path",
		);
	}

	return path.resolve(homeDir, "justclaw", "events.db");
}

type Waiter = (value: QueuedEvent | undefined) => void;

export class EventQueue {
	#db: Database;
	#closed = false;
	#waiter: Waiter | null = null;

	constructor(dbPath: string) {
		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA journal_mode=WAL;");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				id            TEXT PRIMARY KEY,
				source        TEXT NOT NULL,
				params        TEXT NOT NULL,
				state         TEXT NOT NULL DEFAULT 'pending',
				running_since TEXT
			);
		`);
	}

	enqueue(
		source: string,
		params: Record<string, unknown> & { type: "event.v1" },
	): void {
		if (this.#closed) {
			return;
		}

		const id = Bun.randomUUIDv7();
		const paramsJson = JSON.stringify(params);
		const waiter = this.#waiter;
		if (waiter) {
			const runningSince = new Date().toISOString();
			this.#db.run(
				"INSERT INTO events (id, source, params, state, running_since) VALUES (?, ?, ?, 'running', ?)",
				[id, source, paramsJson, runningSince],
			);
			this.#waiter = null;
			waiter({ id, source, params });
		} else {
			this.#db.run("INSERT INTO events (id, source, params) VALUES (?, ?, ?)", [
				id,
				source,
				paramsJson,
			]);
		}
	}

	async next(): Promise<QueuedEvent | undefined> {
		if (this.#closed) {
			return undefined;
		}

		const row = this.#db
			.query(
				"SELECT id, source, params FROM events WHERE state = 'pending' ORDER BY id ASC LIMIT 1",
			)
			.get() as { id: string; source: string; params: string } | null;

		if (row) {
			const runningSince = new Date().toISOString();
			this.#db.run(
				"UPDATE events SET state = 'running', running_since = ? WHERE id = ?",
				[runningSince, row.id],
			);
			return {
				id: row.id,
				source: row.source,
				params: JSON.parse(row.params) as QueuedEvent["params"],
			};
		}

		if (this.#closed) {
			return undefined;
		}

		return new Promise<QueuedEvent | undefined>((resolve) => {
			if (this.#closed) {
				resolve(undefined);
				return;
			}
			this.#waiter = resolve;
		});
	}

	complete(id: string): void {
		this.#db.run("DELETE FROM events WHERE id = ?", [id]);
	}

	stale(): QueuedEvent[] {
		const rows = this.#db
			.query(
				"SELECT id, source, params FROM events WHERE state = 'running' ORDER BY id ASC",
			)
			.all() as { id: string; source: string; params: string }[];

		return rows.map((row) => ({
			id: row.id,
			source: row.source,
			params: JSON.parse(row.params) as QueuedEvent["params"],
		}));
	}

	close(): void {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = null;
			waiter(undefined);
		}
		this.#db.close();
	}
}
