import { describe, expect, test } from "bun:test";
import { buildRuntimeInstructions } from "./spec";
import { buildSystemPrompt } from "./system-prompt";

describe("buildRuntimeInstructions", () => {
	test("embeds workspace, history, character, and modules paths", () => {
		const text = buildRuntimeInstructions("/tmp/ws", "/tmp/hist", "/tmp/ch", "/tmp/mods", [
			{ name: "cli-chat", replyable: true, tools: ["send"] },
			{ name: "watcher", replyable: false, tools: [] },
		]);
		expect(text).toContain("Path: /tmp/ws");
		expect(text).toContain("Path: /tmp/hist");
		expect(text).toContain("Path: /tmp/ch");
		expect(text).toContain("Modules directory: /tmp/mods");
		expect(text).toContain("| cli-chat | yes | send |");
		expect(text).toContain("| watcher | no | — |");
	});
});

describe("buildSystemPrompt", () => {
	test("returns empty string when both inputs are absent", () => {
		expect(buildSystemPrompt({})).toBe("");
	});

	test("omits undefined and empty string parts", () => {
		expect(buildSystemPrompt({ contextInstructions: "" })).toBe("");
		expect(
			buildSystemPrompt({
				contextInstructions: "ctx",
			}),
		).toBe("ctx");
	});

	test("joins context and runtime with a blank line when all path options are set", () => {
		const modules: Array<{ name: string; replyable: boolean; tools: string[] }> =
			[];
		expect(
			buildSystemPrompt({
				contextInstructions: "alpha",
				workspaceDir: "/w",
				historyDir: "/h",
				characterDir: "/c",
				modulesRoot: "/m",
				modules,
			}),
		).toBe(`alpha\n\n${buildRuntimeInstructions("/w", "/h", "/c", "/m", modules)}`);
	});

	test("omits runtime block when any required path or module metadata is missing", () => {
		expect(
			buildSystemPrompt({
				contextInstructions: "only-ctx",
				workspaceDir: "/w",
				historyDir: "/h",
				characterDir: "/c",
			}),
		).toBe("only-ctx");
	});
});
