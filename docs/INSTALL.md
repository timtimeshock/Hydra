# Installation Guide

All documentation is in **English**. Hydra is a local orchestrator for agent CLIs you install yourself.

## Prerequisites

| Requirement | Minimum | Notes |
|------------|---------|-------|
| **Node.js** | 20+ | Runs Hydra |
| **PowerShell** | 7+ | Windows launchers |
| **`claude` CLI** | Working on PATH | [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Opus uses this same binary. |
| **`codex` CLI** | Working on PATH | [Codex CLI](https://github.com/openai/codex) |
| **`gh` CLI** | Optional | GitHub features |

Hydra does **not** install or authenticate Claude/Codex. Any login that makes those CLIs work is fine.

### Install agent CLIs (your responsibility)

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

Verify outside Hydra (`claude -p "ping"`, `codex --help`) before debugging Hydra.

## Install Hydra

### 1. Clone

```bash
git clone https://github.com/timtimeshock/Hydra.git
cd Hydra
```

### 2. Dependencies

```bash
npm install
```

### 3. Setup (detect CLIs + default models + MCP)

```bash
npm run setup
```

### 4. Optional environment file

```bash
cp .env.example .env
# Fill only what you need. Prefer CLI login over keys when possible.
```

Never commit `.env`.

### 5. Optional global `hydra` command

```powershell
pwsh -File .\bin\install-hydra-cli.ps1
# or: npm run install:global
```

### 6. Verify

```bash
node lib/orchestrator-daemon.mjs help
node lib/hydra-gui.mjs          # open GUI → Diagnostics
node lib/hydra-operator.mjs     # operator console
```

### 7. Project init (optional)

```bash
cd /path/to/your/project
npx hydra init
# or: node /path/to/Hydra/lib/hydra-setup.mjs init
```

Creates coordination files under `docs/coordination/`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| GUI opens, agents fail | `claude` / `codex` missing or broken | Fix CLIs outside Hydra first |
| Diagnostics: missing CLI | Not on PATH | Install vendor CLI; restart terminal |
| Council empty / hang | Agent CLI cannot complete prompts | Test the CLI alone; check quotas |
| `setup` says not installed | Expected if CLI absent | Install CLI, re-run `npm run setup` |

## Package / Windows EXE

```bash
npm run package          # dist/*.tgz
npm run build:exe        # dist/hydra.exe (optional)
```

See root [README.md](../README.md) for architecture and commands.
