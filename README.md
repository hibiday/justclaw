# justclaw - AI Agent Architecture

## Overview

justclaw is an event-driven AI agent framework.
The core provides reasoning, memory, and identity, along with a minimal set of built-in capabilities. Additional functionality can be added through modules.

Runtime: **Bun**

## Core

The core provides:

- **Reasoning** — LLM-based inference and planning
- **Memory** — Persistent context management across sessions
- **Identity** — Agent personality, values, and behavioral boundaries
- **Built-in tools** — A minimal set of built-in capabilities for common operations: `send_message` for explicit message delivery, `shell` for running commands in the workspace sandbox, and `edit` for creating, editing, and deleting files in the workspace

Functionality beyond the built-ins can be added through modules.

### Message Routing

Because LLM inference is processed through a single serial queue, the most recently consumed received message is always uniquely defined. This invariant is the canonical basis for routing:

> **The canonical delivery target is the source of the most recently consumed message from a replyable module.**

The core persists this value across cycles so that events from non-replyable sources (for example, a module that delivers an image) still route LLM output to the last replyable module rather than being silently dropped.

When the LLM calls the built-in `send_message` tool, it creates a transient override of the delivery target that lasts only for the current processing cycle. Subsequent free-form text output is delivered to the overridden target. When the cycle ends, the override is discarded, and the next cycle starts fresh from the canonical state.

The override exists because LLMs commonly emit free-form text immediately after a tool call without re-invoking the tool. Without the override, that trailing text would be misrouted back to the canonical target instead of the module the LLM just explicitly addressed.

The LLM does not need to know about destinations within a module (channels, users, etc.). Modules manage their own conversational context and decide where to actually deliver messages.

## Module

A module is a standalone executable that communicates with the core via NDJSON (JSON-RPC 2.0) over stdin/stdout.
Modules can be written in any language.

For the wire protocol, lifecycle, and message formats, see [docs/spec.md](docs/spec.md).

### Directory Structure

```
$HOME/justclaw/
  modules/
    {module-name}/
      module.json      # manifest
      {entrypoint}     # executable
      ...              # module-specific data and state
  workspace/           # LLM workspace (rw); available via shell and edit tools
  history/             # session history files (ro inside workspace sandbox)
  character/           # agent identity files (rw inside workspace sandbox); see Character files in spec
```

If `JUSTCLAW_HOME` is set, the runtime uses that directory instead of `$HOME/justclaw/`. Each module directory is writable inside the platform sandbox via `bwrap` or `sandbox-exec`. State management is the module's own responsibility.

### Manifest (module.json)

**daemon module:**

```json
{
  "name": "{module-name}",
  "exec": "./{entrypoint}",
  "mode": "daemon"
}
```

**timer module:**

```json
{
  "name": "{module-name}",
  "exec": "./{entrypoint}",
  "mode": "timer",
  "cron": "0 9 * * 1-5"
}
```

### Mode Comparison

| | daemon | timer |
|---|---|---|
| Lifecycle | Long-running | One-shot (spawn, process, exit) |
| Startup | When core starts or `restart_modules` | Core spawns on cron match; schedules reload on `restart_modules` |
| Event emission | Write to stdout at any time | Write to stdout before exit |
| Process count per module | Always 1 | One per firing |

## Event Processing

### Event Flow

Canonical module event envelope:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "event.v1",
    "kind": "{event.kind}"
  }
}
```

`type` is the reserved envelope discriminator. Ordinary event semantics should go in another payload field such as `kind`.

```
Module (source)                    Core                         Module (target)
 |                                  |                              |
 |-- event (notification) -------->|                              |
 |                                  |-- enqueue to LLM queue      |
 |                                  |   (single queue, serial)    |
 |                                  |                              |
 |                                  |-- tool/{name} (request) -->|
 |                                  |<-- result ----------------- |
```

### LLM Event Queue

- **Single global queue**, processed serially
- Only events requiring LLM reasoning are emitted as notifications from modules
- Processing that doesn't need LLM is handled entirely within the module

### Timer Execution

- Cron expressions are evaluated in UTC.
- Timer modules run **in parallel** (each timer spawned independently)
- Independent of the LLM queue
- If a cron tick fires while the previous run is still active, the core kills the previous process before spawning a new one

## Security

- Each module has rw access only to `modules/{name}/` and temp paths (via `bwrap` or `sandbox-exec`)
