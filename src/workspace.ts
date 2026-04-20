import path from "node:path";
import {
	type ApplyPatchOperation,
	type ApplyPatchResult,
	type Shell,
	type ShellAction,
	type ShellOutputResult,
	type ShellResult,
	type Tool,
	tool,
} from "@openai/agents";
import { createWorkspaceSandboxBaseCommand } from "./sandbox";

export function resolveWorkspaceDir(
	justclawHome = process.env.JUSTCLAW_HOME,
	override = process.env.JUSTCLAW_WORKSPACE,
	homeDir = process.env.HOME,
): string {
	if (override) {
		return path.resolve(override);
	}
	if (justclawHome) {
		return path.resolve(justclawHome, "workspace");
	}
	if (homeDir) {
		return path.resolve(homeDir, "justclaw", "workspace");
	}
	throw new Error(
		"JUSTCLAW_HOME is not set; cannot resolve workspace directory",
	);
}

function truncateStreams(
	stdout: string,
	stderr: string,
	maxLen: number,
): { stdout: string; stderr: string; truncated: boolean } {
	const total = stdout.length + stderr.length;
	if (total <= maxLen) {
		return { stdout, stderr, truncated: false };
	}
	let budget = maxLen;
	let outS = "";
	if (budget > 0 && stdout.length > 0) {
		const take = Math.min(stdout.length, budget);
		outS = stdout.slice(0, take);
		budget -= take;
	}
	let errS = "";
	if (budget > 0 && stderr.length > 0) {
		errS = stderr.slice(0, budget);
	}
	return { stdout: outS, stderr: errS, truncated: true };
}

export class WorkspaceShell implements Shell {
	readonly #workspaceDir: string;
	readonly #historyDir: string;
	readonly #platform: NodeJS.Platform;
	readonly #characterDir?: string;
	readonly #modulesRoot?: string;

	constructor(
		workspaceDir: string,
		historyDir: string,
		platform: NodeJS.Platform = process.platform,
		characterDir?: string,
		modulesRoot?: string,
	) {
		this.#workspaceDir = workspaceDir;
		this.#historyDir = historyDir;
		this.#platform = platform;
		this.#characterDir = characterDir;
		this.#modulesRoot = modulesRoot;
	}

	async run(action: ShellAction): Promise<ShellResult> {
		const output: ShellOutputResult[] = [];
		let anyTruncated = false;
		const timeoutMs = action.timeoutMs ?? 30_000;
		const maxOutputLength = action.maxOutputLength;

		for (const command of action.commands) {
			const spec = await createWorkspaceSandboxBaseCommand(
				this.#workspaceDir,
				this.#historyDir,
				{
					platform: this.#platform,
					characterDir: this.#characterDir,
					modulesRoot: this.#modulesRoot,
				},
			);
			const cmd = [...spec.cmdPrefix, "sh", "-c", command];
			const proc = Bun.spawn({
				cmd,
				cwd: this.#workspaceDir,
				stdout: "pipe",
				stderr: "pipe",
				env: spec.env,
			});

			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
			});
			const race = await Promise.race([
				proc.exited.then(() => "exited" as const),
				timeoutPromise,
			]);
			clearTimeout(timeoutHandle);

			let stdoutText: string;
			let stderrText: string;
			if (race === "timeout") {
				proc.kill("SIGKILL");
				await proc.exited;
				stdoutText = await new Response(proc.stdout).text();
				stderrText = await new Response(proc.stderr).text();
				let truncated = false;
				if (maxOutputLength !== undefined) {
					const t = truncateStreams(stdoutText, stderrText, maxOutputLength);
					stdoutText = t.stdout;
					stderrText = t.stderr;
					truncated = t.truncated;
				}
				if (truncated) {
					anyTruncated = true;
				}
				output.push({
					stdout: stdoutText,
					stderr: stderrText,
					outcome: { type: "timeout" },
				});
				continue;
			}

			stdoutText = await new Response(proc.stdout).text();
			stderrText = await new Response(proc.stderr).text();
			if (maxOutputLength !== undefined) {
				const t = truncateStreams(stdoutText, stderrText, maxOutputLength);
				stdoutText = t.stdout;
				stderrText = t.stderr;
				if (t.truncated) {
					anyTruncated = true;
				}
			}

			output.push({
				stdout: stdoutText,
				stderr: stderrText,
				outcome: {
					type: "exit",
					exitCode: proc.exitCode,
				},
			});
		}

		return {
			output,
			...(anyTruncated && action.maxOutputLength !== undefined
				? { maxOutputLength: action.maxOutputLength }
				: {}),
		};
	}
}

