---
name: write-module
description: >
  Write, create, or add a new justclaw module (daemon or timer). Use whenever
  asked to build a new integration, add a capability, implement a webhook,
  create a scheduled task, write a daemon, or extend the agent with any new
  module-based feature — even if the user just says "add X" or "make the agent
  do Y" and implementing it as a module is the right approach.
---

# Writing a justclaw Module

Modules are standalone executables that communicate with the core over NDJSON
(JSON-RPC 2.0) on stdin/stdout. They can be written in any language; use Bun
(`#!/usr/bin/env bun`) for TypeScript.

## Directory structure

Create the module under the modules directory shown in your runtime instructions:

```
{modulesDir}/
  {name}/
    module.json    # manifest
    main.ts        # entrypoint (or any name)
```

## module.json

**Daemon** — long-running, spawned when the core starts:

```json
{
  "name": "{name}",
  "exec": "main.ts",
  "mode": "daemon",
  "replyable": true
}
```

Set `replyable: true` when the module should receive `message.send.v1` notifications
(i.e., the LLM's replies should be routed here). Omit or set `false` otherwise.

**Timer** — one-shot, spawned on a cron schedule (UTC):

```json
{
  "name": "{name}",
  "exec": "main.ts",
  "mode": "timer",
  "cron": "0 9 * * 1-5"
}
```

## Wire protocol rules

- **stdout**: NDJSON only. One JSON object per line. Never write anything else.
- **stderr**: logs and debug output.
- All messages follow JSON-RPC 2.0: `{ "jsonrpc": "2.0", ... }`.

## Daemon skeleton

```typescript
#!/usr/bin/env bun

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitEvent(params: Record<string, unknown>): void {
  writeLine({ jsonrpc: "2.0", method: "event", params });
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg: unknown;
      try { msg = JSON.parse(line); } catch { continue; }

      const r = msg as Record<string, unknown>;
      if (r.jsonrpc !== "2.0") continue;

      if (r.method === "initialize") {
        writeLine({ jsonrpc: "2.0", id: r.id, result: { tools: [] } });
        // start any background work here (e.g. open a socket, start polling)

      } else if (typeof r.method === "string" && r.method.startsWith("tool/")) {
        // LLM called one of the tools declared in initialize
        writeLine({ jsonrpc: "2.0", id: r.id, result: { output: "ok" } });

      } else if (r.method === "event") {
        const p = r.params as Record<string, unknown>;
        if (p?.type === "message.send.v1") {
          // deliver (p.text as string) to the external system
        }

      } else if (r.method === "shutdown") {
        writeLine({ jsonrpc: "2.0", id: r.id, result: "ok" });
        process.exit(0);
      }
    }
  }
}

void main();
```

To emit an event when something happens externally (e.g. a message arrives):

```typescript
emitEvent({ type: "event.v1", kind: "message.received", user: "alice", text: "hello" });
```

## Timer skeleton

```typescript
#!/usr/bin/env bun

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg: unknown;
      try { msg = JSON.parse(line); } catch { continue; }

      const r = msg as Record<string, unknown>;
      if (r.method === "initialize") {
        writeLine({ jsonrpc: "2.0", id: r.id, result: { tools: [] } });
        writeLine({
          jsonrpc: "2.0",
          method: "event",
          params: { type: "event.v1", kind: "timer.fired", text: "..." },
        });
        process.exit(0);
      }
    }
  }
}

void main();
```

## Deploy

After writing the files, reload the modules:

```
restart_modules({ continuation: "" })
```

The module appears in the next LLM turn. Pass a non-empty `continuation` to
enqueue a follow-up event immediately after reload.
