# HYDRA.md

> Multi-agent instructions for **Hydra**. Shared reference for all agents.
> Per-agent files (`CLAUDE.md`, `OPUS.md`, `AGENTS.md`) take precedence for agent-specific details.

## Project Overview

Hydra is a multi-agent AI orchestration system that coordinates three roles — **Claude** (architect), **Opus** (critique), and **Codex** (implementer) — through a shared HTTP daemon, task queue, intelligent routing, and multi-round Council.

The critique role keeps the agent id `opus`. It runs the Cursor Agent CLI (`agent`) with model `grok-4.7-high` in ask mode (read-only). Default Council does not use the Gemini CLI.

The daemon listens on `localhost:4173` and exposes an HTTP API for tasks, coordination, and events. The operator console (REPL) and desktop GUI are the primary UIs.

## Code Conventions

- **ESM only** — `"type": "module"` in package.json. Use `import`/`export`. No CommonJS.
- **Agent names** are always lowercase: `claude`, `opus`, `codex`, `local`.
- **Terminal colors** — `picocolors` (`pc`) only.
- **No build step** — pure ESM on Node.js 20+.
- **Dependencies** — `picocolors`, `cross-spawn`, `@modelcontextprotocol/sdk`, `zod`.
- **Config-driven models** — use `getActiveModel(agent)` or `getRoleConfig(role)`. Do not hardcode model IDs.
- **HTTP helpers** — `request()` from `hydra-utils.mjs` for daemon calls.

## Coordination Protocol

1. `hydra_handoffs_pending` with your agent name at session start
2. `hydra_tasks_claim` before starting work
3. `hydra_tasks_update` when done or blocked
4. `hydra_ask` to consult another agent
5. `hydra_council_request` for complex architectural decisions

## @claude

Claude is the **architect** — design, planning, and architectural decisions.

- Primary reference: `CLAUDE.md`
- Prefer the project’s development branch; do not push force to default branches.
- Update docs when architecture or user-facing behavior changes.
- Use `hydra_ask` with `agent: "opus"` for critique and `agent: "codex"` for implementation.

## @opus

Opus is the **critique** — review, research, security analysis, and challenging plans.

- Primary reference: `OPUS.md`
- Cursor CLI `agent`, model `getActiveModel('opus')` (`grok-4.7-high`), `--mode ask`
- Be specific; suggest concrete fixes; report via `hydra_tasks_update`

## @codex

Codex is the **implementer** — code generation, refactoring, and tests.

- Primary reference: `AGENTS.md`
- Prefer `node:test` + `node:assert/strict`
- Claim the task first; report changes and tests via `hydra_tasks_update`
- Always pass an explicit `--model` when invoked headlessly

## Working rules

1. Agents collaborate. If one fails, others diagnose and fix in this repo when possible.
2. Verify logs, processes, files, and code yourself before asking the human.
3. If the GUI shows Council running while all agents look idle, treat it as a display bug and fix status reporting.
4. GUI answers must be readable text (not truncated JSON) and copyable.
5. Opus = `claude` CLI + Opus model. Claude: `bypassPermissions`. Codex: `danger-full-access`. Chat is concierge, not an agent head.
6. Do not create tasks for agent `local` unless a local LLM is explicitly enabled for the project.
7. Never commit secrets (`.env`, API keys, tokens).

## Household PC / USB_E12 (Pavel) — HARD BANS

This machine’s PCMonitor (Waveshare 8") sits on motherboard header **USB_E12** (ASUS ROG Maximus Z790 Hero, manual item 11). Known facts live in `C:\Users\timti\Documents\Cursor\PC\household.md` — **read that first**, do not ask Pavel what the board is or what E12 means.

**Never advise / never assign as human homework:**
- Multimeter / USB voltmeter / “measure 5 V”
- “Try another rear USB port” / “unplug the monitor as a test” as the main answer
- “What motherboard model?” / “What does E12 mean?” / “What voltage did you measure?”
- Rewiring Corsair / iCUE / fans onto another header
- Generic `human_decision` that dumps physical lab work on Pavel

**When USB_E12 blinks / no gadget after hard power-cycle:** say so briefly, cite the known latch (ErP / +5V rail), and stop. Do not invent homework. Soft isolation script is `C:\Users\timti\scripts\usb_e12_lock.ps1` (HS05 only). Corsair is on a **different** connector (HS10) — leave it.

## Testing

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
```

```bash
npm test
node --test test/hydra-ui.test.mjs
```