// Path boundary enforcement is delegated to the platform sandbox (bwrap / sandbox-exec).
// The sandbox grants rw access to the workspace, character, and modules directories, and the kernel
// enforces it. createFile and deleteFile run inside the sandbox for the same reason as
// editFile (string replace then runCreateFile): host-side Bun.write / Bun.file().delete() bypass that enforcement.

async function runCreateFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	content: string,
	characterDir?: string,
	modulesRoot?: string,
): Promise<{ ok: boolean; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot },
	);
	// Pass dirname and path as positional args to avoid shell-quoting the values.
	const proc = Bun.spawn({
		cmd: [
			...spec.cmdPrefix,
			"sh",
			"-c",
			'mkdir -p "$1" && cat > "$2"',
			"--",
			path.dirname(absPath),
			absPath,
		],
		cwd: workspaceDir,
		stdin: new TextEncoder().encode(content),
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	return { ok: proc.exitCode === 0, stderr };
}

async function runDeleteFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	characterDir?: string,
	modulesRoot?: string,
): Promise<{ ok: boolean; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot },
	);
	const proc = Bun.spawn({
		cmd: [...spec.cmdPrefix, "rm", absPath],
		cwd: workspaceDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	return { ok: proc.exitCode === 0, stderr };
}

async function runReadFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	characterDir?: string,
	modulesRoot?: string,
): Promise<{ ok: boolean; content: string; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot },
	);
	const proc = Bun.spawn({
		cmd: [...spec.cmdPrefix, "cat", absPath],
		cwd: workspaceDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const [content, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { ok: proc.exitCode === 0, content, stderr };
}

/** Like {@link runReadFile}, but returns raw file bytes as a single-line base64 string via sandboxed `base64`. */
export async function runReadFileBase64(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	characterDir?: string,
	modulesRoot?: string,
): Promise<{ ok: boolean; content: string; stderr: string }> {
	const spec = await createWorkspaceSandboxBaseCommand(
		workspaceDir,
		historyDir,
		{ platform, characterDir, modulesRoot },
	);
	const proc = Bun.spawn({
		cmd: [
			...spec.cmdPrefix,
			"sh",
			"-c",
			'base64 "$1" | tr -d "\\n"',
			"--",
			absPath,
		],
		cwd: workspaceDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: spec.env,
	});
	const [content, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { ok: proc.exitCode === 0, content, stderr };
}

async function runEditFile(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform,
	absPath: string,
	old: string,
	new_: string,
	characterDir?: string,
	modulesRoot?: string,
): Promise<ApplyPatchResult> {
	if (old.length === 0) {
		return { status: "failed", output: "old string must not be empty" };
	}
	const read = await runReadFile(
		workspaceDir,
		historyDir,
		platform,
		absPath,
		characterDir,
		modulesRoot,
	);
	if (!read.ok) {
		return { status: "failed", output: "file not found" };
	}
	const content = read.content;
	const count = content.split(old).length - 1;
	if (count === 0) {
		return { status: "failed", output: "old string not found" };
	}
	if (count > 1) {
		return {
			status: "failed",
			output: `old string is not unique (${count} occurrences)`,
		};
	}
	const updated = content.replace(old, new_);
	const w = await runCreateFile(
		workspaceDir,
		historyDir,
		platform,
		absPath,
		updated,
		characterDir,
		modulesRoot,
	);
	if (!w.ok) {
		return {
			status: "failed",
			output: w.stderr.trim() || "write failed",
		};
	}
	return { status: "completed" };
}

export class WorkspaceEditor {
	readonly #workspaceDir: string;
	readonly #historyDir: string;
	readonly #platform: NodeJS.Platform;
	readonly #characterDir?: string;
	readonly #modulesRoot?: string;

	constructor(
		workspaceDir: string,
		historyDir: string,
		platform: NodeJS.Platform = process.platform,
		characterDir?: string,
		modulesRoot?: string,
	) {
		this.#workspaceDir = workspaceDir;
		this.#historyDir = historyDir;
		this.#platform = platform;
		this.#characterDir = characterDir;
		this.#modulesRoot = modulesRoot;
	}

	async createFile(
		op: Extract<ApplyPatchOperation, { type: "create_file" }>,
	): Promise<ApplyPatchResult> {
		const resolved = path.resolve(op.path);
		// op.diff carries the file content for create_file (passed as the "content" field
		// by createWorkspaceTools; the Editor interface reuses the diff field).
		const result = await runCreateFile(
			this.#workspaceDir,
			this.#historyDir,
			this.#platform,
			resolved,
			op.diff,
			this.#characterDir,
			this.#modulesRoot,
		);
		if (!result.ok) {
			return {
				status: "failed",
				output: result.stderr.trim() || "create failed",
			};
		}
		return { status: "completed" };
	}

	async editFile(op: {
		type: "edit_file";
		path: string;
		old: string;
		new: string;
	}): Promise<ApplyPatchResult> {
		const resolved = path.resolve(op.path);
		return runEditFile(
			this.#workspaceDir,
			this.#historyDir,
			this.#platform,
			resolved,
			op.old,
			op.new,
			this.#characterDir,
			this.#modulesRoot,
		);
	}

	async deleteFile(
		op: Extract<ApplyPatchOperation, { type: "delete_file" }>,
	): Promise<ApplyPatchResult> {
		const resolved = path.resolve(op.path);
		const result = await runDeleteFile(
			this.#workspaceDir,
			this.#historyDir,
			this.#platform,
			resolved,
			this.#characterDir,
			this.#modulesRoot,
		);
		if (!result.ok) {
			return {
				status: "failed",
				output: result.stderr.trim() || "delete failed",
			};
		}
		return { status: "completed" };
	}
}

export function createWorkspaceTools(
	workspaceDir: string,
	historyDir: string,
	platform: NodeJS.Platform = process.platform,
	characterDir?: string,
	modulesRoot?: string,
): Tool[] {
	const shell = new WorkspaceShell(
		workspaceDir,
		historyDir,
		platform,
		characterDir,
		modulesRoot,
	);
	const editor = new WorkspaceEditor(
		workspaceDir,
		historyDir,
		platform,
		characterDir,
		modulesRoot,
	);

	const shellFunctionTool = tool({
		name: "shell",
		description:
			"Execute shell commands sequentially in the workspace sandbox. Each command runs as `sh -c <command>`. Commands do not share state between calls.",
		parameters: {
			type: "object",
			properties: {
				commands: {
					type: "array",
					items: { type: "string" },
					description: "Shell commands to execute in order",
				},
				timeout_ms: {
					type: "number",
					description: "Per-command timeout in milliseconds (default: 30000)",
				},
			},
			required: ["commands"],
			additionalProperties: false,
			// biome-ignore lint/suspicious/noExplicitAny: avoid @openai/agents-core subpath types for parameters
		} as any,
		strict: false as false,
		execute: async (input: unknown) => {
			const { commands, timeout_ms } = input as {
				commands: string[];
				timeout_ms?: number;
			};
			const action: ShellAction = {
				commands,
				...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
			};
			const result = await shell.run(action);
			return JSON.stringify(result);
		},
	});

	const editFunctionTool = tool({
		name: "edit",
		description:
			"Create, edit, or delete a file inside the workspace sandbox. " +
			"Use absolute host paths (e.g. the path you see in the shell). " +
			"For edit_file, old must match exactly once in the file; expand the context if not unique.",
		parameters: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["create_file", "edit_file", "delete_file"],
				},
				path: {
					type: "string",
					description: "Absolute path to the file",
				},
				content: {
					type: "string",
					description: "Full file content (required for create_file)",
				},
				old: {
					type: "string",
					description:
						"Exact substring to replace (required for edit_file; must appear exactly once)",
				},
				new: {
					type: "string",
					description: "Replacement text (required for edit_file)",
				},
			},
			required: ["type", "path"],
			additionalProperties: false,
			// biome-ignore lint/suspicious/noExplicitAny: avoid @openai/agents-core subpath types for parameters
		} as any,
		strict: false as false,
		execute: async (input: unknown) => {
			const {
				type,
				path: filePath,
				content,
				old,
				new: newText,
			} = input as {
				type: string;
				path: string;
				content?: string;
				old?: string;
				new?: string;
			};
			let result: ApplyPatchResult | undefined;
			if (type === "create_file") {
				// Reuse ApplyPatchOperation shape: pass content via the diff field.
				result = await editor.createFile({
					type: "create_file",
					path: filePath,
					diff: content ?? "",
				});
			} else if (type === "edit_file") {
				result = await editor.editFile({
					type: "edit_file",
					path: filePath,
					old: old ?? "",
					new: newText ?? "",
				});
			} else if (type === "delete_file") {
				result = await editor.deleteFile({
					type: "delete_file",
					path: filePath,
				});
			} else {
				return JSON.stringify({
					status: "failed",
					output: "unsupported operation type",
				});
			}
			return JSON.stringify(result ?? { status: "completed" });
		},
	});

	return [shellFunctionTool, editFunctionTool];
}
