# CLAUDE.md

> **Note:** This file is internal developer tooling configuration for [Claude Code](https://claude.ai/code). It is not user-facing documentation — see [README.md](README.md) for project overview and usage.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branch Workflow

Always work on `dev`. Never commit to or switch to `master` unless explicitly told (e.g. "merge to master", "push d>m").

### Commit Rules

1. **Update documentation before every commit.** Before staging and committing, review what changed and update the relevant docs:
   - `CLAUDE.md` — if workflow, commands, conventions, or the architecture overview changed.
   - `README.md` — if user-facing features, setup steps, or usage changed. The **Operator Commands** table must be updated whenever a command is added/removed/renamed.
   - `docs/ARCHITECTURE.md` — if modules, exports, dispatch logic, or architectural patterns changed.
   - Inline code comments — only where logic isn't self-evident.
   - Skip doc updates only if the change is purely cosmetic or has zero doc impact.

2. **Always commit to `dev` first.** Never commit directly to `master`. When the user asks to merge or push to master, the flow is:
   - Ensure all changes are committed on `dev`.
   - Checkout `master`, merge `dev` into `master`, then switch back to `dev`.
   - Shorthand: "push d>m" or "merge to master" triggers this flow.

## Commands

```bash
npm test                    # Run all tests (Node.js native test runner)
node --test test/hydra-ui.test.mjs  # Run a single test file
npm start                   # Start the daemon (port 4173)
npm run go                  # Launch operator console (interactive REPL)
npm run council -- prompt="..." # Run council deliberation
npm run evolve              # Run autonomous self-improvement
npm run evolve:suggestions  # Manage evolve suggestions backlog
npm run init                # Generate HYDRA.md in current project (or pass a path)
npm run nightly             # Run nightly task automation
npm run setup               # Register Hydra MCP server in all detected AI CLIs
npm run tasks               # Scan & execute TODO/FIXME/issues autonomously
npm run tasks:review        # Interactive merge of tasks/* branches
npm run tasks:status        # Show latest tasks run report
npm run tasks:clean         # Delete all tasks/* branches
npm run eval                # Run routing evaluation against golden corpus
```

No linter or build step — pure ESM, runs directly with Node.js.

## Architecture

Hydra orchestrates three roles — **Claude** (architect), **Opus** (critique, same `claude` CLI + Opus model), and **Codex** (implementer) — through a shared HTTP daemon with task queue, intelligent routing, and Council.

### Core Flow

```
Operator Console (REPL) / Desktop GUI
    ├── Concierge (multi-provider chat when API keys configured)
    └── Daemon (HTTP API, port 4173, event-sourced state)
         ├── Claude  (architect)
         ├── Opus    (critique — claude CLI + Opus model)
         └── Codex   (implementer)
```

> For full module reference, dispatch modes, route strategies, and architectural patterns, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Code Conventions

- **ESM only** (`"type": "module"` in package.json). All files use `import`/`export`.
- **Four dependencies**: `picocolors` (terminal colors), `cross-spawn` (cross-platform spawning), `@modelcontextprotocol/sdk` (MCP server), `zod` (schema validation for MCP tools). Optional peer: `@opentelemetry/api` (tracing, no-op when absent).
- **Agent names** are always lowercase strings: `claude`, `opus`, `codex`, `local`, plus any user-defined names from `agents.customAgents[]`. `local` is an optional API-backed agent (via `hydra-local.mjs`, no CLI). Custom agents are registered via `:agents add` (wizard) or directly in `hydra.config.json`; type `cli` spawns a local CLI tool, type `api` calls an OpenAI-compatible endpoint. CLI agents missing from PATH fall back to cloud transparently via `executeAgentWithRecovery`. Config: `agents.customAgents[]` (see `hydra-agents-wizard.mjs`), `local.enabled`, `.baseUrl`, `.model`, `.budgetGate`. `routing.mode` (`economy`|`balanced`|`performance`) shifts affinity toward `local` in economy mode.
- **HTTP helpers**: Use `request()` from `hydra-utils.mjs` for daemon calls. Status bar uses `fetch()` directly (lightweight polling).
- **Config access**: `loadHydraConfig()` returns cached config. `getRoleConfig(roleName)` for role-specific model/agent lookups.
- **Model references**: Config-driven via `roles` and `models` sections in `hydra-config.mjs`. Don't hardcode model IDs — use `getActiveModel(agent)` or `getRoleConfig(role)`. Codex always requires an explicit `--model` flag (its own `~/.codex/config.toml` may differ from Hydra's config).
- **Interactive prompts**: Use `promptChoice()` from `hydra-prompt-choice.mjs` with cooperative readline lock. Boxes dynamically size to terminal width (60-120 columns, 90% of terminal width) and word-wrap long context values.
- **PowerShell launchers** in `bin/` — `hydra.ps1` starts the full system (daemon + agent heads + operator).

## Test Patterns

Tests use Node.js native `node:test` module with `node:assert`. No external test framework.

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
```

Integration tests (`*.integration.test.mjs`) spin up the daemon on an ephemeral port and test HTTP endpoints.

## MCP Tool Escalation

Two MCP servers are available when working in this project. Use them to get second opinions, delegate work, or cross-verify your reasoning.

### `hydra_ask` — Ask Opus or Codex directly

Invokes the agent CLI headlessly. No daemon needed.

- **`agent: "opus"`** — Same `claude` CLI with Opus model. Best for: code review, architecture critique, analysis, research, edge cases, security review.
- **`agent: "codex"`** — Codex CLI. Best for: implementation, refactoring, code generation, writing tests, quick prototyping.

**When to use:**
- Reviewing your own generated code for bugs or missed edge cases
- Getting an alternative implementation approach
- Security or concurrency analysis on tricky code
- When the user explicitly asks for a second opinion

**When NOT to use:**
- Trivial/obvious changes (a typo fix doesn't need review)
- Asking questions you already know the answer to
- Every single code change (be cost-conscious)

### `ask_gpt53` / `ask_gpt_fast` — OpenAI API calls

Direct OpenAI Responses API calls (separate from Hydra's agent CLIs).

- **`ask_gpt_fast`** (gpt-4.1-mini) — Cheap/fast. Quick summaries, small refactors, simple reviews.
- **`ask_gpt53`** (GPT-5.3) — Deep reasoning. Architecture decisions, complex bugs, security analysis.
- **`ask_gpt52`** — Alias for `ask_gpt53` (backward compat).

## Working rules

1. Prefer verifying logs, processes, files, and code yourself before asking the human.
2. If the GUI shows Council running while all agents look idle, treat it as a display bug and fix status reporting.
3. GUI answers must be readable text (not truncated JSON) and copyable.
4. Opus = `claude` CLI + Opus model. Chat is concierge, not an agent head.
5. Do not create tasks for agent `local` unless a local LLM is explicitly enabled.
6. Never commit secrets (`.env`, API keys, tokens).
