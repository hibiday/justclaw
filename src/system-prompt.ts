export function buildSystemPrompt(options: {
	contextInstructions?: string;
	workspaceInstructions?: string;
}): string {
	return [options.contextInstructions, options.workspaceInstructions]
		.filter((s) => s !== undefined && s !== "")
		.join("\n");
}
