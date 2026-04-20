# justclaw Protocol Specification

This document defines the wire protocol between the core and modules.

## Transport

NDJSON over stdin/stdout. One JSON message per line. JSON-RPC 2.0 compliant.

stderr is reserved for log output. The core collects it.

## Semantics

JSON-RPC's two message kinds map to two distinct concerns:

| | Request/Response | Notification |
|---|---|---|
| Used for | Tool calling | Events, messaging |
| Direction | core -> module (primary) | module -> core (primary) |
| Response | Required | None |

- **Tool calling** uses request/response. The core asks a module to perform an action and waits for the result. This corresponds directly to LLM tool calling.
- **Events and messaging** use notifications. Modules emit events (e.g., external input received, file changed, timer fired) as one-way notifications. The core may also send notifications to modules, primarily for delivering messages.

## Delivery Guarantees

The protocol provides best-effort delivery only. The core does not retry, persist, or acknowledge notifications. Modules are responsible for ensuring reliable delivery to external systems where it matters.

Modules with durability requirements should implement their own queuing, retry, and persistence (using their `modules/{name}/` directory for state). Modules whose events are tolerable to loss (e.g., file watchers, metrics) can rely on plain notifications without additional handling.

## Module Capabilities

A module may expose **tools** — request/response handlers the core can call. Tools are declared in the response to `initialize`.

Events are not declared. A module may emit any notification at any time; the core forwards them to the LLM queue without inspecting their schema.

A daemon module may provide both tools and events. A timer module emits events only (it does not stay running, so it cannot serve tool calls).

### Tool Definition Format

Each entry in the `tools` array follows the OpenAI function tool format:

| Field | Type | Description |
|---|---|---|
| `name` | string | Tool name. Must be unique within the module. Used as `{module}__{name}` in the LLM context. |
| `description` | string | Description for the LLM |
| `parameters` | object | JSON Schema object describing the parameters |

## Reserved Fields

All payloads (request `params`, response `result`, notification `params`) reserve the top-level `type` field for envelope-level discrimination. The convention is dot-separated and versioned (`event.v1`, `message.send.v1`, etc.).

This applies to:

- All notifications in both directions
- All tool requests and responses
- All event payloads

For ordinary event semantics, modules should use another payload field such as `kind` rather than overloading `type`. `kind` is a convention, not a reserved protocol field.

## Methods

| Method | Direction | Kind | Description |
|---|---|---|---|
| `initialize` | core -> module | request | Module returns its tools |
| `tool/{name}` | core -> module | request | Invoke a tool exposed by the module |
| `shutdown` | core -> module | request | Graceful stop |
| `event` | module -> core | notification | LLM-bound event emitted by the module |
| `sessions.new.v1` | module -> core | request | Create a new session; core returns its id |
| `sessions.switch.v1` | module -> core | request | Enqueue a switch to an existing session (returns when enqueued, not when applied) |
| `sessions.active.v1` | module -> core | request | Return the currently active session id |
| `sessions.list.v1` | module -> core | request | List all session ids |
| `sessions.get.v1` | module -> core | request | Retrieve history for a session |
| `sessions.delete.v1` | module -> core | request | Delete a session's history file |
| `event` | core -> module | notification | Core-initiated notification (see Core → Module Messaging) |

## Module → Core Notification Types

Modules emit LLM-bound events as notifications with `method: "event"`. The `type` field selects the envelope. Supported values:

