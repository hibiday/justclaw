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
| `event` | module -> core | notification | Event emitted by the module |
| `event` | core -> module | notification | Core-initiated notification (see Core → Module Messaging) |

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

When the core starts a module, it executes the manifest's `exec` path inside the platform sandbox. Linux uses `bwrap`; macOS uses `sandbox-exec`.

If the entrypoint begins with a shebang, the core inspects it before spawning:

- `#!/absolute/path/to/interpreter` uses that interpreter path
- `#!/usr/bin/env {command}` resolves `{command}` using the inherited environment

If the resolved interpreter is outside the sandbox's standard read-only allowlist, the core exposes the interpreter's parent directory as an additional read-only path, without exposing `/`.

**Rationale:** This preserves common user-local runtimes such as Bun installed outside `/usr` while keeping the sandbox policy minimal and read-only.

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

### `event.dropped.v1`

When the core restarts and finds an event that was in the `running` state (i.e., the LLM cycle started but did not complete), it notifies the source module via `event.dropped.v1`. The source module can use this to decide whether to re-emit the event.

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

If the source module is no longer present at restart, the event is discarded silently. Re-emitting the event is the module's responsibility; the core does not replay it automatically.

### Auto-routing

Because the LLM inference queue is single and serial, the most recently consumed received message is always uniquely defined. This is the canonical basis for routing:

> **The canonical delivery target is the source of the most recently consumed received message.**

The canonical state is derived purely from the queue's consumption position. The core does not maintain additional persistent state for routing.

#### Transient override

When the LLM calls the built-in `send_message` tool during a processing cycle, it creates a transient override of the delivery target:

- The override applies only within the current processing cycle.
- Free-form text output emitted after the override goes to the overridden target.
- When the cycle ends, the override is discarded.
- The next processing cycle starts fresh from the canonical state derived from the next consumed message.

**Rationale:** LLMs commonly emit free-form text immediately after a tool call without repeating the tool invocation. Without the override, that trailing text would be misrouted back to the canonical target instead of the module the LLM just explicitly addressed. The override resolves this without requiring the LLM to re-specify the destination on every output.

#### Example

```
Queue: [Event A from X, Event B from Y]

[Cycle for A starts]
  canonical = X
  override = none
  default target = X

  LLM emits text          -> delivered to X
  LLM calls send_message(module=Z, ...)
                          -> delivered to Z
                          -> override = Z
  default target = Z
  LLM emits text          -> delivered to Z
[Cycle for A ends, override discarded]

[Cycle for B starts]
  canonical = Y
  override = none
  default target = Y
  ...
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

The core forwards this as a `message.send.v1` notification to the named module, then updates the default delivery target.

## Event Format for LLM

Event payloads are arbitrary JSON objects. The canonical event envelope uses `type: "event.v1"`. The core uses `type` for envelope handling and does not forward it to the LLM. The remaining payload fields are converted to XML before passing them to the LLM. Many LLMs handle XML-tagged input better than raw JSON, producing more reliable reasoning.

**Conversion rules:**

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
