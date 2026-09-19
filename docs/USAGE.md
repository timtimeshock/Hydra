# Usage & Command Reference

## Daemon Commands

### Start Daemon
```powershell
node lib/orchestrator-daemon.mjs start [host=127.0.0.1] [port=4173]
# or: npm start
# or: hydra-daemon start
```

### Check Status
```powershell
node lib/orchestrator-daemon.mjs status [url=http://127.0.0.1:4173]
# or: hydra-daemon status
```

### Stop Daemon
```powershell
node lib/orchestrator-daemon.mjs stop [url=http://127.0.0.1:4173]
# or: npm run stop
# or: hydra-daemon stop
```

## MCP Setup

Register Hydra's MCP server with installed AI CLIs:

```bash
hydra setup              # Register with all detected CLIs
hydra setup --force      # Overwrite existing registrations
hydra setup --uninstall  # Remove registrations
```

Initialize a project with Hydra coordination instructions:

```bash
hydra init                         # Generate HYDRA.md in current directory
hydra init --project-name=MyApp    # With custom project name
```

This creates `HYDRA.md` and syncs per-agent instruction files (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`).

## Client Commands

All client commands use: `node lib/orchestrator-client.mjs <command> [key=value]`

### Dashboard & State

| Command | Description |
|---------|-------------|
| `summary` | Full dashboard with tasks, agents, handoffs |
| `status` | Daemon health check |
| `state` | Raw sync state JSON |
| `stats` | Agent metrics & usage dashboard |
| `events [limit=50]` | Recent daemon events |

### Task Management

| Command | Description |
|---------|-------------|
| `task:add title=... [owner=...] [status=todo] [type=...] [files=...] [notes=...] [blockedBy=...]` | Create a task |
| `task:update taskId=... [status=...] [owner=...] [notes=...] [files=...] [blockedBy=...]` | Update a task |
| `task:route taskId=...` | Get best agent for a task |
| `claim agent=... [taskId=... \| title=...]` | Claim/create a task (returns claimToken) |
| `verify taskId=...` | Run project-aware verification |
| `checkpoint taskId=... name=... context=... [agent=...]` | Save task checkpoint |

### Agent Coordination

| Command | Description |
|---------|-------------|
| `next agent=NAME` | Suggested next action for an agent |
| `prompt agent=NAME` | Context prompt for an agent |
| `handoff from=... to=... summary=... [nextStep=...] [tasks=...]` | Create handoff |
| `handoff:ack handoffId=... agent=...` | Acknowledge handoff |

### Session & Decisions

| Command | Description |
|---------|-------------|
| `session:start focus=... [owner=human] [participants=...] [branch=...]` | Start coordination session |
| `session:fork` | Fork current session (copy state for alternative exploration) |
| `session:spawn focus=...` | Spawn child session (fresh state for focused subtask) |
| `sessions` | List all sessions including forks/spawns |
| `decision:add title=... [owner=...] [rationale=...] [impact=...]` | Record a decision |
| `blocker:add title=... [owner=...] [nextStep=...]` | Record a blocker |

### Model Management

```powershell
# Show active models
node lib/orchestrator-client.mjs model

# Switch Claude to Sonnet
node lib/orchestrator-client.mjs model claude=sonnet

# Switch multiple agents
node lib/orchestrator-client.mjs model claude=sonnet gemini=flash

# Reset to default
node lib/orchestrator-client.mjs model claude=default

# Interactive model picker (arrow keys, type-to-filter)
node lib/orchestrator-client.mjs model:select
node lib/orchestrator-client.mjs model:select claude

# List all available models per agent (read-only)
node lib/hydra-models.mjs
node lib/hydra-models.mjs claude
# or: npm run models
```

**Interactive model selector** (`model:select` / `:model:select`):
1. Pick an agent (or pass agent name to skip)
2. Browse all available models — discovered via REST API, CLI query, or config fallback
3. Type to filter the model list
4. Select reasoning effort level (low / medium / high / xhigh)
5. Selection sets mode to `custom` and persists to `hydra.config.json`

**Shorthand aliases:**
- Gemini: `pro`, `flash`, `default`, `fast`
- Codex: `gpt-5`, `gpt-5.4`, `gpt-5.2-codex`, `o4-mini`, `default`, `fast`, `cheap`
- Claude: `opus`, `sonnet`, `haiku`, `default`, `fast`, `cheap`

Legacy Codex aliases `codex-5.2` and `gpt-5.2-codex` are auto-normalized to `gpt-5.2-codex`. The default is now `gpt-5.4`.

**Reasoning effort** (Codex only — passed as `--reasoning-effort` CLI flag):
- Levels: `low`, `medium`, `high`, `xhigh`
- Set via interactive picker or config: `models.<agent>.reasoningEffort`
- Shown in `:model` display, model listings, and status bar

### Utility

| Command | Description |
|---------|-------------|
| `init` | Initialize Hydra for the current project |
| `archive` | Archive completed tasks/handoffs |
| `archive:status` | Show archive stats |

Add `json=true` to any command for raw JSON output.

## Operator Console

Interactive command center for dispatching prompts:

```powershell
node lib/hydra-operator.mjs             # Interactive mode
node lib/hydra-operator.mjs prompt="..." # One-shot mode
# or: npm run go
```

### Interactive Commands

| Command | Description |
|---------|-------------|
| `:help` | Show help |
| `:status` | Dashboard with agents & tasks |
| `:mode auto` | Mini-round triage then delegate/escalate |
| `:mode handoff` | Direct handoffs (fast, no triage) |
| `:mode council` | Full council deliberation |
| `:mode dispatch` | Headless pipeline |
| `:model` | Show active models + reasoning effort |
| `:model claude=sonnet` | Switch agent model |
| `:model:select [agent]` | Interactive model + effort picker |
| `:usage` | Token usage & contingencies |
| `:stats` | Agent metrics & performance |
| `:fork` | Fork current session (explore alternatives) |
| `:spawn <focus>` | Spawn child session for focused subtask |
| `:pause [reason]` | Pause the active session |
| `:unpause` | Resume a paused session |
| `:resume` | Ack handoffs, reset stale tasks, launch agents |
| `:chat` | Toggle concierge on/off |
| `:chat off` | Disable concierge |
| `:chat reset` | Clear concierge conversation history |
| `:chat stats` | Show concierge token usage + provider info |
| `:chat model` | Show active model + fallback chain |
| `:chat model <name>` | Switch concierge model (e.g. `sonnet`, `flash`, `gpt-5`) |
| `:chat export` | Export conversation to JSON file |
| `:workers` | Show worker status |
| `:workers start [agent]` | Start worker(s) |
| `:workers stop [agent]` | Stop worker(s) |
| `:workers restart` | Restart all workers |
| `:workers mode <mode>` | Change permission mode (auto-edit/full-auto) |
| `:watch <agent>` | Open visible terminal for agent observation |
| `:confirm` | Show/toggle dispatch confirmations |
| `:quit` | Exit console |
| `<any text>` | Chat with concierge (or dispatch if concierge is off) |
| `!<prompt>` | Force dispatch (bypass concierge) |
| `agents=claude,gemini <prompt>` | Dispatch with agent filter |

### Concierge

The concierge is a multi-provider conversational AI layer with automatic fallback: OpenAI → Anthropic → Google. It is **active by default** — every prompt goes through the concierge before anything else.

**Behavior:**
- Questions and discussion are answered directly by the concierge (no agent dispatch)
- Work requests (code changes, debugging, etc.) are automatically escalated to the dispatch pipeline
- Unrecognized `:commands` are first matched locally via fuzzy matching (Levenshtein distance ≤ 2), then routed to the concierge for suggestion
- Prefix with `!` to bypass the concierge and dispatch directly: `!fix the auth bug`
- Every 5 turns, a summary event is posted to the daemon for agent awareness
- On dispatch, conversation context (last 3 messages) is included so agents understand why

**Visual indicators:**
- Prompt shows active model: `hydra⬢[gpt-5]>` (or `hydra⬢[sonnet ↓]>` for fallback)
- Status bar mode icon shows `⬢` (chat mode)
- Concierge responses are streamed in blue with cost estimate `[~$0.0042]`
- Welcome message on first activation shows model, quick help, and available commands
- Streaming spinner appears while waiting for first response token
- Ghost text placeholder hints cycle contextually after each prompt

**Model switching:**
- `:chat model` — display active model and full fallback chain with availability
- `:chat model sonnet` — switch to Anthropic Sonnet at runtime
- `:chat model flash` — switch to Google Gemini Flash
- `:chat model gpt-5` — switch to specific model ID

**Conversation export:**
- `:chat export` — saves conversation history to `docs/coordination/concierge_export_<timestamp>.json`
- Includes provider info, turn count, stats, and all messages

**Requires:** At least one API key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`/`GOOGLE_API_KEY`. The concierge uses whichever providers are available, falling through the chain. Without any key, concierge is unavailable and prompts go directly to the dispatch pipeline.

### Operator Modes

- **auto** (default): Runs a mini-round triage, then either delegates via handoff or escalates to full council
- **handoff**: Direct delegation to all agents (fastest, no triage)
- **council**: Full multi-round deliberation with structured synthesis (Claude propose -> Gemini critique -> Claude refine -> Codex implement)
- **dispatch**: Headless pipeline (Claude coordinate -> Gemini critique -> Codex synthesize)
- **smart**: Auto-selects model tier per prompt complexity (simple->economy, medium->balanced, complex->performance)
- **chat**: Concierge conversation mode (set automatically when concierge is active)

### Status Bar

When the operator console is running in a TTY terminal, a persistent 5-line status bar is pinned to the bottom of the screen:

| Line | Content |
|------|---------|
| 1 | Divider |
| 2 | Mode icon, open task count, last dispatch route, session cost, today's tokens |
| 3 | Per-agent status: health indicator, icon, name, current action, model, elapsed time |
| 4 | Rolling activity ticker (last 3 events with timestamps) |
| 5 | Spacer |

The status bar uses SSE (`/events/stream`) for real-time updates, falling back to polling when SSE is unavailable. Agent status shows rich metadata including active model, task title, council phase, and step progress.

### Agent Terminal Auto-Launch

On Windows, the operator console automatically launches separate terminal windows for each agent head using `hydra-head.ps1`. It detects Windows Terminal (`wt.exe`) or falls back to PowerShell. Each head polls the daemon for handoffs and tasks to pick up.

## Council Mode

Full multi-round deliberation with structured synthesis:

```powershell
node lib/hydra-council.mjs prompt="..." [rounds=2] [mode=live|preview] [publish=true|false]
# or: npm run council -- prompt="..."
```

Options:
- `rounds=2` — Number of deliberation rounds (1-4)
- `mode=preview` — Dry run without calling agents
- `publish=true` — Push decisions/tasks to daemon
- `emit=json` — Output raw JSON instead of summary
- `save=true` — Save run report to coordination/runs/
- `agents=claude,gemini` — Limit which agents participate in the council flow

Council convergence is criteria-driven rather than majority-vote based. Each phase can emit options, tradeoffs (`correctness`, `complexity`, `reversibility`, `user_impact`), assumptions, and assumption challenges; the final Codex phase synthesizes those into a single decision, next action, and reversible first step.

## Dispatch Mode

Single-pass headless pipeline:

```powershell
node lib/hydra-dispatch.mjs prompt="..." [mode=live|preview] [save=true]
# or: npm run dispatch -- prompt="..."
```

## Usage Monitor

Standalone token usage monitoring:

```powershell
node lib/hydra-usage.mjs
# or: npm run usage
```

Reads `~/.claude/stats-cache.json` and reports:
- Token consumption vs daily budget
- Per-model breakdown
- Activity stats (messages, sessions, tool calls)
- Contingency options at warning/critical levels

Exit code: 0 if normal/warning, 1 if critical.

## Config File

`hydra.config.json` at the Hydra root:

```json
{
  "version": 2,
  "mode": "performance",
  "models": {
    "gemini": {
      "default": "gemini-2.5-pro",
      "fast": "gemini-2.5-flash",
      "cheap": "gemini-2.5-flash",
      "active": "default"
    },
    "codex": {
      "default": "gpt-5.4",
      "fast": "o4-mini",
      "cheap": "o4-mini",
      "active": "default",
      "reasoningEffort": null
    },
    "claude": {
      "default": "claude-opus-4-6",
      "fast": "claude-sonnet-4-5-20250929",
      "cheap": "claude-haiku-4-5-20251001",
      "active": "default",
      "reasoningEffort": null
    }
  },
  "aliases": {
    "gemini": { "pro": "gemini-2.5-pro", "flash": "gemini-2.5-flash" },
    "codex": { "gpt5": "gpt-5", "gpt-5": "gpt-5", "gpt-5.4": "gpt-5.4", "gpt-5.2-codex": "gpt-5.2-codex", "codex-5.2": "gpt-5.2-codex", "o4-mini": "o4-mini" },
    "claude": { "opus": "claude-opus-4-6", "sonnet": "claude-sonnet-4-5-20250929", "haiku": "claude-haiku-4-5-20251001" }
  },
  "modeTiers": {
    "performance": { "gemini": "default", "codex": "default", "claude": "default" },
    "balanced": { "gemini": "default", "codex": "fast", "claude": "default" },
    "economy": { "gemini": "fast", "codex": "cheap", "claude": "fast" },
    "custom": { "gemini": "default", "codex": "default", "claude": "default" }
  },
  "usage": {
    "warningThresholdPercent": 80,
    "criticalThresholdPercent": 90,
    "claudeStatsPath": "auto",
    "dailyTokenBudget": {
      "claude-opus-4-6": 2000000,
      "claude-sonnet-4-5-20250929": 5000000
    }
  },
  "verification": {
    "onTaskDone": true,
    "command": "auto",
    "timeoutMs": 60000
  },
  "stats": {
    "retentionDays": 30
  },
  "concierge": {
    "enabled": true,
    "model": "gpt-5",
    "reasoningEffort": "xhigh",
    "maxHistoryMessages": 40,
    "autoActivate": true,
    "fallbackChain": [
      { "provider": "openai", "model": "gpt-5" },
      { "provider": "anthropic", "model": "claude-sonnet-4-5-20250929" },
      { "provider": "google", "model": "gemini-2.5-flash" }
    ],
    "showProviderInPrompt": true,
    "welcomeMessage": true
  },
  "workers": {
    "permissionMode": "auto-edit",
    "autoStart": true,
    "pollIntervalMs": 1500,
    "maxOutputBufferKB": 8,
    "autoChain": true
  },
  "worktrees": {
    "enabled": false,
    "basePath": ".hydra/worktrees",
    "autoCleanup": true,
    "branchPrefix": "hydra/"
  },
  "crossModelVerification": {
    "enabled": true,
    "mode": "on-complex",
    "pairings": {
      "gemini": "claude",
      "codex": "claude",
      "claude": "gemini"
    }
  },
  "mcp": {
    "codex": {
      "enabled": false,
      "command": "codex",
      "args": ["mcp-server"],
      "sessionTimeout": 300000
    }
  }
}
```

### Model Resolution Priority

1. Environment variable: `HYDRA_CLAUDE_MODEL=sonnet`
2. Config file explicit override: `models.claude.active` (when not `default`)
3. Mode tier preset: `modeTiers[mode].claude`
4. Default: `models.claude.default`

### Custom Mode

When you select a model via the interactive picker (`:model:select`), the mode is set to `custom`. This preserves your per-agent overrides instead of resetting to a tier preset. The `custom` mode tier defaults all agents to `default` but respects explicit `active` overrides.

### Reasoning Effort

Per-agent reasoning effort level stored in `models.<agent>.reasoningEffort`. Values: `low`, `medium`, `high`, `xhigh`, or `null` (default). Currently passed as `--reasoning-effort` CLI flag for Codex. Set via the interactive picker or directly in config.

### Aliases

The `aliases` section maps shorthand names to full model IDs per agent. These are resolved first when using `hydra model claude=sonnet`. Add custom aliases to avoid typing long model IDs.

### Usage Thresholds

- **Warning** (default 80%): One-line alert before agent calls
- **Critical** (default 90%): Auto-switch to fast model, show contingency menu

### Verification

- `verification.onTaskDone=true`: Run auto-verification whenever a task moves to `done`
- `verification.command="auto"`: Auto-detect command by project type (`npm run typecheck`, `cargo check`, `go test ./...`, etc.)
- `verification.command="off"`: Disable verification
- `verification.command="<custom command>"`: Force a specific command

### Worktrees

- `worktrees.enabled=false`: Disabled by default; enable for per-task git worktree isolation
- `worktrees.basePath=".hydra/worktrees"`: Directory for worktree checkouts
- `worktrees.autoCleanup=true`: Automatically remove worktrees when tasks complete
- `worktrees.branchPrefix="hydra/"`: Branch naming prefix (branches created as `hydra/<taskId>`)

### Cross-Model Verification

- `crossModelVerification.enabled=true`: Enable cross-model review pipeline
- `crossModelVerification.mode`: `"always"` | `"on-complex"` (default) | `"off"`
- `crossModelVerification.pairings`: Maps each producer agent to its verifier agent

### Concierge

- `concierge.enabled=true`: Enable the concierge feature (set `false` to remove it entirely)
- `concierge.model="gpt-5"`: Primary model for the conversational layer
- `concierge.reasoningEffort="xhigh"`: Reasoning effort level sent to the API
- `concierge.maxHistoryMessages=40`: Maximum conversation history messages (oldest pairs trimmed)
- `concierge.autoActivate=true`: Concierge is on at startup (set `false` to require `:chat` to enable)
- `concierge.fallbackChain=[...]`: Ordered list of `{provider, model}` entries for automatic failover
- `concierge.showProviderInPrompt=true`: Show active model name in the operator prompt
- `concierge.welcomeMessage=true`: Show welcome message on first concierge activation

### Workers

- `workers.permissionMode="auto-edit"`: Default permission mode for headless workers
- `workers.autoStart=true`: Auto-start workers after dispatch
- `workers.pollIntervalMs=1500`: Daemon polling interval for workers
- `workers.maxOutputBufferKB=8`: Max output buffer per worker
- `workers.autoChain=true`: Workers auto-chain to next task after completing one

### MCP (Model Context Protocol)

- `mcp.codex.enabled=false`: Disabled by default; enable to use Codex via persistent MCP server
- `mcp.codex.command="codex"`: Command to start the MCP server
- `mcp.codex.args=["mcp-server"]`: Arguments for the MCP server command
- `mcp.codex.sessionTimeout=300000`: Idle timeout (ms) before auto-closing the MCP server

## Hydra CLI (Global Install)

After running `pwsh -File .\bin\install-hydra-cli.ps1` (or `npm run install:global`), use:

```powershell
hydra                                 # operator (mode=auto)
hydra --prompt "Fix flaky tests"      # one-shot prompt
hydra --mode smart --prompt "..."     # operator options (maps to key=value)
hydra --full                          # full PowerShell launcher (daemon + heads + operator)
hydra-client init                     # initialize docs/coordination in current project
hydra-daemon status                   # daemon utility binary
```

Standalone exe build:

```powershell
npm run build:exe
.\dist\hydra.exe --help
.\dist\hydra.exe --prompt "triage failing tests"
```

## Legacy PowerShell Launcher

Full multi-terminal launch:

```powershell
pwsh -File bin/hydra.ps1 [-Prompt "..."]
```

This starts:
1. Daemon (if not running)
2. Three agent head terminals (Gemini, Codex, Claude)
3. Operator console

One-shot mode: `pwsh -File bin/hydra.ps1 -Prompt "Your objective"`

## Daemon HTTP API

### Read Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Daemon health check |
| `GET /state` | Full sync state |
| `GET /summary` | Dashboard summary |
| `GET /events?limit=N` | Recent events |
| `GET /events/stream` | SSE event stream |
| `GET /events/replay?from=N&category=X` | Replay events since sequence N, optional category filter |
| `GET /next?agent=NAME` | Suggested next action |
| `GET /prompt?agent=NAME` | Context prompt for agent |
| `GET /task/:id/checkpoints` | List checkpoints for a task |
| `GET /sessions` | List all sessions (root, forks, spawns) |
| `GET /worktrees` | List active git worktrees |
| `GET /session/status` | Session health: stale tasks, pending handoffs, agent suggestions |
| `GET /tasks/stale` | List tasks marked as stale (30+ min without update) |
| `GET /stats` | Agent metrics + usage dashboard data |

### Write Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /task/add` | Create task (optional `worktree: true` for isolation) |
| `POST /task/update` | Update task (supports `claimToken` validation, `force` override) |
| `POST /task/claim` | Claim task atomically (returns `claimToken`) |
| `POST /task/route` | Get best agent for a task |
| `POST /task/checkpoint` | Save intermediate checkpoint on a task |
| `POST /handoff` | Create agent handoff |
| `POST /handoff/ack` | Acknowledge handoff |
| `POST /session/start` | Start coordination session |
| `POST /session/fork` | Fork current session (copy state) |
| `POST /session/spawn` | Spawn child session (fresh state with focus) |
| `POST /decision` | Record decision |
| `POST /blocker` | Record blocker |
| `POST /verify` | Run verification for a task |
| `POST /session/pause` | Pause an active session |
| `POST /session/resume` | Resume a paused session |
| `POST /archive` | Archive completed items |
| `POST /state/archive` | Archive completed tasks/handoffs to file |
| `POST /events/push` | Push concierge events (dispatch, summary, error, model_switch) |
| `POST /shutdown` | Graceful daemon shutdown |

## Hydra MCP Server

Run Hydra as an MCP server for agent self-coordination:

```powershell
node lib/hydra-mcp-server.mjs
```

Communicates via JSON-RPC over stdio. Available tools:

| Tool | Description |
|------|-------------|
| `hydra_tasks_list` | List open tasks with optional status/agent filters |
| `hydra_tasks_claim` | Claim a task atomically |
| `hydra_tasks_update` | Update task status and notes |
| `hydra_tasks_checkpoint` | Save task checkpoint |
| `hydra_handoffs_pending` | Get pending handoffs for an agent |
| `hydra_handoffs_ack` | Acknowledge a handoff |
| `hydra_council_request` | Request council deliberation on a prompt |
| `hydra_status` | Get daemon health and summary |