| `type` | Purpose |
|---|---|
| `event.v1` | Canonical text-oriented event; payload fields are converted to XML for the LLM (see [Event Format for LLM](#event-format-for-llm)). |
| `image.send.v1` | Delivers a base64-encoded image on the **next** LLM cycle (see below). |
| `file.send.v1` | Delivers a base64-encoded file (for example a PDF) on the **next** LLM cycle (see below). |

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "event.v1",
    "kind": "message.received",
    "..."
  }
}
```

See [Event Format for LLM](#event-format-for-llm) for how each envelope reaches the LLM.

### `image.send.v1`

Emitted by a module (or enqueued by the built-in `send_image` tool) to attach image bytes on the next dequeue. Params:

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `image.send.v1` |
| `data` | string | Base64-encoded image bytes (no validation; consumer is the LLM) |
| `mediaType` | string | MIME type (for example `image/png`) |

### `file.send.v1`

Emitted by a module (or enqueued by the built-in `send_file` tool) to attach a document on the next dequeue. Params:

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `file.send.v1` |
| `data` | string | Base64-encoded file bytes |
| `mediaType` | string | MIME type (for example `application/pdf`) |
| `filename` | string | Basename for the file slot |

## Module → Core Session Requests

Session operations use JSON-RPC request/response so the module can confirm the result before emitting subsequent events.

The bundled runtime always configures a session store (per-session history files under the history directory). A file is treated as a session only when all of the following hold: filename is UUID `{id}.json`, file is readable, JSON parsing succeeds, and the top-level JSON value is an array (minimum condition for `AgentInputItem[]`). Other `*.json` files and unreadable/invalid UUID files are not sessions. The session methods below assume that store is present.

Before any module is started, the bundled entrypoint ensures the history directory is non-empty: if there are no readable UUID `{id}.json` sessions yet (including a missing directory), it creates one empty session file with a new UUIDv7 and writes `[]`. That step is not a module-visible `sessions.new.v1` request; it exists so the LLM loop can adopt a session from disk without a prior `sessions.new.v1`. A line is written to the process stderr when this happens. On runtime startup, if `events.db` metadata does not yet contain `active_session_id`, the core seeds it from the newest readable UUID session id on disk. That startup seed fixes the initial active session before any module-visible `sessions.new.v1` calls can occur. Custom callers of `bootstrapRuntime` alone may omit the initial history-file creation step; in that configuration `sessions.active.v1` can still fail when there are no readable UUID sessions and the loop has not adopted a session yet.

### `sessions.new.v1`

Creates a new session and immediately writes an empty history file (`[]`). The core generates a UUIDv7 as the session identifier and returns it. The session appears in `sessions.list.v1` as soon as this call returns. The session is not activated; `sessions.new.v1` never changes the active session. Use `sessions.switch.v1` to switch.

Request:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "sessions.new.v1" }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "id": "0196f4a2-..." } }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | UUID (case-insensitive). The core returns UUIDv7 from this method. Used as the filename `$JUSTCLAW_HOME/history/{id}.json`. |

### `sessions.switch.v1`

Requests a switch to an existing session. The core enqueues that switch on the LLM queue and returns `"ok"` when the enqueue succeeds. The response means **the switch is queued**, not that the LLM loop has already loaded the new session or updated its active-session state.

The session becomes active before the next `event.v1` is processed by the LLM.

Request:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "sessions.switch.v1", "params": { "id": "0196f4a2-..." } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 2, "result": "ok" }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier. Must be a UUID (case-insensitive). Use the value returned by `sessions.new.v1` or an existing on-disk id. |

If no readable history file exists for the given id, the core returns a JSON-RPC error.

If the history file is removed or becomes unreadable **after** `sessions.switch.v1` returns `"ok"` but **before** the LLM loop applies that queued switch, the core does not change the in-memory session: it notifies the module that enqueued the switch row with `event.dropped.v1` (same shape as other dropped queue work), completes that queue row, and leaves the previously active session unchanged.

**Ordering guarantee:** because the module receives a response before sending the next notification, the session switch is registered in the core before any subsequent `event.v1` is enqueued. The LLM loop drains pending session switches immediately after dequeuing each event, so the correct session is always active when the event is processed.

**`sessions.active.v1` immediately after `sessions.switch.v1`:** the switch is applied asynchronously by the LLM loop. If the module calls `sessions.active.v1` in the same turn, before the loop has consumed the enqueued switch, the result can still be the **previous** active id. There is no guarantee that `"ok"` from `sessions.switch.v1` and a following `sessions.active.v1` observe the same id in that narrow window.

The core does not process `event.v1` until a session is active. If the LLM has not adopted a session yet, the core first tries the persisted active session id in `events.db` metadata. If that id is missing or unreadable, the core falls back to the **lexicographically greatest** readable UUID session id among `{id}.json` files in the history directory (for UUIDv7 ids in canonical string form, that is the newest id). You can also set the active session explicitly with `sessions.switch.v1`. If there are no readable UUID session files and no applicable `sessions.switch.v1` before the event is consumed, the core notifies the source module with `event.dropped.v1` and completes the queue row without running the LLM.

### `sessions.active.v1`

Returns the id of the currently active session. The source of truth is persisted `events.db` metadata key `active_session_id`, which is updated when the LLM loop successfully applies a session switch or adopts a fallback session.

Lookup order:

1. Persisted `events.db` metadata key `active_session_id`
2. Fallback: newest-on-disk readable UUID id (lexicographic maximum) when metadata is missing or unusable

Metadata is considered unusable when `active_session_id` is missing, unreadable, or invalid (for example non-UUID text). In those cases the core logs a warning and continues with fallback lookup.

This method is read-only: it does not update `active_session_id` metadata. Metadata is updated only by the LLM loop when it applies a session switch or adopts a fallback session.

If `sessions.switch.v1` was just accepted (`"ok"`) but the loop has not yet applied that switch, this method can still return the prior value until the switch is drained. See **Ordering guarantee** under `sessions.switch.v1`.

The core returns a JSON-RPC error when no id is available from either step above. After a normal bundled startup with an empty history, the bootstrap step above always leaves at least one file, so this error does not occur on first boot until every session file is removed, becomes unreadable, or the store is otherwise empty.

Request:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "sessions.active.v1" }
```

