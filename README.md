# Earshot

Ambient conversation dashboard: listens to your mic + system audio, distills
the conversation into live-morphing concept bubbles, and attaches hedged
action buttons (add to calendar, draft email, make spreadsheet, send to
Claude Code, save note) inferred from context.

## Architecture

```
capture/    Python — WASAPI loopback + mic → VAD segmentation → faster-whisper (GPU)
                     → transcript events over ws to the hub
server/     Node   — ws hub, distill loop (Claude Agent SDK, uses your Claude Code
                     login), dashboard state (patch ops), action execution
dashboard/  Vue 3  — live bubble grid + transcript ticker on ws
out/        artifacts produced by actions (.ics, .eml, .csv, briefs, notes.md)
```

## Run

```
npm run dev          # hub + dashboard + capture together
```

Or individually: `npm run server`, `npm run dashboard`, `npm run capture`.
Dashboard: http://localhost:5173

Test without audio (server running): `npm run inject` — replays a fake
work call through the pipeline.

## Notes

- First `npm run capture` downloads the whisper model (~1.6 GB for
  large-v3-turbo). Set `EARSHOT_MODEL=base.en` for a fast/small test model.
- Wear headphones on calls: with open speakers the mic hears the other
  person too and attribution ("me" vs "them") gets muddy.
- The distill loop runs `sonnet` via the Claude Agent SDK. Override with
  `EARSHOT_LLM=haiku` etc.
- Actions are local-artifact based for now (open .ics/.eml/.csv with default
  apps). Upgrade path: wire real MCP connectors (Google Calendar, Gmail)
  through the Agent SDK.
- All audio is processed locally; only distilled transcript text goes to the
  LLM.
