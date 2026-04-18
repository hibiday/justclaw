import { describe, expect, test } from "bun:test";
import { buildRuntimeInstructions } from "./spec";
import { buildSystemPrompt } from "./system-prompt";

describe("buildRuntimeInstructions", () => {
	test("embeds workspace, history, and character paths", () => {
		const text = buildRuntimeInstructions("/tmp/ws", "/tmp/hist", "/tmp/ch");
		expect(text).toContain("Path: /tmp/ws");
		expect(text).toContain("Path: /tmp/hist");
		expect(text).toContain("Path: /tmp/ch");
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
		expect(
			buildSystemPrompt({
				contextInstructions: "alpha",
				workspaceDir: "/w",
				historyDir: "/h",
				characterDir: "/c",
			}),
		).toBe(`alpha\n\n${buildRuntimeInstructions("/w", "/h", "/c")}`);
	});

	test("omits runtime block when any of the path trio is missing", () => {
		expect(
			buildSystemPrompt({
				contextInstructions: "only-ctx",
				workspaceDir: "/w",
				historyDir: "/h",
			}),
		).toBe("only-ctx");
	});
});
