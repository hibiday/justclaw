import { buildRuntimeInstructions } from "./spec";

export function buildSystemPrompt(options: {
	contextInstructions?: string;
	workspaceDir?: string;
	historyDir?: string;
	characterDir?: string;
}): string {
	const runtimeBlock =
		options.workspaceDir !== undefined &&
		options.historyDir !== undefined &&
		options.characterDir !== undefined
			? buildRuntimeInstructions(
					options.workspaceDir,
					options.historyDir,
					options.characterDir,
				)
			: undefined;
	return [options.contextInstructions, runtimeBlock]
		.filter((s) => s !== undefined && s !== "")
		.join("\n\n");
}
