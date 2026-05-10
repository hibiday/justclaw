# cli-chat

A daemon module for `justclaw` that provides a local terminal chat interface over a Unix socket.

## Files

| File | Description |
|---|---|
| `module.json` | Module manifest (`mode: "daemon"`, `replyable: true`) |
| `main.ts` | Daemon process; listens on a Unix socket and forwards input to the core |
| `client.ts` | CLI client; connects to the socket and reads/writes lines |

## Setup

Copy the module files to the modules directory:

```sh
mkdir -p $JUSTCLAW_HOME/modules/cli-chat
cp module.json main.ts $JUSTCLAW_HOME/modules/cli-chat/
```

Start the core, then connect in a second terminal:

```sh
bun run client.ts
```

The socket path is `$JUSTCLAW_HOME/modules/cli-chat/cli-chat.sock`. The daemon creates it on startup; the client exits with an error if it does not exist.

## Usage

Type a message and press Enter. The agent's response is printed to the terminal.

Lines starting with `/` are local session commands and are not forwarded to the core as events.

| Command | Description |
|---|---|
| `/sessions` | List all sessions; marks the active session with `*` |
| `/session <id\|number>` | Switch to an existing session by ID or by the number shown in `/sessions` |
| `/new` | Create a new session and switch to it |
| `/log [id\|number]` | Print the last 20 history entries for a session (defaults to active session) |
| `/interrupt <text>` | Set the in-memory interrupt slot; the text is delivered to the LLM as the next event, bypassing the queue |
| `/skip` | Abort the currently running LLM cycle |
| `/kill` | Delete all pending (not yet running) events from the queue |

`sessions.switch.v1` enqueues the switch and returns immediately. The new session becomes active before the next event is processed by the LLM loop, but `sessions.active.v1` called immediately after may still return the previous ID.

Combine `/interrupt` and `/skip` for immediate effect: `/interrupt` sets the slot, then `/skip` aborts the current run so the interrupt is picked up next.
