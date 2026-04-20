# justclaw

An autonomous agent framework that is just right.

justclaw is inspired by [OpenClaw](https://github.com/openclaw/openclaw) — a street tree, grown in fixed soil. justclaw is the soil itself.

The goal is not to be smaller. The goal is to be right.

The core processes events through a single LLM queue, providing reasoning, session memory, and identity. Modules connect external systems — messaging, timers, APIs — by communicating with the core over NDJSON (JSON-RPC 2.0) on stdin/stdout.

Runtime: **Bun**

## Requirements

- [Bun](https://bun.sh)
- macOS (`sandbox-exec`, included in the OS) or Linux (`bwrap`)

## Quickstart

**1. Set environment variables**

```sh
export JUSTCLAW_OPENAI_API_KEY=your-api-key
export JUSTCLAW_OPENAI_MODEL=gpt-5
export JUSTCLAW_HOME=$HOME/justclaw
```

**2. Install dependencies**

```sh
bun install
```

**3. Add a module**

Copy the `cli-chat` example module, which lets you chat from a local terminal:

```sh
mkdir -p $JUSTCLAW_HOME/modules/cli-chat
cp examples/cli-chat/module.json examples/cli-chat/main.ts $JUSTCLAW_HOME/modules/cli-chat/
```

**4. Start the core**

```sh
bun run src/index.ts
```

**5. Connect in a second terminal**

```sh
bun run examples/cli-chat/client.ts
```

Type a message and press Enter. The LLM response is printed to the same terminal.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `JUSTCLAW_OPENAI_API_KEY` | yes | — | API key passed to the OpenAI-compatible client |
| `JUSTCLAW_OPENAI_MODEL` | yes | — | Model name, e.g. `gpt-5` |
| `JUSTCLAW_OPENAI_BASE_URL` | no | OpenAI default | Base URL for the API endpoint; set to use a compatible provider |
| `JUSTCLAW_HOME` | no | `$HOME/justclaw` | Root directory for modules, workspace, history, character, and skills |
| `JUSTCLAW_CHARACTER` | no | `$JUSTCLAW_HOME/character` | Override path for the character directory |
| `JUSTCLAW_SKILLS` | no | `$JUSTCLAW_HOME/skills` | Override path for the skills directory |

## Architecture

The core runs a single LLM inference queue. Modules communicate with the core over NDJSON (JSON-RPC 2.0) on stdin/stdout. Events from modules are enqueued and processed serially; the LLM may call back into modules via tool calls.

```
Module (source)                    Core                         Module (target)
 |                                  |                              |
 |-- event (notification) -------->|                              |
 |                                  |-- enqueue to LLM queue      |
 |                                  |   (single queue, serial)    |
 |                                  |                              |
 |                                  |-- tool/{name} (request) --> |
 |                                  |<-- result ------------------ |
```

### Core capabilities

- **Reasoning** — LLM-based inference via a single serial queue
- **Memory** — Per-session conversation history, persisted to disk
- **Identity** — Agent personality and instructions loaded from the character directory
- **Built-in tools** — `send_message`, `shell`, `edit`, `send_image`, `send_file`, `restart_modules`

### Message routing

The canonical delivery target is the source of the most recently consumed message from a replyable module. The core persists this as `last_replyable_target` so that events from non-replyable sources (for example, a timer module) still route LLM output to the last replyable module.

When the LLM calls `send_message`, it creates a transient override for the current processing cycle only. Subsequent free-form text in that cycle goes to the override target. When the cycle ends the override is discarded.

## Modules

A module is a standalone executable placed under `$JUSTCLAW_HOME/modules/{name}/`. Each module directory contains a `module.json` manifest and an entrypoint.

```
$JUSTCLAW_HOME/
  modules/
    {module-name}/
      module.json      # manifest
      {entrypoint}     # executable
      ...              # module-specific data and state
  skills/
    {skill-name}/
      SKILL.md         # YAML frontmatter (name, description) + Markdown instructions
      ...              # optional scripts, templates, reference files
  workspace/           # LLM workspace (rw); available via shell and edit tools
  history/             # session history files (ro inside workspace sandbox)
  character/           # agent identity files (rw inside workspace sandbox)
```

Modules can be written in any language. The wire protocol is NDJSON over stdin/stdout. See [docs/spec.md](docs/spec.md) for the full protocol reference.

### Manifest (module.json)

**daemon** — long-running process started when the core starts:

```json
{
  "name": "{module-name}",
  "exec": "{entrypoint}",
  "mode": "daemon",
  "replyable": true
}
```

**timer** — one-shot process spawned on a cron schedule:

```json
{
  "name": "{module-name}",
  "exec": "{entrypoint}",
  "mode": "timer",
  "cron": "0 9 * * 1-5"
}
```

| | daemon | timer |
|---|---|---|
| Lifecycle | Long-running | One-shot (spawn, emit, exit) |
| Startup | When core starts or `restart_modules` | Core spawns on cron match |
| Event emission | Any time | Before exit |
| Tool calls | Supported | Not supported (process does not stay running) |
| `replyable` field | Optional (default `false`) | Not applicable |

`replyable: true` allows the core to deliver `message.send.v1` notifications to the module and makes it eligible as the default routing target for LLM output.

### Cron expressions

Cron expressions are 5-field and evaluated in UTC.

### Sandbox

Each module runs inside a platform sandbox (`bwrap` on Linux, `sandbox-exec` on macOS). The sandbox grants read-write access to the module's own directory (`modules/{name}/`) and temp paths. Modules cannot access each other's directories or the workspace directly.

The `shell` and `edit` built-in tools run in a separate workspace sandbox that grants read-write access to the workspace, character, and modules directories, and read-only access to the history directory.

## Examples

- **[cli-chat](examples/cli-chat/)** — daemon module; local terminal chat via a Unix socket
- **[daily](examples/daily/)** — timer module; fires on a cron schedule and asks the LLM to write a daily log entry

## Protocol

The full wire protocol — methods, message formats, lifecycle diagrams, event types, session management, built-in tools, and routing rules — is in [docs/spec.md](docs/spec.md).