Response (when a session is active):

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "id": "0196f4a2-..." } }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier. Must be a UUID (case-insensitive). Use the value returned by `sessions.new.v1` or an existing on-disk id. |

### `sessions.list.v1`

Returns the ids of all readable sessions (UUID `{id}.json` files that can be read, parsed as JSON, and treated as arrays). Non-UUID `*.json` files and unreadable UUID files are omitted. The list is sorted lexicographically, which is chronological order for UUIDv7 ids.

Request:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "sessions.list.v1" }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 3, "result": { "ids": ["0196f4a2-...", "0196f4a3-..."] } }
```

| Field | Type | Description |
|---|---|---|
| `ids` | string[] | UUID basenames of readable `{id}.json` session files, lexicographically sorted. Non-UUID `*.json` files and unreadable UUID files are omitted. |

### `sessions.get.v1`

Returns the conversation history for a session. If no readable history file exists for the given id, the core returns a JSON-RPC error (same idea as `sessions.switch.v1` for a missing or unreadable session). When the file exists and contains `[]`, `history` is an empty array.

The `history` field contains the raw `AgentInputItem[]` used internally by the LLM loop. Its structure is not versioned and may change.

Request:

```json
{ "jsonrpc": "2.0", "id": 4, "method": "sessions.get.v1", "params": { "id": "0196f4a2-..." } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 4, "result": { "history": [ ... ] } }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier of the session whose history to retrieve. Must be a UUID (case-insensitive). |

### `sessions.delete.v1`

Deletes the history file for the given session. If no file exists for the id, the operation succeeds silently (idempotent).

If the deleted id is currently active (persisted metadata), the core deletes `active_session_id` immediately. The core does not auto-switch during `sessions.delete.v1`; fallback adoption can happen later when the LLM loop needs a session for event processing.

If a session is deleted while an LLM turn is in-flight, completion of that turn does not recreate the deleted session file. Deleted sessions are never written again.

Request:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "sessions.delete.v1", "params": { "id": "0196f4a2-..." } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 7, "result": "ok" }
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Session identifier. Must be a UUID (case-insensitive). Use the value returned by `sessions.new.v1` or an existing on-disk id. |

## Lifecycle (daemon)

```
Core                            Module
 |                                |
 |-- spawn ---------------------->|
 |-- {"jsonrpc":"2.0","id":1,     |
 |    "method":"initialize"} ---->|
 |<-- {"jsonrpc":"2.0","id":1,    |
 |     "result":{                 |
 |       "tools":[...]            |
 |     }} ---------------------- |
 |                                |
 |   (module emits events as      |
 |    notifications any time)     |
 |<-- {"jsonrpc":"2.0",           |
 |     "method":"event",          |
 |     "params":{...}} ---------- |
 |                                |
 |   (core invokes a tool)        |
 |-- {"jsonrpc":"2.0","id":2,     |
 |    "method":"tool/{name}",     |
 |    "params":{...}} ----------->|
 |<-- {"jsonrpc":"2.0","id":2,    |
 |     "result":{...}} ---------- |
 |                                |
 |-- {"jsonrpc":"2.0","id":3,     |
 |    "method":"shutdown"} ------>|
 |<-- {"jsonrpc":"2.0","id":3,    |
 |     "result":"ok"} ----------- |
 |                            exit(0)
```

