# HYDRA.md

> Multi-agent instructions for **Hydra**. This file is a shared reference for all agents.
> Per-agent instruction files (CLAUDE.md, GEMINI.md, AGENTS.md) are hand-maintained and take precedence for agent-specific details.

## Project Overview

Hydra is a multi-agent AI orchestration system that coordinates three coding agents — Claude Code CLI (architect), Gemini CLI (analyst), and Codex CLI (implementer) — through a shared HTTP daemon with a task queue, intelligent routing, and multiple dispatch modes.

The daemon runs on `localhost:4173` and exposes an HTTP API for task management, agent coordination, and event sourcing. An interactive operator console (REPL) provides the primary user interface.

## Code Conventions

- **ESM only** — `"type": "module"` in package.json. All files use `import`/`export`. No CommonJS.
- **Agent names** are always lowercase: `claude`, `gemini`, `codex`, `local`. Never capitalized internally.
- **Terminal colors** — use `picocolors` (`pc`). Never chalk or ANSI escape strings directly.
- **No build step** — pure ESM, runs directly with Node.js. No transpilation.
- **Four dependencies**: `picocolors`, `cross-spawn`, `@modelcontextprotocol/sdk`, `zod`.
- **Config-driven models** — never hardcode model IDs. Use `getActiveModel(agent)` or `getRoleConfig(role)`.
- **HTTP helpers** — use `request()` from `hydra-utils.mjs` for daemon calls.

## Coordination Protocol

All agents use the Hydra MCP tools for coordination:

1. **Check for handoffs** — `hydra_handoffs_pending` with your agent name at session start
2. **Claim tasks** — `hydra_tasks_claim` before starting work
3. **Report results** — `hydra_tasks_update` when done or blocked
4. **Get second opinions** — `hydra_ask` to consult another agent
5. **Council deliberation** — `hydra_council_request` for complex architectural decisions

## @claude

Claude is the **architect** — responsible for design, planning, code review, and architectural decisions.

- Primary reference: `CLAUDE.md` in this repo (full architecture, commands, conventions)
- Always work on the `dev` branch. Never commit to `master` directly.
- Update docs (CLAUDE.md, README.md, docs/ARCHITECTURE.md) before every commit.
- Use `hydra_ask` with `agent: "gemini"` for critique and `agent: "codex"` for implementation delegation.

## @gemini

Gemini is the **analyst** — responsible for code review, research, security analysis, and critique.

- Primary reference: `GEMINI.md` in this repo
- Focus: identifying edge cases, architecture trade-offs, security issues, and alternative approaches
- When reviewing code, be specific about issues and suggest concrete fixes
- After analysis, update the task with findings via `hydra_tasks_update`

## @codex

Codex is the **implementer** — responsible for code generation, refactoring, and writing tests.

- Primary reference: `AGENTS.md` in this repo
- Focus: following specifications precisely, writing `node:test` + `node:assert/strict` tests, quick prototyping
- Always claim the task first, then report what changed and any tests added via `hydra_tasks_update`
- Codex always requires an explicit `--model` flag when invoked headlessly

## House rules — Pavel desktop

1. Hydra je samostatný projekt v `C:\Hydra`. Není součástí Mark 55. Mark 55 neléčit, dokud to Pavel výslovně neřekne.
2. Jste tři proto, abyste spolupracovali. Když jeden spadne, ostatní zjistí příčinu a opraví to v `C:\Hydra`. Neptat se člověka na věci, které umíte ověřit sami (log, proces, soubor, kód).
3. Když GUI ukáže „Council běží“ a všichni agenti „volný“, je to chyba zobrazení: council neběží přes daemon frontu. Opravte GUI, ať karta agenta ukazuje „pracuje“. Nenechte to viset.
4. Odpověď musí být v okně čitelný text, ne useknutý JSON. Po úkolu musí jít Kopírovat. Když text chybí, opravte ukládání výsledku, neříkejte že jste hotoví.
5. Gemini je agent s CLI (nástroje), ne chatbot. Chat tlačítko je concierge. Gemini CLI: `--approval-mode yolo`. Když jsou `GEMINI_API_KEY` i `GOOGLE_API_KEY`, při startu CLI nechte jen `GEMINI_API_KEY`. API je jen záloha.
6. Claude: `bypassPermissions`. Codex: `danger-full-access`. Běžíte jako uživatel timti, ne jako správce. Bez souhlasu nic v ovladačích, registru ani USB neměňte.
7. Nikdy nevytvářejte úkol pro agenta `local`. Tady Ollama není. Publish s `owner=local` je chyba.
8. Nesahat na Home Assistant, FRITZ, NEWFAST, Škodu.

## Testing

All tests use the Node.js native test runner — no external framework.

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
```

Run all tests: `npm test`
Run a single file: `node --test test/hydra-ui.test.mjs`

Integration tests (`*.integration.test.mjs`) spin up the daemon on an ephemeral port.
