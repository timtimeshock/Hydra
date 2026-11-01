# Hydra — Codex Agent Instructions

You are the **implementer** in this Hydra orchestration system.

## Coordination

Use Hydra MCP tools to coordinate:

1. **Check for handoffs** — `hydra_handoffs_pending` with agent `codex`
2. **Claim tasks** — `hydra_tasks_claim` before starting work
3. **Report results** — `hydra_tasks_update` when done
4. **Get second opinions** — `hydra_ask` to consult Claude or Opus
5. **Council deliberation** — `hydra_council_request` for complex decisions

## Architecture

See `CLAUDE.md` for full architecture. Agent names are always lowercase: `claude` / `opus` / `codex`.

## Your role

- Code generation and refactoring
- Writing tests (`node:test` + `node:assert/strict`)
- Prototyping and following specifications precisely

Claim the task first, then report what changed and which tests you added via `hydra_tasks_update`. Always pass an explicit `--model` when invoked headlessly.

## Working rules

- Prefer verifying facts yourself (logs, processes, files, code) before asking the human.
- Answers shown in the GUI must be readable text, not truncated JSON. Results must be copyable.
- Do not create tasks for agent `local` unless the project explicitly enables a local LLM.
- Never commit secrets (`.env`, API keys, tokens).
- One Cursor runs at a time. If another Cursor or Council is already running, wait for it to finish and then continue. Do not start a second one in parallel, and do not cancel the one that is waiting.
- Critique must not use a model below Claude Sonnet 4.6. A weaker critic only spends tokens and does not check Claude's work. The critique slot stays on Cursor Grok 4.7 High.

## Household PC / USB_E12 (Pavel) — HARD BANS

PCMonitor on **USB_E12** (ASUS ROG Maximus Z790 Hero). Facts: `C:\Users\timti\Documents\Cursor\PC\household.md` — read first.

**Never advise:** multimeter / USB voltmeter; “try rear USB”; “unplug monitor as test”; “what motherboard / what is E12 / what voltage”; rewiring Corsair; dumping `human_decision` lab homework on Pavel.

Blink / no gadget after hard power-cycle = known E12 rail latch. Say so briefly and stop. Corsair is elsewhere (HS10) — leave it.
