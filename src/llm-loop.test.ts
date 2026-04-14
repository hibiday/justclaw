import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Runner } from "@openai/agents";
import { EventQueue, timestampFromUUIDv7 } from "./event-queue";
import { runLlmLoop } from "./llm-loop";
import type { StartedDaemon } from "./runtime";

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

describe("runLlmLoop", () => {
	test("notifies event.dropped.v1 when the runner throws", async () => {
		const home = await createTempDir("justclaw-llm-");
		const dbPath = path.join(home, "events.db");
		const queue = new EventQueue(dbPath);
		const params = { type: "event.v1" as const, kind: "test" };
		queue.enqueue("srcmod", params);

		const db = new Database(dbPath);
		const row = db
			.query("SELECT id FROM events WHERE state = 'pending'")
			.get() as { id: string };
		db.close();
		expect(row?.id).toBeDefined();

		const recorded: { method: string; params: unknown }[] = [];
		const daemons = [
			{
				manifest: { name: "srcmod" },
				tools: [],
				peer: {
					notify: (method: string, p: unknown) => {
						recorded.push({ method, params: p });
					},
					request: async () => ({}),
				},
			},
		] as unknown as StartedDaemon[];

		const mockRunner = {
			run: async () => {
				throw new Error("LLM failed");
			},
		} as unknown as Runner;

		const loopTask = runLlmLoop(queue, daemons, "test-model", {
			runner: mockRunner,
		});

		for (let i = 0; i < 50; i += 1) {
			if (recorded.length > 0) {
				break;
			}
			await delay(10);
		}

		queue.close();
		await loopTask;

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.method).toBe("event");
		const payload = recorded[0]?.params as {
			type: string;
			source: string;
			timestamp: string;
			params: typeof params;
		};
		expect(payload.type).toBe("event.dropped.v1");
		expect(payload.source).toBe("srcmod");
		expect(payload.params).toEqual(params);
		expect(payload.timestamp).toBe(timestampFromUUIDv7(row.id));
	});
});
