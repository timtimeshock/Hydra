# Contributing to Hydra

## Adding a New Agent

1. **Register in `lib/hydra-agents.mjs`**:

```js
export const AGENTS = {
  // ... existing agents ...
  newagent: {
    label: 'NewAgent 1.0',
    cli: 'newagent',
    invoke: {
      nonInteractive: (prompt) => ['newagent', ['-p', prompt, '--json']],
      interactive: (prompt) => ['newagent', [prompt]],
    },
    contextBudget: 100_000,
    contextTier: 'minimal', // minimal | medium | large
    strengths: ['...'],
    weaknesses: ['...'],
    councilRole: 'specialist',
    taskAffinity: {
      planning: 0.5,
      architecture: 0.5,
      review: 0.5,
      refactor: 0.5,
      implementation: 0.5,
      analysis: 0.5,
      testing: 0.5,
      research: 0.5,
      documentation: 0.5,
      security: 0.5,
    },
    rolePrompt: 'You are a specialist agent...',
    timeout: 5 * 60 * 1000,
  },
};
```

2. **Add to `KNOWN_OWNERS`**: Already auto-derived from `AGENTS` keys.

3. **Add model config in `hydra.config.json`**:

```json
"newagent": {
  "default": "newagent-v1",
  "fast": "newagent-mini",
  "active": "default"
}
```

4. **Add model aliases in `hydra-agents.mjs`**:

```js
const MODEL_ALIASES = {
  // ...
  newagent: { v1: 'newagent-v1', mini: 'newagent-mini' },
};

const MODEL_CLI_FLAGS = {
  // ...
  newagent: (modelId) => ['--model', modelId],
};
```

5. **Add context tier in `lib/hydra-context.mjs`** if needed.

6. **Add color in `lib/hydra-ui.mjs`**:

```js
const AGENT_COLORS = { /* ... */ newagent: pc.blue };
const AGENT_ICONS = { /* ... */ newagent: '\u2605' }; // ★
```

7. **Add to PowerShell head** in `bin/hydra-head.ps1` (ValidateSet and switch cases).

## Adding a New Model

1. **Add to `hydra.config.json`**:

```json
"claude": {
  "default": "claude-opus-4-6",
  "fast": "claude-sonnet-4-5-20250929",
  "cheap": "claude-haiku-4-5-20251001",
  "experimental": "claude-opus-4-7",  // new preset
  "active": "default"
}
```

2. **Add alias in `hydra-agents.mjs`**:

```js
const MODEL_ALIASES = {
  claude: {
    // ...
    experimental: 'claude-opus-4-7',
  },
};
```

3. **Add budget in config** (if Claude model):

```json
"dailyTokenBudget": {
  "claude-opus-4-7": 3000000
}
```

Users can then: `hydra model claude=experimental`

## Adding a Daemon Endpoint

Daemon routes are split into two files under `lib/daemon/`:
- `read-routes.mjs` — GET and SSE endpoints (read-only)
- `write-routes.mjs` — POST endpoints (state mutations)

Both export a single handler function that receives `(method, route, requestUrl, req, res, context)` where `context` contains daemon internals (`readState`, `enqueueMutation`, `sendJson`, `readJsonBody`, etc.).

1. **Add route handler** in the appropriate route file:

For read endpoints — `lib/daemon/read-routes.mjs`:
```js
if (method === 'GET' && route === '/my-endpoint') {
  const state = readState();
  const data = /* compute from state */;
  sendJson(res, 200, { ok: true, data });
  return true;  // return true = handled
}
```

For write endpoints — `lib/daemon/write-routes.mjs`:
```js
if (method === 'POST' && route === '/my-endpoint') {
  const body = await readJsonBody(req);
  const result = await enqueueMutation('my-endpoint', (state) => {
    // mutate state
    return /* result */;
  }, { /* optional detail for event log */ });
  sendJson(res, 200, { ok: true, result });
  return true;
}
```

2. **Add client command** in `lib/orchestrator-client.mjs`:

```js
case 'my-command': {
  const data = await request('GET', baseUrl, '/my-endpoint');
  if (jsonMode) { print(data); return; }
  // Pretty-print
  return;
}
```

3. **Add help text** in the `printHelp()` function.

Note: `enqueueMutation()` accepts an optional third `detail` parameter that is included in the NDJSON event log. The event category is auto-classified from the label (e.g., labels starting with `task:` get category `task`).

## Adding an Operator Command

1. **Add to help text** in `lib/hydra-operator.mjs` `printHelp()`:

```js
console.log(`  ${ACCENT(':mycommand')}           Description`);
```

2. **Add handler** in the `rl.on('line', ...)` callback:

```js
if (line === ':mycommand' || line.startsWith(':mycommand ')) {
  // Handle command
  rl.prompt();
  return;
}
```

3. **Add to concierge system prompt** in `lib/hydra-concierge.mjs` `buildSystemPrompt()` — add the command to the command reference list so the concierge can suggest it for typos/near-misses.

## Adding an MCP Server Tool

To expose a new tool via the Hydra MCP server (`lib/hydra-mcp-server.mjs`):

1. **Add tool definition** to the `TOOLS` array:

```js
{
  name: 'hydra_my_tool',
  description: 'What it does',
  inputSchema: {
    type: 'object',
    properties: {
      param: { type: 'string', description: 'Parameter description' },
    },
    required: ['param'],
  },
}
```

2. **Add handler** in the `tools/call` switch:

