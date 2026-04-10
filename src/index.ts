import { bootstrapRuntime, stopDaemons } from "./runtime";

function createShutdownSignal(): Promise<void> {
	return new Promise((resolve) => {
		let resolved = false;
		const finish = () => {
			if (resolved) {
				return;
			}
			resolved = true;
			process.off("SIGINT", finish);
			process.off("SIGTERM", finish);
			resolve();
		};

		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
	});
}

async function main(): Promise<void> {
	const { modulesRoot, daemons } = await bootstrapRuntime();
	console.error(
		`Loaded ${daemons.length} daemon module(s) from ${modulesRoot}`,
	);

	await createShutdownSignal();
	await stopDaemons(daemons);
}

await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