## Lifecycle (timer)

```
Core                            Module
 |                                |
 |  cron match                    |
 |-- spawn ---------------------->|
 |-- initialize ----------------->|
 |<-- result -------------------- |
 |<-- event (notification) ------ |
 |-- shutdown ------------------->|
 |                            exit(0)
```

## Module Execution

Each daemon module directory contains a `module.json` manifest. Required fields: `name` (must match the directory name), `mode` (`"daemon"`), `exec` (path to the entrypoint, relative to the module directory). Optional field:

| Field | Type | Default | Description |
|---|---|---|---|
| `replyable` | boolean | `false` | When `true`, the core may deliver `message.send.v1` to this module and the LLM may use `send_message` / final text routing to this module. Non-replyable modules still receive tool calls and emit events; outbound user messaging is not routed to them. |

When the core starts a module, it executes the manifest's `exec` path inside the platform sandbox. Linux uses `bwrap`; macOS uses `sandbox-exec`.

If the entrypoint begins with a shebang, the core inspects it before spawning:

- `#!/absolute/path/to/interpreter` uses that interpreter path
- `#!/usr/bin/env {command}` resolves `{command}` using the inherited environment

If the resolved interpreter is outside the sandbox's standard read-only allowlist, the core exposes the interpreter's parent directory as an additional read-only path, without exposing `/`.

**Rationale:** This preserves common user-local runtimes such as Bun installed outside `/usr` while keeping the sandbox policy minimal and read-only.

## Operator instructions

The bundled entrypoint reads `$JUSTCLAW_HOME/AGENTS.md` once at startup. If present, its content is prepended to the character context instructions before every LLM turn.

This file is outside all sandbox write paths, so the agent cannot modify it. It is loaded once at process startup; changes to the file are not visible until the process restarts.

Use this file for immutable operator-level instructions that must persist regardless of character directory contents.

## Character directory

The core resolves a **character** directory for optional static agent context and for files the agent may edit alongside the workspace.

| Resolution | Path |
|---|---|
| `JUSTCLAW_CHARACTER` set | Absolute path from this env var |
| else `JUSTCLAW_HOME` set | `$JUSTCLAW_HOME/character` |
| else | `$HOME/justclaw/character` |

If neither `JUSTCLAW_HOME` nor `HOME` is available, character directory resolution fails the same way as workspace resolution when no overrides exist.

The bundled entrypoint creates the directory if missing (recursive mkdir), same as the workspace directory.

### Character files

The core reads the following files from the character directory, in order:

| File | Purpose |
|---|---|
| `AGENTS.md` | System instructions for the LLM (equivalent to CLAUDE.md / AGENTS.md in coding agents) |
| `SOUL.md` | Core values and ethical guidelines |
| `IDENTITY.md` | Personality, tone, and style |
| `USER.md` | User information and preferences |
| `MEMORY.md` | Cross-session memory |

Each present file is read as UTF-8, trimmed, and formatted as:

```
## FILENAME.md
<trimmed content>
```

