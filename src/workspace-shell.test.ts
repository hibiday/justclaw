import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("WorkspaceShell with mocked sandbox base command", () => {
	test("invokes createWorkspaceSandboxBaseCommand and runs sh -c", async () => {
		const createWorkspaceSandboxBaseCommand = mock(() =>
			Promise.resolve({
				backend: "bwrap" as const,
				cmdPrefix: [] as string[],
				env: process.env as NodeJS.ProcessEnv,
			}),
		);

		mock.module("./sandbox", () => ({
			createWorkspaceSandboxBaseCommand,
		}));

		const { WorkspaceShell } = await import("./workspace");
		const root = await mkdtemp(path.join(os.tmpdir(), "justclaw-sh-"));
		const hist = path.join(root, "h");
		await mkdir(hist, { recursive: true });
		try {
			const shell = new WorkspaceShell(root, hist, "linux");
			const result = await shell.run({ commands: ["echo marker"] });
			expect(result.output).toHaveLength(1);
			expect(result.output[0]?.stdout.trim()).toBe("marker");
			expect(result.output[0]?.outcome).toEqual({ type: "exit", exitCode: 0 });
			expect(
				createWorkspaceSandboxBaseCommand.mock.calls.length,
			).toBeGreaterThan(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