```js
case 'hydra_my_tool': {
  const data = await daemonRequest('GET', '/my-endpoint');
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
```

The MCP server delegates to the daemon HTTP API — it should not access state directly.

## Concierge Module

The concierge system spans multiple modules for multi-provider resilience:

- **`lib/hydra-concierge.mjs`** — Main concierge logic: conversation management, system prompt building, event posting, cost estimation, model switching, conversation export.
- **`lib/hydra-concierge-providers.mjs`** — Provider abstraction: `detectAvailableProviders()`, `buildFallbackChain()`, `streamWithFallback()`. Lazy-loads provider modules.
- **`lib/hydra-anthropic.mjs`** — Anthropic Messages API streaming client.
- **`lib/hydra-google.mjs`** — Google Gemini API streaming client.
- **`lib/hydra-openai.mjs`** — OpenAI API streaming client (also used by concierge).

Key points for contributors:

- **System prompt**: Rebuilt on context-hash change or TTL expiry. Contains live state (git branch, recent completions, errors, active workers) and full command reference — keep it in sync when adding/renaming commands.
- **Intent detection**: If the model's response starts with `[DISPATCH]`, the text after it becomes the dispatch prompt. A `concierge:dispatch` event is posted to the daemon with conversation context. Otherwise, the response is streamed directly to the user.
- **Streaming**: Uses `streamWithFallback()` which iterates the fallback chain (OpenAI → Anthropic → Google). Each provider module uses native `fetch()` — no external HTTP dependencies.
- **History**: In-memory array of `{role, content}` messages, capped at `maxHistoryMessages` (default 40). Trimmed by removing oldest user+assistant pairs.
- **Config**: `concierge` section in `hydra.config.json` — model, reasoning effort, history cap, auto-activate toggle, fallback chain, show provider in prompt, welcome message.
- **Fallback chain**: Configurable array of `{provider, model}` entries in `concierge.fallbackChain`. `streamWithFallback()` tries each in order, catches errors per provider, returns first success.
- **Cost estimation**: `COST_PER_1K` lookup table in `hydra-concierge.mjs`. `conciergeTurn()` returns `estimatedCost` in its result object.
- **Bidirectional events**: `postConciergeEvent()` posts to `POST /events/push` (best-effort, 2s timeout). Event types: `concierge:dispatch`, `concierge:summary`, `concierge:error`, `concierge:model_switch`.
- **Ghost text**: Prompt placeholder hints are defined in `hydra-operator.mjs` `interactiveLoop()` as `GHOST_HINTS_CONCIERGE` and `GHOST_HINTS_NORMAL` arrays. Uses `getConciergeModelLabel()` for dynamic model display.

## Code Style

- **ES Modules**: All `.mjs` files use `import`/`export`
- **No build step**: All code runs directly with Node.js
- **Minimal dependencies**: Only `picocolors` for terminal colors
- **Windows-first**: All paths use forward slashes, stdin piping for long prompts
- **ANSI formatting**: Use `hydra-ui.mjs` exports (SUCCESS, ERROR, WARNING, DIM, ACCENT, etc.)
- **Error handling**: Non-critical errors (metrics, usage checks) are silently caught; critical errors throw
- **State mutations**: Always go through `enqueueMutation()` in the daemon; the write queue is fault-tolerant (failed mutations don't poison the queue)
- **JSON output**: All daemon endpoints return `{ ok: true/false, ... }`
- **Event logging**: Events include monotonic `seq` numbers and typed `category` fields

## Testing

Run automated tests:

```powershell
npm test
```

This runs all test files under `test/` using Node.js built-in test runner (`node:test`):

- `test/orchestrator-daemon.integration.test.mjs` — Integration tests for core daemon endpoints (task CRUD, claiming, checkpoints, events, sessions, worktrees)
- `test/daemon-extended.integration.test.mjs` — Extended daemon endpoint tests
- `test/hydra-agents.test.mjs` — Agent registry + sub-agent tests
- `test/hydra-concierge-providers.test.mjs` — Provider detection, fallback chain building, provider labels
- `test/hydra-mcp.test.mjs` — Unit tests for the MCP client (JSON-RPC over stdio with mock server)
- `test/hydra-metrics.test.mjs` — Metrics collection tests
- `test/hydra-streaming-clients.test.mjs` — Anthropic/Google streaming client exports, concierge multi-provider exports and model switching
- `test/hydra-sync-md.test.mjs` — HYDRA.md sync tests
- `test/hydra-ui.test.mjs` — UI formatting + color tests
- `test/hydra-utils.test.mjs` — Utility function tests
- `test/hydra-verification.test.mjs` — Unit tests for the verification command resolver

### Writing Tests

Tests use `node:test` and `node:assert`:

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('My feature', () => {
  it('does the thing', async () => {
    // For daemon integration tests, use the shared server from before() hook
    const res = await fetch(`${BASE}/my-endpoint`);
    const data = await res.json();
    assert.ok(data.ok);
  });
});
```

Integration tests spin up a real daemon on a random port via `startDaemon()` in a `before()` hook and shut it down in `after()`. They share a single daemon instance across all tests in the file.

### Manual Verification

1. Start daemon: `npm start`
2. Run a dispatch: `npm run dispatch -- prompt="test" mode=preview`
3. Check stats: `npm run stats`
4. Check model switching: `npm run model -- claude=sonnet` then `npm run model`
5. Check usage: `npm run usage`
6. Test agent filter: `node lib/hydra-operator.mjs mode=auto prompt="test" agents=claude,gemini`
