# Hub Coordination Design

**Date:** 2026-03-07
**Status:** Approved
**Scope:** Hydra core + session-sync skill

---

## Problem

When a Hydra window deploys multiple LLMs (Gemini, Codex, forge agents) alongside one or more Claude Code CLI terminals working on the same project, there is no shared coordination point. Each system operates independently — no visibility into what other agents are doing, which files they own, or where to hand off work.

## Goal

Create a **universal, peer-to-peer coordination hub** that all agents (Claude Code CLIs, Hydra daemon tasks, forge agents, future LLMs) write to and read from. No single authority. Works with or without the Hydra daemon.

---

## Architecture

### Hub Location

```
~/.claude/projects/<home-slug>/memory/sessions/
```

Where `<home-slug>` is derived from `os.homedir()` by replacing path separators with dashes (e.g. `C--Users-Chili`).

### Files in the Hub

| File | Purpose |
|------|---------|
| `PROTOCOL.md` | Machine-readable spec — any agent reads this to understand the hub |
| `sess_<timestamp>.json` | Active session registration (one per agent instance) |
| `handoff_<timestamp>.json` | Work left incomplete, for another agent to pick up |
| `activity.ndjson` | Append-only event log (register, checkpoint, deregister, handoff, conflict) |

### Session File Format

```json
{
  "id": "sess_20260307_143022",
  "agent": "claude-code",
  "taskId": "optional-hydra-task-id",
  "project": "PepperScale",
  "cwd": "/e/Dev/PepperScale",
  "focus": "Implementing auth router",
  "status": "working",
  "files": ["src/api/routes/auth.ts"],
  "startedAt": "2026-03-07T14:30:22Z",
  "lastUpdate": "2026-03-07T15:12:00Z"
}
```

**Field semantics:**
- `agent`: identifies the agent type. Known values: `claude-code`, `gemini-forge`, `codex-forge`, `hydra-tasks`, `hydra-nightly`, `hydra-evolve`
- `taskId`: links to the Hydra daemon task ID when both are present (optional)
- `cwd`: canonical project identifier — used for cross-agent filtering
- `status`: `working` | `idle` | `blocked` | `waiting`
- `files`: files this agent currently owns — checked for conflicts before other agents edit

**Stale threshold:** Files with `lastUpdate` older than 3 hours are treated as stale and cleaned automatically by `listSessions()`.

### Project Compartmentalization

All agents filter by `cwd` when reading siblings. A Claude Code session in `/e/Dev/PepperScale` only sees sessions where `cwd === "/e/Dev/PepperScale"`. The hub directory is shared; the `cwd` field is the partition key.

---

## New Module: `lib/hydra-hub.mjs`

Pure utility module. No side effects on import.

### Hub Path Derivation

```js
function deriveHubPath() {
  const home = os.homedir();
  // C:\Users\Chili → C--Users-Chili
  const slug = home
    .replace(/^([A-Za-z]):/, '$1-')   // drive colon → dash
    .replace(/[\\/]/g, '-')            // separators → dash
    .replace(/^-/, '');                // strip leading dash
  return path.join(home, '.claude', 'projects', slug, 'memory', 'sessions');
}
```

### Exported API

```js
hubPath()                              // → absolute path to hub dir
registerSession(opts)                  // write sess_<id>.json, log 'register' event
updateSession(id, updates)            // patch fields + touch lastUpdate
deregisterSession(id)                 // delete sess_<id>.json, log 'deregister' event
listSessions({ cwd? })               // read all, clean stale, filter by cwd if given
checkConflicts(plannedFiles, { cwd }) // return sessions claiming any of plannedFiles
logActivity(event)                    // append JSON line to activity.ndjson
```

**Atomic writes:** Write to `<id>.tmp` then `fs.renameSync` to final path — safe for concurrent agents on the same machine.

---

## Daemon Integration (`lib/daemon/write-routes.mjs`)

The Hydra daemon writes hub session files as part of its task lifecycle, so daemon-managed agents appear in the hub alongside Claude Code sessions.

