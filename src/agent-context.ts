import path from "node:path";

/**
 * Files read from {@link resolveCharacterDir}'s directory, in order.
 * Each present file is included in the system prompt under a `## FILENAME` heading.
 * The LLM may write back to these files (character dir is rw-mounted in the sandbox).
 */
export const CHARACTER_FILES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"MEMORY.md",
] as const;

export function resolveSkillsDir(
	justclawHome = process.env.JUSTCLAW_HOME,
	override = process.env.JUSTCLAW_SKILLS,
	homeDir = process.env.HOME,
): string {
	if (override) {
		return path.resolve(override);
	}
	if (justclawHome) {
		return path.resolve(justclawHome, "skills");
	}
	if (homeDir) {
		return path.resolve(homeDir, "justclaw", "skills");
	}
	throw new Error(
		"Neither JUSTCLAW_HOME nor HOME is set; cannot resolve skills directory",
	);
}

export function resolveCharacterDir(
	justclawHome = process.env.JUSTCLAW_HOME,
	override = process.env.JUSTCLAW_CHARACTER,
	homeDir = process.env.HOME,
): string {
	if (override) {
		return path.resolve(override);
	}
	if (justclawHome) {
		return path.resolve(justclawHome, "character");
	}
	if (homeDir) {
		return path.resolve(homeDir, "justclaw", "character");
	}
	throw new Error(
		"JUSTCLAW_HOME is not set; cannot resolve character directory",
	);
}

/**
 * Reads `AGENTS.md` from the justclaw home directory (operator-level instructions).
 * Called once at startup so the content is fixed for the lifetime of the process;
 * the agent cannot modify it even if sandbox write paths change in the future.
 * Returns the trimmed content, or an empty string when the file is absent.
 */
export async function loadHomeAgentsFile(homeDir: string): Promise<string> {
	const file = Bun.file(path.join(homeDir, "AGENTS.md"));
	if (!(await file.exists())) {
		return "";
	}
	return (await file.text()).trim();
}

/**
 * Reads present files from {@link CHARACTER_FILES} under `characterDir`.
 * Each non-empty file becomes a `## FILENAME\n<content>` section.
 * Sections are joined with a blank line. Missing files are silently skipped;
 * other read errors propagate.
 */
export async function loadAgentContext(characterDir: string): Promise<string> {
	const sections: string[] = [];
	for (const filename of CHARACTER_FILES) {
		const file = Bun.file(path.join(characterDir, filename));
		if (!(await file.exists())) {
			continue;
		}
		const trimmed = (await file.text()).trim();
		if (trimmed) {
			sections.push(`## ${filename}\n${trimmed}`);
		}
	}
	return sections.join("\n\n");
}

/**
 * Parses YAML frontmatter from a SKILL.md file.
 * Splits only on the first colon per line so unquoted values containing colons
 * are handled correctly. Quoted values have their surrounding quotes stripped.
 * Returns null when the file does not begin with a valid `---` block.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
	if (!content.startsWith("---")) return null;
	const firstNewline = content.indexOf("\n");
	if (firstNewline === -1) return null;
	const rest = content.slice(firstNewline + 1);
	const closingMatch = rest.match(/^---[ \t]*$/m);
	if (!closingMatch || closingMatch.index === undefined) return null;
	const yaml = rest.slice(0, closingMatch.index);
	const result: Record<string, string> = {};
	for (const line of yaml.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) result[key] = value;
	}
	return result;
}

/**
 * Scans `skillsDir` for subdirectories containing a `SKILL.md` file and returns
 * the name and description from each skill's frontmatter.
 * Skills without a description are skipped. Parse errors are warned and skipped.
 */
export async function loadSkillsIndex(
	skillsDir: string,
): Promise<Array<{ name: string; description: string }>> {
	const skills: Array<{ name: string; description: string }> = [];
	const glob = new Bun.Glob("*/SKILL.md");
	for await (const relPath of glob.scan({ cwd: skillsDir, onlyFiles: true })) {
		const skillMdPath = path.join(skillsDir, relPath);
		let content: string;
		try {
			content = await Bun.file(skillMdPath).text();
		} catch {
			continue;
		}
		const fm = parseFrontmatter(content);
		if (!fm) {
			console.warn(`[skills] ${skillMdPath}: could not parse frontmatter`);
			continue;
		}
		if (!fm.description) {
			console.warn(`[skills] ${skillMdPath}: missing description, skipping`);
			continue;
		}
		const dirName = path.basename(path.dirname(skillMdPath));
		if (fm.name && fm.name !== dirName) {
			console.warn(
				`[skills] ${skillMdPath}: name "${fm.name}" does not match directory "${dirName}"; using directory name`,
			);
		}
		skills.push({ name: dirName, description: fm.description });
	}
	return skills;
}
