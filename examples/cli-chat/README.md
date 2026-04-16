# cli-chat example module

`cli-chat` is a local CLI messaging module for `justclaw`.

- daemon: `examples/cli-chat/main.ts`
- client: `examples/cli-chat/client.ts`

The daemon receives input from the client over a Unix socket and forwards normal lines to the core as `event.v1` (`kind: "message.received"`).

## Session commands

Lines starting with `/` are treated as local commands and are not emitted as chat events.

- `/sessions`
  - Calls `sessions.list.v1` and `sessions.active.v1`
  - Prints all known session IDs in oldest-first order with numbers (`[1]`, `[2]`, ...)
  - Marks the active session with `*`
- `/session <id|number>`
  - Calls `sessions.switch.v1`
  - Queues a switch to an existing session by explicit ID or by the number from `/sessions`
- `/new`
  - Calls `sessions.new.v1` then `sessions.switch.v1`
  - Creates a new session and queues a switch to it
- `/log [id|number]`
  - Calls `sessions.get.v1`
  - Prints the selected session history in a readable one-line format (last 20 items)
  - If omitted, uses the active session

## Notes

- `sessions.switch.v1` returns when the switch is enqueued. The actual active session is applied asynchronously by the LLM loop.
- Unknown slash commands print a short usage hint.
