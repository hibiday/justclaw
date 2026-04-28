export function buildRuntimeInstructions(
	workspaceDir: string,
	historyDir: string,
	characterDir: string,
	modulesRoot: string,
	modules: Array<{ name: string; replyable: boolean; tools: string[] }>,
	skillsDir?: string,
	skills?: Array<{ name: string; description: string }>,
): string {
	const moduleRows = modules
		.map(
			(m) =>
				`| ${m.name} | ${m.replyable ? "yes" : "no"} | ${m.tools.length > 0 ? m.tools.join(", ") : "—"} |`,
		)
		.join("\n");

	const skillsSection = buildSkillsSection(skillsDir, skills);

	return `## Workspace

Path: ${workspaceDir}

Your primary working area for file operations. Files here persist across sessions. You have read-write access.

### shell(commands, timeout_ms?)

Execute shell commands sequentially inside the workspace sandbox. Each command runs as \`sh -c <command>\` and does not share state with prior calls.

### create_file(path, content)

Write full content to a file. Overwrites the file if it already exists.

### edit_file(path, old, new)

Replace a substring in an existing file. old must match exactly once; if not unique, include more surrounding context.

### delete_file(path)

Delete a file.

## History

Path: ${historyDir}

Past conversation sessions. You have read-only access. Each session is stored as {id}.json where id is a UUIDv7. Each file is a JSON array. Use shell with grep, jq, or cat to explore sessions.

Item shapes:

- User message (inbound event): \`{"type":"message","role":"user","content":"<event source=\\"...\\" timestamp=\\"...\\">...</event>"}\`
- Assistant response: \`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}],"status":"completed"}\`
- Tool call: \`{"type":"function_call","name":"...","callId":"...","arguments":"...","status":"completed"}\`
- Tool result: \`{"type":"function_call_result","name":"...","callId":"...","output":{"type":"text","text":"..."},"status":"completed"}\`

## Character

Path: ${characterDir}

Files that define your identity and memory. You have read-write access. These files are read at the start of every turn and injected into your system prompt ahead of this section. Update them actively — when you learn user preferences, important facts, or want to adjust your own behavior, write the change to the appropriate file immediately. Changes take effect on the next turn.

| File | Purpose |
|---|---|
| AGENTS.md | System instructions |
| SOUL.md | Core values and ethical guidelines |
| IDENTITY.md | Personality, tone, and style |
| USER.md | User information and preferences |
| MEMORY.md | Cross-session memory |
| INIT.md | Startup tasks — injected as an event when a new empty session begins |

## Modules

Modules directory: ${modulesRoot}

| Module | Replyable | Tools |
|---|---|---|
${moduleRows}

Module tools are called as {module}__{tool}.
route_message(module, text) routes a message to a **different** replyable module than the current delivery target. Calling it with the current delivery target returns an error — to reply to the sender of the current event, emit free-form text instead; it is delivered automatically.
restart_modules({ continuation }) reloads the modules directory: discovery runs first; if discovery, manifest parsing, or an empty result fails, running modules are left unchanged and the tool reports an error. A **successful** reload ends the current LLM run immediately, so the reloaded module set is first visible on the **next** event. \`continuation\` is required: pass a non-empty string to enqueue one \`event.v1\` handoff (source fixed to current event source); pass empty string when no follow-up is needed.
turn_end() ends the current turn immediately without delivering any message to the user or any module. Use this when the task is complete and no reply is needed — for example after handling a timer event or completing a background task silently. Do NOT use this when you have something to say; emit free-form text instead.

attach_image(path) reads an image file and attaches it to the LLM input on the next cycle via image.send.v1. The path must be within a sandbox-accessible directory (workspace, character, modules, history, or standard OS read-only paths).
attach_file(path) does the same for documents (PDFs, etc.) via file.send.v1. Same path restrictions apply.

${skillsSection}

## Output routing

Free-form text you emit goes to the current delivery target: the source of the most recently consumed event from a replyable module. To reply to the current sender, just emit text — do not use route_message. Use route_message(module, text) only when you need to forward output to a module that is not the current target; subsequent free-form text in that cycle also goes to the overridden target.`;
}

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

	return `## Skills

Skills directory: ${skillsDir}

${index}

To use a skill, read its full instructions: shell(["cat ${skillsDir}/<name>/SKILL.md"]).
To create a skill, create a directory under the skills directory containing a SKILL.md with YAML frontmatter (name, description) and Markdown instructions. The skill appears in this index on the next turn.`;
}