Sections are joined with a blank line. The combined string becomes **context instructions** in the agent system prompt (see [Agent system prompt](#agent-system-prompt)).

Missing files are silently skipped. An empty directory (or one containing none of the above filenames) produces empty context instructions. Other I/O errors from reading a present file propagate and abort `runLlmLoop` (they are not caught per-event).

The bundled LLM loop re-reads these files from disk immediately before each `event.v1` is passed to the model. Because the character directory is rw-mounted in the workspace sandbox, the LLM can edit these files via workspace tools; edits take effect on the next turn.

### Workspace sandbox

Built-in `shell` and `edit` run inside the workspace sandbox. That sandbox grants read-write access to the workspace directory, read-write access to the character directory, and read-write access to the runtime modules directory (the same path the core uses to discover and load modules; same mount semantics as the character directory), and read-only access to the history directory (when it exists on the host), in addition to the standard OS read-only paths and temp rules described for module execution. Path boundaries are enforced by the sandbox; the application does not duplicate that check.

## Agent system prompt

The bundled LLM loop rebuilds the agent `instructions` string immediately before each LLM turn. It is composed of two parts:

| Part | Source | Content |
|---|---|---|
| Context instructions | Character files on disk (`AGENTS.md`, `SOUL.md`, etc.) | Sections per file, as described under [Character files](#character-files). Re-loaded before each LLM turn when `characterDir` is configured. Empty when no files are present or all trim empty. |
| Runtime instructions | `src/spec.ts` (`buildRuntimeInstructions`) | Canonical paths and operational guidance (workspace, history layout, character files table, modules directory path, and a table of loaded modules with replyable flag and tool names). |

The core concatenates context instructions and runtime instructions with a **blank line** between them (`\n\n`). Runtime instructions are omitted unless the builder has the workspace path, history path, character path, modules directory path, and the current module list (the bundled entrypoint supplies all of these). Callers without a `characterDir` may still supply static context instructions (tests only in-tree).

Before each LLM turn, the bundled loop refreshes the module table from the currently loaded daemons so `replyable` and tool names match the live process set. A successful `restart_modules` updates processes immediately and **ends the current LLM run**. The **next** dequeued event gets the updated prompt and module tool names.

## Core → Module Messaging

The core sends notifications to modules using `method: "event"` with a versioned `type` field as the discriminator. Unlike module-emitted events (which the LLM consumes), these notifications are consumed by module code, so their formats are fixed.

### `message.send.v1`

The core delivers outbound LLM-generated messages to modules via `message.send.v1`.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "message.send.v1",
    "text": "..."
  }
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `message.send.v1` |
| `text` | string | Message body |

The notification carries no destination information. Modules are responsible for determining where to actually deliver the message based on their own conversational state. A messaging module typically tracks its most recent conversation context and uses it as the default destination.

If precise destination control is required (e.g., DM a specific user, send to a non-default channel), modules should expose this as a tool with explicit parameters rather than relying on the `message.send.v1` notification.

### `tool_call.v1`

The core notifies the current message target each time a tool completes — both workspace tools (`shell`, `edit`) and tools exposed by modules. The notification is sent to the same module that is the current delivery target at the time the tool is called (i.e., `event.source`, unless overridden by a prior `send_message` call in the same cycle).

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "tool_call.v1",
    "tool": "shell",
    "input": { "commands": ["ls -la"] },
    "output": "{\"output\":[{\"stdout\":\"...\",\"stderr\":\"\",\"outcome\":{\"type\":\"exit\",\"exitCode\":0}}]}"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `tool_call.v1` |
| `tool` | string | Tool name (`shell` or `edit`) |
| `input` | object | Arguments passed to the tool by the LLM |
| `output` | string | JSON-encoded result returned by the tool |

For `shell`, `output` is a JSON-encoded `ShellResult` containing per-command stdout, stderr, and outcome (exit code or timeout). For `edit`, `output` is a JSON-encoded object with a `status` field (`"completed"` or `"failed"`) and an optional `output` field with an error message.

### `event.dropped.v1`

The core notifies the source module when it **consumes an event for an LLM cycle but that cycle does not complete normally**. The source module can use this to decide whether to re-emit the event.

That includes at least:

- **Restart recovery:** the previous process exited while one or more events were still marked `running` in the queue (the LLM cycle had started but never finished).
- **LLM failure:** the runner throws or otherwise fails after the event was consumed and before the cycle would have completed successfully.
- **No adoptable session:** a session store is configured, the event was consumed from the queue, but no session could be adopted (no readable UUID `{id}.json` files on disk yet and no `sessions.switch.v1` applied before this event in the loop).

In all cases the notification shape is the same.

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "event.dropped.v1",
    "source": "{module-name}",
    "timestamp": "2026-04-14T10:00:00.000Z",
    "params": {
      "type": "event.v1",
      "kind": "message.received",
      "..."
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Always `event.dropped.v1` |
| `source` | string | Name of the module that originally emitted the event |
| `timestamp` | string | ISO 8601, when the event was originally received by the core |
| `params` | object | Original event params as emitted by the source module |

If the source module is not available (for example, not loaded after restart or the daemon is gone), the core logs the loss and removes the queue row; it does not retry delivery. Re-emitting the event is the module's responsibility; the core does not replay it automatically.

### Auto-routing

Because the LLM inference queue is single and serial, the most recently consumed received message is always uniquely defined. This is the canonical basis for routing:

> **The canonical delivery target is the source of the most recently consumed message from a replyable module.**

The core persists this as the `last_replyable_target` key in `events.db` metadata. Delivery target resolution at the start of each cycle:

| Event source | Delivery target | `last_replyable_target` update |
|---|---|---|
| `replyable: true` | `event.source` | Written with `event.source` |
| `replyable: false` | `last_replyable_target` if set; otherwise `event.source` | Not written |

**Rationale:** Non-replyable modules (for example, those that deliver images via `image.send.v1`) trigger LLM cycles but have no inbox for replies. Without a fallback, LLM output generated in response to their events would be silently dropped. Using the most recently persisted replyable source as the fallback target routes that output to the module most likely to handle it — the one the user was just interacting with.

#### Transient override

When the LLM calls the built-in `send_message` tool during a processing cycle, it creates a transient override of the delivery target:

- The override applies only within the current processing cycle.
- Free-form text output emitted after the override goes to the overridden target.
- When the cycle ends, the override is discarded.
- The next processing cycle starts fresh from the canonical state derived from the next consumed message.

**Rationale:** LLMs commonly emit free-form text immediately after a tool call without repeating the tool invocation. Without the override, that trailing text would be misrouted back to the canonical target instead of the module the LLM just explicitly addressed. The override resolves this without requiring the LLM to re-specify the destination on every output.

#### Example

```
Queue: [Event A from X (replyable), Event B from Y (replyable), Event C from NR (not replyable)]

[Cycle for A starts]
  source = X (replyable) -> last_replyable_target = X
  default target = X
  LLM emits text          -> delivered to X
  LLM calls send_message(module=Z, ...)
                          -> delivered to Z
                          -> override = Z
  LLM emits text          -> delivered to Z
[Cycle for A ends, override discarded]

[Cycle for B starts]
  source = Y (replyable) -> last_replyable_target = Y
  default target = Y
  LLM emits text          -> delivered to Y
[Cycle for B ends]

[Cycle for C starts]
  source = NR (not replyable)
  last_replyable_target = Y -> default target = Y
  LLM emits text          -> delivered to Y
[Cycle for C ends]
```

### Built-in Tool: `send_message`

The core provides `send_message` as a built-in tool, available to the LLM regardless of which modules are loaded.

```
send_message(module: string, text: string)
```

| Parameter | Description |
|---|---|
| `module` | Target module name |
| `text` | Message body |

The core forwards this as a `message.send.v1` notification to the named module only when that module's manifest has `replyable: true`; otherwise the tool returns an error. On success, the core updates the default delivery target.

Trailing free-form assistant text after the LLM run is delivered the same way: only when the current delivery target module is replyable.

### Built-in Tool: `restart_modules`

Reloads daemon modules from the modules directory (same discovery path as startup). Manifest discovery and parsing run **before** any running module is stopped. If discovery or parsing fails, or if the directory contains no valid modules, existing processes stay up and the tool returns an error string.

```
restart_modules({ continuation: string })
```

| Parameter | Description |
|---|---|
| `continuation` | Required. Ignored when reload fails. When reload succeeds and `continuation` is non-empty (after trim), the core enqueues exactly one follow-up internal event with `source` set to the **current** `event.source` and `params` fixed to `{ "type": "event.v1", "text": "<trimmed continuation>" }`. Pass an empty string when no follow-up is needed. The LLM does not supply `source` or arbitrary params. |

The bundled LLM loop implements this as a core tool (not wrapped with `tool_call.v1` notification). It requires a configured session store and modules root; if those are missing, the tool returns an error string instead of reloading.

**Turn boundary:** After `restart_modules` **succeeds**, processes match disk and the current LLM run ends immediately after that tool call. The agent does not continue with more tool calls or trailing free-form text in the reloaded state. The **next** `event.v1` shows the new module table and runs normally against the reloaded modules. Use a non-empty `continuation` when you want the core to enqueue exactly one handoff event under that new module set.

### Built-in Tool: `send_image`

```
send_image({ path: string })
```

| Parameter | Description |
|---|---|
| `path` | Path to a local image file on the host |

The core reads the file, infers a `mediaType` from the extension, base64-encodes the bytes, and enqueues `image.send.v1` with `source` set to the current event source. The image is **not** injected into the current LLM run; it is delivered when that queue row is processed on a later cycle. On success the tool returns `"ok"`; on failure it returns `error: ...`. This tool is not wrapped with `tool_call.v1` module notifications.

### Built-in Tool: `send_file`

```
send_file({ path: string })
```

| Parameter | Description |
|---|---|
| `path` | Path to a local file on the host |

The core reads the file, infers `mediaType` from the extension, sets `filename` to the basename, base64-encodes the bytes, and enqueues `file.send.v1` with `source` set to the current event source. Delivery is on the **next** cycle after enqueue, same as `send_image`. On success the tool returns `"ok"`; on failure it returns `error: ...`. This tool is not wrapped with `tool_call.v1` module notifications.

### Built-in Tool: `shell`

Executes shell commands sequentially inside the workspace sandbox. Each command runs as `sh -c <command>`. Commands do not share state between calls.

```
shell(commands: string[], timeout_ms?: number)
```

| Parameter | Description |
|---|---|
| `commands` | Shell commands to execute in order |
| `timeout_ms` | Per-command timeout in milliseconds (default: 30000) |

The sandbox grants read-write access to `$JUSTCLAW_HOME/workspace/`, read-write access to the character directory (see [Character directory](#character-directory)), read-write access to the runtime modules directory, and read-only access to `$JUSTCLAW_HOME/history/`. After each invocation the core emits a `tool_call.v1` notification to the current delivery target.

### Built-in Tool: `edit`

Creates, edits, or deletes a file inside the workspace sandbox. Allowed paths are the workspace directory and the character directory.

```
edit(type: "create_file" | "edit_file" | "delete_file", path: string, content?: string, old?: string, new?: string)
```

| Parameter | Description |
|---|---|
| `type` | Operation type |
| `path` | Absolute path to the file, inside the sandbox (workspace or character directory) |
| `content` | Full file content (required for `create_file`) |
| `old` | Exact substring to replace (required for `edit_file`; must appear exactly once in the file) |
| `new` | Replacement text (required for `edit_file`) |

The path is resolved to an absolute path. After each invocation the core emits a `tool_call.v1` notification to the current delivery target.

## Event Format for LLM

Event payloads are arbitrary JSON objects. The canonical text-oriented envelope is `type: "event.v1"`. The core uses `type` for envelope handling and does not forward that field to the LLM as a literal key in the user string. The remaining payload fields are converted to XML before passing them to the LLM. Many LLMs handle XML-tagged input better than raw JSON, producing more reliable reasoning.

**Multimodal envelopes (`image.send.v1`, `file.send.v1`):** The core still builds the same XML wrapper (`eventToXml`) from the payload (with `type` stripped before serialization). That XML is passed as an `input_text` part. In addition, the core passes a second content part: `input_image` and `input_file` both use a **data URL string** (`data:<mediaType>;base64,<data>`), matching what the Chat Completions path accepts. These rows are processed in the same session-adoption path as `event.v1`.

**Conversion rules (for the XML half):**

- Object keys become XML element names
- Strings, numbers, and booleans become text content
- Arrays become repeated elements with the same tag
- `null` values are omitted
- Special characters (`<`, `>`, `&`) are XML-escaped
- Object keys must be valid XML element names (no leading digits, no whitespace, no special characters). Invalid keys are an error.

The core wraps each event with metadata (`source`, `timestamp`) it knows independently of the module.

**Example:**

Module emits:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "event.v1",
    "kind": "message.received",
    "user": "alice",
    "text": "hello",
    "tags": ["greeting", "casual"]
  }
}
```

LLM receives:

```xml
<event source="{module-name}" timestamp="2026-04-10T10:00:00Z">
  <kind>message.received</kind>
  <user>alice</user>
  <text>hello</text>
  <tags>greeting</tags>
  <tags>casual</tags>
</event>
```
