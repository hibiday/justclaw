// The static prose of the runtime instructions lives in sibling Markdown
// templates (`runtime-prompt.md`, `runtime-skills.md`) so it can be read
// and reviewed as prose rather than buried in a TS string literal. This module
// only fills the dynamic parts (resolved paths, the live module table, the
// skills index) into those templates. Templates are imported as text, so the
// bundler inlines them and no runtime file I/O is needed.
import mainTemplate from "./runtime-prompt.md" with { type: "text" };
import skillsTemplate from "./runtime-skills.md" with { type: "text" };

// Replace each `{{KEY}}` token with its value. The replacement is passed as a
// function so `$`-sequences in dynamic values (paths, descriptions) are treated
// literally rather than as replacement patterns.
function interpolate(template: string, values: Record<string, string>): string {
	let out = template;
	for (const [key, value] of Object.entries(values)) {
		out = out.replaceAll(`{{${key}}}`, () => value);
	}
	return out;
}

export function buildRuntimeInstructions(
	workspaceDir: string,
	historyDir: string,
	characterDir: string,
	modulesRoot: string,
	modules: Array<{ name: string; replyable: boolean; tools: string[] }>,
	skillsDir?: string,
	skills?: Array<{ name: string; description: string }>,
): string {
	const moduleTable = modules
		.map(
			(m) =>
				`| ${m.name} | ${m.replyable ? "yes" : "no"} | ${m.tools.length > 0 ? m.tools.join(", ") : "—"} |`,
		)
		.join("\n");

	return interpolate(mainTemplate.trimEnd(), {
		WORKSPACE_DIR: workspaceDir,
		HISTORY_DIR: historyDir,
		CHARACTER_DIR: characterDir,
		MODULES_ROOT: modulesRoot,
		MODULE_TABLE: moduleTable,
		SKILLS_SECTION: buildSkillsSection(skillsDir, skills),
	});
}

// The skills section has two structurally different renderings (configured vs.
// not), so its prose lives in its own template and the rare unconfigured case
// stays a one-line literal here rather than forcing conditionals into the
// template.
function buildSkillsSection(
	skillsDir: string | undefined,
	skills: Array<{ name: string; description: string }> | undefined,
): string {
	if (!skillsDir) {
		return "## Skills\n\nNo skills directory configured.";
	}

	const index =
		skills && skills.length > 0
			? `| Skill | Description |\n|---|---|\n${skills.map((s) => `| ${s.name} | ${s.description} |`).join("\n")}`
			: "No skills installed.";

	return interpolate(skillsTemplate.trimEnd(), {
		SKILLS_DIR: skillsDir,
		SKILLS_INDEX: index,
	});
}
