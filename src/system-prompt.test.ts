import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt", () => {
	test("returns empty string when both inputs are absent", () => {
		expect(buildSystemPrompt({})).toBe("");
	});

	test("omits undefined and empty string parts", () => {
		expect(
			buildSystemPrompt({
				contextInstructions: "",
				workspaceInstructions: "ws only",
			}),
		).toBe("ws only");
		expect(
			buildSystemPrompt({
				contextInstructions: "ctx",
				workspaceInstructions: "",
			}),
		).toBe("ctx");
	});

	test("joins context then workspace with a single newline", () => {
		expect(
			buildSystemPrompt({
				contextInstructions: "alpha",
				workspaceInstructions: "beta",
			}),
		).toBe("alpha\nbeta");
	});
});
