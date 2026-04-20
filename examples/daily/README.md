# daily

A timer module for `justclaw` that fires on a cron schedule and asks the LLM to write a daily log entry.

## Files

| File | Description |
|---|---|
| `module.json` | Module manifest (`mode: "timer"`, cron schedule) |
| `main.ts` | Timer process; emits one `event.v1` on each firing, then exits |

## Behavior

On each cron tick the module emits an event asking the LLM to append or update a Markdown file at `workspace/daily/{date}.md` (JST). The file is created if it does not exist.

The cron schedule (`0 23,3,7,11,15 * * *` UTC) fires at 08:00, 12:00, 16:00, 20:00, and 00:00 JST.

## Setup

Copy the module files to the modules directory:

```sh
mkdir -p $JUSTCLAW_HOME/modules/daily
cp module.json main.ts $JUSTCLAW_HOME/modules/daily/
```

The module starts automatically when the core starts. No additional configuration is required.
