import { type QueuedEvent, timestampFromUUIDv7 } from "./event-queue";

/** Minimal daemon shape so this module does not depend on `./runtime` (avoids cycles). */
export type EventDropDaemon = {
	manifest: { name: string };
	peer: { notify(method: string, params: unknown): void };
};

export function notifyEventDropped(
	daemons: EventDropDaemon[],
	event: QueuedEvent,
): void {
	const daemon = daemons.find((d) => d.manifest.name === event.source);
	if (daemon) {
		daemon.peer.notify("event", {
			type: "event.dropped.v1",
			source: event.source,
			timestamp: timestampFromUUIDv7(event.id),
			params: event.params,
		});
	} else {
		console.error(`[core] event lost: source=${event.source} id=${event.id}`);
	}
}
