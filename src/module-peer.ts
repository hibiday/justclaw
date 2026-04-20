import {
	ACTIVE_SESSION_META_KEY,
	type EventQueue,
} from "./event-queue";
import type { SessionStore } from "./session-store";

export type EventParams = Record<string, unknown> & {
	type: "event.v1" | "image.send.v1" | "file.send.v1";
};

export function parseEventNotificationParams(
	moduleName: string,
	params: unknown,
): EventParams {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new Error(`${moduleName}: event params must be an object`);
	}

	const record = params as Record<string, unknown>;
	if (
		record.type !== "event.v1" &&
		record.type !== "image.send.v1" &&
		record.type !== "file.send.v1"
	) {
		throw new Error(
			`${moduleName}: event type must be "event.v1", "image.send.v1", or "file.send.v1"`,
		);
	}

	return record as EventParams;
}

function requireSessionParamsId(
	manifestName: string,
	params: unknown,
	method: string,
): string {
	if (
		typeof params !== "object" ||
		params === null ||
		typeof (params as Record<string, unknown>).id !== "string" ||
		(params as Record<string, unknown>).id === ""
	) {
		throw new Error(
			`${manifestName}: ${method} requires a non-empty string "id"`,
		);
	}
	return (params as Record<string, unknown>).id as string;
}

async function resolveReadableOrFallbackActiveSessionId(
	queue: EventQueue,
	sessionStore: SessionStore,
): Promise<string | null> {
	const metaId = queue.getMeta(ACTIVE_SESSION_META_KEY);
	if (metaId !== null) {
		try {
			const history = await sessionStore.load(metaId);
			if (history !== null) {
				return metaId;
			}
			console.warn(
				`[core] active_session_id "${metaId}" is missing, unreadable, or invalid; falling back to newest readable session`,
			);
		} catch (error) {
			console.warn(
				`[core] active_session_id metadata lookup: session "${metaId}" is invalid or unreadable (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	const fallbackId = sessionStore.newestReadableSessionId();
	return fallbackId;
}

export function createSessionRequestHandler(
	manifestName: string,
	queue: EventQueue,
	sessionStore: SessionStore,
): (method: string, params: unknown) => Promise<unknown> {
	return async (method, params) => {
		if (method === "sessions.new.v1") {
			const id = Bun.randomUUIDv7();
			await sessionStore.create(id);
			return { id };
		}

		if (method === "sessions.switch.v1") {
			const id = requireSessionParamsId(
				manifestName,
				params,
				"sessions.switch.v1",
			);
			// Pre-check: reject the request immediately if the session does not exist,
			// so the module gets a synchronous error rather than a later event.dropped.v1.
			// The LLM loop loads the file again at apply time because the file may be
			// removed or become unreadable between this check and the queue drain.
			if ((await sessionStore.load(id)) === null) {
				throw new Error(
					`${manifestName}: sessions.switch.v1: session "${id}" is unreadable or does not exist`,
				);
			}
			queue.enqueue(manifestName, { type: "sessions.switch.v1", id });
			return "ok";
		}

		if (method === "sessions.active.v1") {
			const activeId = await resolveReadableOrFallbackActiveSessionId(
				queue,
				sessionStore,
			);
			if (activeId !== null) {
				return { id: activeId };
			}

			throw new Error(
				`${manifestName}: sessions.active.v1: no active session`,
			);
		}

		if (method === "sessions.list.v1") {
			return { ids: sessionStore.list() };
		}

		if (method === "sessions.delete.v1") {
			const id = requireSessionParamsId(
				manifestName,
				params,
				"sessions.delete.v1",
			);
			await sessionStore.delete(id);
			if (id === queue.getMeta(ACTIVE_SESSION_META_KEY)) {
				queue.deleteMeta(ACTIVE_SESSION_META_KEY);
			}
			return "ok";
		}

		if (method === "sessions.get.v1") {
			const id = requireSessionParamsId(
				manifestName,
				params,
				"sessions.get.v1",
			);
			const history = await sessionStore.load(id);
			if (history === null) {
				throw new Error(
					`${manifestName}: sessions.get.v1: session "${id}" does not exist or could not be read`,
				);
			}
			return { history };
		}

		throw new Error(`${manifestName}: unsupported method "${method}"`);
	};
}
