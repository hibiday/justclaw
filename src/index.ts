import { resolveModelConfig, runLlmLoop } from "./llm-loop";
import { bootstrapRuntime, type StartedDaemon, stopDaemons } from "./runtime";

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
	const daemons: StartedDaemon[] = [];
	let eventQueue:
		| Awaited<ReturnType<typeof bootstrapRuntime>>["eventQueue"]
		| undefined;
	const shutdown = createShutdownSignal();
	const abortController = new AbortController();
	const shutdownTask = shutdown.promise.then(async () => {
		abortController.abort();
		eventQueue?.close();
		await stopDaemons(daemons);
	});

	try {
		const model = resolveModelConfig();
		const result = await bootstrapRuntime({
			abortSignal: abortController.signal,
			startedDaemons: daemons,
		});
		eventQueue = result.eventQueue;
		console.error(
			`Loaded ${daemons.length} daemon module(s) from ${result.modulesRoot}`,
		);

		// If shutdown wins the race, we do not await runLlmLoop afterward. Main
		// returns once shutdownTask finishes; runLlmLoop may still be blocked on
		// runner.run (closing the queue does not cancel an in-flight LLM call).
		// The event row can stay `running` until the next start, when stale
		// recovery emits event.dropped.v1. Acceptable by design.
		await Promise.race([runLlmLoop(eventQueue, daemons, model), shutdownTask]);
	} catch (error) {
		abortController.abort();
		eventQueue?.close();
		await stopDaemons(daemons);
		throw error;
	} finally {
		shutdown.dispose();
	}
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
