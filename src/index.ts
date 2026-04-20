import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	loadHomeAgentsFile,
	resolveCharacterDir,
	resolveSkillsDir,
} from "./agent-context";
import { resolveModelConfig, runLlmLoop } from "./llm-loop";
import {
	bootstrapRuntime,
	type StartedDaemon,
	stopDaemons,
	type TimerScheduler,
} from "./runtime";
import { resolveHistoryDir, SessionStore } from "./session-store";
import { createWorkspaceTools, resolveWorkspaceDir } from "./workspace";

function createShutdownSignal(): {
	dispose: () => void;
	promise: Promise<void>;
} {
	let resolved = false;
	let finish = () => {};
	const promise = new Promise<void>((resolve) => {
		finish = () => {
			if (!resolved) {
				resolved = true;
				resolve();
			}
		};
	});
	const dispose = () => {
		process.off("SIGINT", finish);
		process.off("SIGTERM", finish);
	};

	process.once("SIGINT", finish);
	process.once("SIGTERM", finish);

	return { dispose, promise };
}

async function main(): Promise<void> {
	const daemonsRef: { current: StartedDaemon[] } = { current: [] };
	let eventQueue:
		| Awaited<ReturnType<typeof bootstrapRuntime>>["eventQueue"]
		| undefined;
	const timerSchedulerRef: { current: TimerScheduler | undefined } = {
		current: undefined,
	};
	const shutdown = createShutdownSignal();
	const abortController = new AbortController();
	const shutdownTask = shutdown.promise.then(async () => {
		abortController.abort();
		await timerSchedulerRef.current?.stop();
		eventQueue?.close();
		await stopDaemons(daemonsRef.current);
	});

	try {
		const model = resolveModelConfig();
		const workspaceDir = resolveWorkspaceDir();
		const historyDir = resolveHistoryDir();
		const characterDir = resolveCharacterDir();
		const skillsDir = resolveSkillsDir();
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(characterDir, { recursive: true });
		mkdirSync(skillsDir, { recursive: true });
		const sessionStore = new SessionStore(historyDir);
		await sessionStore.ensureDefaultSessionIfEmpty();
		const result = await bootstrapRuntime({
			abortSignal: abortController.signal,
			startedDaemons: daemonsRef.current,
			sessionStore,
		});
		eventQueue = result.eventQueue;
		timerSchedulerRef.current = result.timerScheduler;
		const homeDir = path.dirname(result.modulesRoot);
		const operatorContext = await loadHomeAgentsFile(homeDir);
		const workspaceTools = createWorkspaceTools(
			workspaceDir,
			historyDir,
			process.platform,
			characterDir,
			result.modulesRoot,
			skillsDir,
		);

		// If shutdown wins the race, we do not await runLlmLoop afterward. Main
		// returns once shutdownTask finishes; runLlmLoop may still be blocked on
		// runner.run (closing the queue does not cancel an in-flight LLM call).
		// The event row can stay `running` until the next start, when stale
		// recovery emits event.dropped.v1. Acceptable by design.
		await Promise.race([
			runLlmLoop(eventQueue, daemonsRef, model, {
				sessionStore,
				workspaceTools,
				workspaceDir,
				historyDir,
				characterDir,
				operatorContext: operatorContext || undefined,
				modulesRoot: result.modulesRoot,
				skillsDir,
				abortSignal: abortController.signal,
				timerSchedulerRef: timerSchedulerRef as { current: TimerScheduler },
			}),
			shutdownTask,
		]);
	} catch (error) {
		abortController.abort();
		await timerSchedulerRef.current?.stop();
		eventQueue?.close();
		await stopDaemons(daemonsRef.current);
		throw error;
	} finally {
		shutdown.dispose();
	}
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
