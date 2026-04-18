import { readFile } from "node:fs/promises";
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
 * Reads present files from {@link CHARACTER_FILES} under `characterDir`.
 * Each non-empty file becomes a `## FILENAME\n<content>` section.
 * Sections are joined with a blank line. Missing files are silently skipped;
 * other read errors propagate.
 */
export async function loadAgentContext(characterDir: string): Promise<string> {
	const sections: string[] = [];
	for (const filename of CHARACTER_FILES) {
		const filePath = path.join(characterDir, filename);
		try {
			const text = await readFile(filePath, "utf8");
			const trimmed = text.trim();
			if (trimmed) {
				sections.push(`## ${filename}\n${trimmed}`);
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				continue;
			}
			throw e;
		}
	}
	return sections.join("\n\n");
}
