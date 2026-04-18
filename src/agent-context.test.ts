import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAgentContext, resolveCharacterDir } from "./agent-context";

describe("resolveCharacterDir", () => {
	test("uses JUSTCLAW_CHARACTER when set", () => {
		expect(
			resolveCharacterDir("/jc/home", "/override/character", "/home/user"),
		).toBe(path.resolve("/override/character"));
	});

	test("uses JUSTCLAW_HOME/character when home is set but override is not", () => {
		expect(resolveCharacterDir("/jc/home", undefined, "/home/user")).toBe(
			path.resolve("/jc/home", "character"),
		);
	});

	test("falls back to ~/justclaw/character", () => {
		expect(resolveCharacterDir(undefined, undefined, "/home/me")).toBe(
			path.resolve("/home/me", "justclaw", "character"),
		);
	});

	test("throws when no path can be resolved", () => {
		expect(() => resolveCharacterDir("", "", "")).toThrow(
			/cannot resolve character directory/,
		);
	});
});

describe("loadAgentContext", () => {
	test("returns empty string when no character files exist", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "justclaw-ch-"));
		try {
			expect(await loadAgentContext(dir)).toBe("");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns a single ## FILENAME section when only one file exists", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "justclaw-ch-"));
		try {
			await Bun.write(path.join(dir, "SOUL.md"), "  line one\nline two  \n");
			expect(await loadAgentContext(dir)).toBe(
				"## SOUL.md\nline one\nline two",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("joins multiple present files with \\n\\n in CHARACTER_FILES order", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "justclaw-ch-"));
		try {
			await Bun.write(path.join(dir, "AGENTS.md"), "first");
			await Bun.write(path.join(dir, "MEMORY.md"), "last");
			expect(await loadAgentContext(dir)).toBe(
				"## AGENTS.md\nfirst\n\n## MEMORY.md\nlast",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("skips missing files and orders by CHARACTER_FILES, not write order", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "justclaw-ch-"));
		try {
			// USER.md before AGENTS.md on disk; output must still be AGENTS then USER.
			await Bun.write(path.join(dir, "USER.md"), "user block");
			await Bun.write(path.join(dir, "AGENTS.md"), "agents block");
			expect(await loadAgentContext(dir)).toBe(
				"## AGENTS.md\nagents block\n\n## USER.md\nuser block",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("omits sections when trim leaves the file empty", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "justclaw-ch-"));
		try {
			await Bun.write(path.join(dir, "IDENTITY.md"), "   \n\t  ");
			await Bun.write(path.join(dir, "USER.md"), "kept");
			expect(await loadAgentContext(dir)).toBe("## USER.md\nkept");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns empty string when every present file trims to empty", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "justclaw-ch-"));
		try {
			await Bun.write(path.join(dir, "SOUL.md"), "  \n  ");
			expect(await loadAgentContext(dir)).toBe("");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("outputs SOUL, IDENTITY, MEMORY in that order when AGENTS and USER are missing", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "justclaw-ch-"));
		try {
			await Bun.write(path.join(dir, "MEMORY.md"), "m");
			await Bun.write(path.join(dir, "IDENTITY.md"), "i");
			await Bun.write(path.join(dir, "SOUL.md"), "s");
			// AGENTS.md and USER.md missing
			expect(await loadAgentContext(dir)).toBe(
				"## SOUL.md\ns\n\n## IDENTITY.md\ni\n\n## MEMORY.md\nm",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
