import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceDir, WorkspaceEditor } from "./workspace";

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

describe("resolveWorkspaceDir", () => {
	test("prefers JUSTCLAW_WORKSPACE", () => {
		const base = "/tmp/jc-home";
		expect(resolveWorkspaceDir(base, "/override/ws", "/Users/x")).toBe(
			path.resolve("/override/ws"),
		);
	});

	test("uses JUSTCLAW_HOME/workspace when override unset", () => {
		const home = "/tmp/jc-home";
		expect(resolveWorkspaceDir(home, undefined, "/Users/x")).toBe(
			path.join(home, "workspace"),
		);
	});

	test("uses ~/justclaw/workspace when only HOME is set", () => {
		expect(resolveWorkspaceDir(undefined, undefined, "/Users/alice")).toBe(
			path.resolve("/Users/alice", "justclaw", "workspace"),
		);
	});

	test("throws when no workspace can be resolved", () => {
		expect(() => resolveWorkspaceDir("", "", "")).toThrow(
			/JUSTCLAW_HOME is not set/,
		);
	});
});

function historyDirForWorkspace(root: string): string {
	return path.join(root, "history");
}

describe("WorkspaceEditor", () => {
	test("rejects path traversal for createFile", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const r = await editor.createFile({
			type: "create_file",
			path: "/etc/passwd",
			diff: "",
		});
		expect(r.status).toBe("failed");
		expect(r.output).toMatch(/escapes workspace/);
	});

	test("createFile writes file content", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const filePath = path.join(root, "hello.txt");
		const r = await editor.createFile({
			type: "create_file",
			path: filePath,
			diff: "hello\n",
		});
		expect(r.status).toBe("completed");
		expect(await Bun.file(filePath).text()).toBe("hello\n");
	});

	test("deleteFile is idempotent for missing files", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const r = await editor.deleteFile({
			type: "delete_file",
			path: path.join(root, "nope.txt"),
		});
		expect(r.status).toBe("completed");
	});

	test("updateFile fails when target is missing", async () => {
		const root = await createTempDir("justclaw-ws-");
		const editor = new WorkspaceEditor(root, historyDirForWorkspace(root));
		const r = await editor.updateFile({
			type: "update_file",
			path: path.join(root, "missing.txt"),
			diff: "",
		});
		expect(r.status).toBe("failed");
		expect(r.output).toMatch(/not found/);
	});
});
