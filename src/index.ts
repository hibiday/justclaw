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
	const shutdown = createShutdownSignal();
	const abortController = new AbortController();
	const shutdownTask = shutdown.promise.then(async () => {
		abortController.abort();
		await stopDaemons(daemons);
	});

	try {
		const { modulesRoot } = await bootstrapRuntime({
			abortSignal: abortController.signal,
			startedDaemons: daemons,
		});
		console.error(
			`Loaded ${daemons.length} daemon module(s) from ${modulesRoot}`,
		);

		await shutdownTask;
	} catch (error) {
		abortController.abort();
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
