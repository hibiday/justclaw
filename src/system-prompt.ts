import { buildRuntimeInstructions } from "./spec";

export function buildSystemPrompt(options: {
	contextInstructions?: string;
	workspaceDir?: string;
	historyDir?: string;
	characterDir?: string;
	modulesRoot?: string;
	modules?: Array<{ name: string; replyable: boolean; tools: string[] }>;
}): string {
	const runtimeBlock =
		options.workspaceDir !== undefined &&
		options.historyDir !== undefined &&
		options.characterDir !== undefined &&
		options.modulesRoot !== undefined &&
		options.modules !== undefined
			? buildRuntimeInstructions(
					options.workspaceDir,
					options.historyDir,
					options.characterDir,
					options.modulesRoot,
					options.modules,
				)
			: undefined;
	return [options.contextInstructions, runtimeBlock]
		.filter((s) => s !== undefined && s !== "")
		.join("\n\n");
}