| Daemon event | Hub action |
|-------------|------------|
| `POST /task/claim` | `hub.registerSession({ agent, taskId, project, cwd, focus })` |
| `POST /task/update` (status → `done`/`cancelled`) | `hub.deregisterSession(sessId)` |
| `POST /task/update` (other) | `hub.updateSession(sessId, { status, notes })` |

The daemon derives `cwd` and `project` from `resolveProject()` — the same context it already uses for all other coordination.

---

## Forge Agent Integration (`lib/hydra-shared/agent-executor.mjs`)

`executeAgent()` is the central function that spawns all sub-agents (forge, tasks, nightly, etc.). Hub registration wraps the full execution lifecycle:

```js
// Before spawn:
const sessId = hub.registerSession({
  agent: `${agentType}-forge`,
  cwd: process.cwd(),
  project: path.basename(process.cwd()),
  focus: prompt.slice(0, 100),
});

// After completion (success or error, in finally block):
hub.deregisterSession(sessId);
```

**Why Hydra manages forge sessions, not the agents themselves:** Gemini and Codex run as subprocesses and cannot reliably write to the hub path (they may not have file system access, and the hub path is machine-specific). Hydra knows their full lifecycle and handles registration on their behalf.

---

## New MCP Tools (`lib/hydra-mcp-server.mjs`)

All hub tools work in **standalone mode** (no daemon required) since they operate on the filesystem directly via `hydra-hub.mjs`.

### `hydra_hub_list`
List active sessions in the hub.
- Input: `{ cwd?: string }` — optional filter for same-project sessions
- Output: `{ sessions: Session[], hubPath: string }`

### `hydra_hub_register`
Register a Claude Code session in the hub via MCP (instead of writing files directly).
- Input: `{ agent, project, cwd, focus, files?, taskId? }`
- Output: `{ id: string, path: string }`

### `hydra_hub_deregister`
Remove a session from the hub at end of work.
- Input: `{ id: string }`
- Output: `{ ok: boolean }`

### `hydra_hub_update`
Update an active session's files, status, or focus.
- Input: `{ id: string, files?: string[], status?: string, focus?: string }`
- Output: `{ ok: boolean }`

### `hydra_hub_conflicts`
Check if any planned files are claimed by another active session in the same project.
- Input: `{ files: string[], cwd: string }`
- Output: `{ conflicts: Array<{ file, claimedBy: Session }> }`

---

## Session-Sync Skill Updates

**In Hydra mode (daemon running):**
- `registerSession` → call `hydra_hub_register` MCP tool
- Update files mid-session → call `hydra_hub_update`
- Before claiming files → call `hydra_hub_conflicts`
- End session → call `hydra_hub_deregister`

**In lite mode (no daemon):**
- Keep writing session files directly (unchanged behavior)
- Hub module format is identical — just no MCP indirection

**Addition:** Reference to `PROTOCOL.md` in the skill so any agent reading the skill knows where the canonical spec lives.

---

## PROTOCOL.md Contents

The file lives at `<hub>/PROTOCOL.md`. It is a self-contained spec for any agent:

- Hub location derivation formula
- Session file format (all fields with types and semantics)
- Known agent types and their roles
- Status value definitions
- File conflict protocol (check before edit, never silently override)
- Stale threshold (3 hours)
- Handoff file format
- Activity log format and event types
- How to register, update, and deregister

Any future LLM or agent that is given the hub path can read this file and participate without additional configuration.

---

## Implementation Sequence

1. **`hydra-hub.mjs`** — create the hub module (foundation for everything else)
2. **`PROTOCOL.md`** — write to hub path (documents the standard)
3. **MCP tools** — add hub tools to `hydra-mcp-server.mjs` (Claude Code integration)
4. **Daemon hooks** — update `write-routes.mjs` to sync task lifecycle to hub
5. **Forge hooks** — update `agent-executor.mjs` to register/deregister forge agents
6. **Session-sync skill** — update to use hub MCP tools in Hydra mode, reference PROTOCOL.md

---

## Out of Scope

- Hub-to-hub federation across machines
- Real-time hub change notifications (polling is sufficient)
- Authentication or access control on hub files
- Request/response files between agents (Hydra's `hydra_ask` covers this)
