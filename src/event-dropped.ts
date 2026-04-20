import { type QueuedEvent, timestampFromUUIDv7 } from "./event-queue";

/** Minimal daemon shape so this module does not depend on `./runtime` (avoids cycles). */
export type EventDropDaemon = {
	manifest: { name: string };
	peer: { notify(method: string, params: unknown): void };
};

// Omit binary data fields from dropped notifications to avoid sending large
// payloads (e.g. base64 image/file contents) back through the module channel.
function sanitizeParams(params: unknown): unknown {
	if (typeof params !== "object" || params === null) return params;
	const record = params as Record<string, unknown>;
	if (record.type !== "image.send.v1" && record.type !== "file.send.v1") {
		return params;
	}
	const { data: _data, ...rest } = record;
	return rest;
}

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
			params: sanitizeParams(event.params),
		});
	} else {
		console.error(`[core] event lost: source=${event.source} id=${event.id}`);
	}
}
