import { buildRuntimeInstructions } from "./spec";

function buildSkillsBlock(
	skillsDir: string | undefined,
	skills: Array<{ name: string; description: string }> | undefined,
): string | undefined {
	if (!skillsDir) return undefined;

	const index =
		skills && skills.length > 0
			? `| Skill | Description |\n|---|---|\n${skills.map((s) => `| ${s.name} | ${s.description} |`).join("\n")}`
			: "No skills installed.";

	return `## Skills

Skills directory: ${skillsDir}

${index}

To use a skill, read its full instructions: shell(["cat ${skillsDir}/<name>/SKILL.md"]).
To create a skill, create a directory under the skills directory containing a SKILL.md with YAML frontmatter (name, description) and Markdown instructions. The skill appears in this index on the next turn.`;
}

export function buildSystemPrompt(options: {
	contextInstructions?: string;
	workspaceDir?: string;
	historyDir?: string;
	characterDir?: string;
	modulesRoot?: string;
	modules?: Array<{ name: string; replyable: boolean; tools: string[] }>;
	skillsDir?: string;
	skills?: Array<{ name: string; description: string }>;
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
	const skillsBlock = buildSkillsBlock(options.skillsDir, options.skills);
	return [options.contextInstructions, runtimeBlock, skillsBlock]
		.filter((s) => s !== undefined && s !== "")
		.join("\n\n");
}
