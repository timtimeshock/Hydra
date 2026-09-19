#!/usr/bin/env node
/**
 * Hydra MCP Server
 *
 * Exposes Hydra agent orchestration as MCP tools, resources, and prompts
 * using the official @modelcontextprotocol/sdk.
 *
 * Two modes:
 * - **Standalone** (default): Directly invokes agent CLIs via executeAgent() — no daemon required.
 *   The `hydra_ask` tool always works in this mode.
 * - **Daemon**: When the daemon is reachable, also exposes task queue/handoff/council tools.
 *   Daemon tools gracefully return an error message if the daemon is unavailable.
 *
 * Protocol: 2025-03-26 (latest SDK)
 *
 * Usage:
 *   node hydra-mcp-server.mjs [url=http://127.0.0.1:4173]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseArgs, request } from './hydra-utils.mjs';
import { executeAgent, executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
import { forgeAgent, listForgedAgents } from './hydra-agent-forge.mjs';
import { loadHydraConfig } from './hydra-config.mjs';
import { getMetricsSummary } from './hydra-metrics.mjs';
import { listAgents } from './hydra-agents.mjs';
import { getRecentActivity } from './hydra-activity.mjs';
import { buildSelfSnapshot } from './hydra-self.mjs';
import {
  hubPath,
  registerSession as hubRegisterSession,
  updateSession as hubUpdateSession,
  deregisterSession as hubDeregisterSession,
  listSessions as hubListSessions,
  checkConflicts as hubCheckConflicts,
} from './hydra-hub.mjs';

const CHARACTER_LIMIT = 25000;

let daemonAvailable = false;
let baseUrl = 'http://127.0.0.1:4173';

async function checkDaemon() {
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function requireDaemon() {
  if (!daemonAvailable) {
    daemonAvailable = await checkDaemon();
  }
  if (!daemonAvailable) {
    throw new Error('Hydra daemon is not running. Start it with `npm start` to use daemon tools. The `hydra_ask` tool works without the daemon.');
  }
}

function truncate(text, limit = CHARACTER_LIMIT) {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: text.slice(0, limit) + `\n\n[Output truncated at ${limit} chars. Use a more specific prompt or request a summary.]`,
    truncated: true,
  };
}

function errResponse(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

// ── Server Setup ───────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'hydra-orchestrator', version: '3.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// ── Tools ──────────────────────────────────────────────────────────────────

server.registerTool(
  'hydra_ask',
  {
    title: 'Ask Agent',
    description: [
      'Ask another AI agent (Gemini or Codex) a question and get a response. Works without the Hydra daemon.',
      'Use gemini for: analysis, review, critique, research, identifying edge cases.',
      'Use codex for: implementation, refactoring, code generation, writing tests.',
      '',
      'Args:',
      '  - agent: "gemini" (analyst/reviewer) or "codex" (implementer)',
      '  - prompt: The question or task to send',
      '  - system: Optional system instruction prepended to the prompt',
      '  - model: Optional model ID override (defaults to config values)',
      '',
      'Returns: { text, agent, model, durationMs, truncated }',
    ].join('\n'),
    inputSchema: {
      agent: z.enum(['gemini', 'codex']).describe('Which agent to ask: "gemini" (analyst, reviewer) or "codex" (implementer)'),
      prompt: z.string().min(1).describe('The prompt to send to the agent'),
      system: z.string().optional().describe('Optional system instruction to prepend to the prompt'),
      model: z.string().optional().describe('Optional model override (defaults to config values)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ agent, prompt, system, model }) => {
    const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
    const execOpts = {
      modelOverride: model || undefined,
      timeoutMs: 5 * 60 * 1000,
      useStdin: true,
      maxOutputBytes: 256 * 1024,
    };
    const execFn = model ? executeAgent : executeAgentWithRecovery;
    const result = await execFn(agent, fullPrompt, execOpts);

    if (!result.ok && !result.output?.trim()) {
      return errResponse(`Agent ${agent} failed: ${result.error || 'unknown error'}. Try a different agent or check agent availability with hydra_status.`);
    }

    let text = result.output || '';
    if (agent === 'claude') {
      try {
        const parsed = JSON.parse(text);
        text = parsed.result || parsed.content || text;
      } catch { /* use raw output */ }
    }

    const { text: truncated, truncated: wasTruncated } = truncate(text.trim());
    const output = { text: truncated, agent, model: model || 'default', durationMs: result.durationMs, truncated: wasTruncated };

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_tasks_list',
  {
    title: 'List Tasks',
    description: [
      'List tasks in the Hydra daemon with optional filters. Requires daemon.',
      '',
      'Args:',
      '  - status: Filter by status (todo, in_progress, blocked, done)',
      '  - owner: Filter by owner agent name (claude, gemini, codex)',
      '  - limit: Max results 1-100 (default: 50)',
      '  - offset: Pagination offset (default: 0)',
      '',
      'Returns: { tasks, total, count, offset, has_more, next_offset }',
    ].join('\n'),
    inputSchema: {
      status: z.string().optional().describe('Filter by status: todo, in_progress, blocked, done'),
      owner: z.string().optional().describe('Filter by owner agent name'),
      limit: z.number().int().min(1).max(100).default(50).describe('Max results (default: 50)'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ status, owner, limit, offset }) => {
    await requireDaemon();
    const result = await request('GET', baseUrl, '/summary');
    let tasks = result.summary?.openTasks || [];
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (owner) tasks = tasks.filter((t) => t.owner === owner);

    const total = tasks.length;
    const page = tasks.slice(offset, offset + limit).map((t) => ({
      id: t.id, title: t.title, status: t.status, owner: t.owner, type: t.type,
    }));

    const output = {
      tasks: page,
      total,
      count: page.length,
      offset,
      has_more: total > offset + page.length,
      next_offset: total > offset + page.length ? offset + page.length : undefined,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_tasks_claim',
  {
    title: 'Claim Task',
    description: [
      'Atomically claim a task for an agent, optionally creating a new one. Requires daemon.',
      '',
      'Args:',
      '  - agent: Agent claiming the task (claude, gemini, codex)',
      '  - taskId: Existing task ID to claim (omit to create a new task)',
      '  - title: New task title — required if no taskId provided',
      '  - notes: Optional notes for the task',
      '',
      'Returns: { task }',
    ].join('\n'),
    inputSchema: {
      agent: z.string().describe('Agent claiming the task (claude, gemini, codex)'),
      taskId: z.string().optional().describe('Task ID to claim (omit to create new)'),
      title: z.string().optional().describe('New task title (required if no taskId)'),
      notes: z.string().optional().describe('Optional notes'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ agent, taskId, title, notes }) => {
    await requireDaemon();
    if (!taskId && !title) {
      return errResponse('Error: Either taskId or title is required. Provide taskId to claim an existing task (use hydra_tasks_list to find one), or title to create a new task.');
    }
    const body = { agent };
    if (taskId) body.taskId = taskId;
    if (title) body.title = title;
    if (notes) body.notes = notes;
    const result = await request('POST', baseUrl, '/task/claim', body);
    const output = { task: result.task };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_tasks_update',
  {
    title: 'Update Task',
    description: [
      "Update a task's status or notes. Requires daemon.",
      '',
      'Args:',
      '  - taskId: Task ID to update',
      '  - status: New status (todo, in_progress, blocked, done)',
      '  - notes: Updated notes',
      '  - claimToken: Claim token for atomic updates (from hydra_tasks_claim)',
      '',
      'Returns: { task }',
    ].join('\n'),
    inputSchema: {
      taskId: z.string().describe('Task ID to update'),
      status: z.string().optional().describe('New status: todo, in_progress, blocked, done'),
      notes: z.string().optional().describe('Updated notes'),
      claimToken: z.string().optional().describe('Claim token for atomic update (from hydra_tasks_claim)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ taskId, status, notes, claimToken }) => {
    await requireDaemon();
    const body = { taskId };
    if (status) body.status = status;
    if (notes) body.notes = notes;
    if (claimToken) body.claimToken = claimToken;
    const result = await request('POST', baseUrl, '/task/update', body);
    const output = { task: result.task };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_tasks_checkpoint',
  {
    title: 'Save Task Checkpoint',
    description: [
      'Save a named checkpoint for a task to preserve progress context. Requires daemon.',
      '',
      'Args:',
      '  - taskId: Task ID to checkpoint',
      '  - name: Checkpoint name (e.g. "proposal_complete", "tests_passing")',
      '  - context: Summary of progress so far',
      '  - agent: Agent saving the checkpoint',
      '',
      'Returns: { checkpoint }',
    ].join('\n'),
    inputSchema: {
      taskId: z.string().describe('Task ID to checkpoint'),
      name: z.string().describe('Checkpoint name (e.g. proposal_complete, tests_passing)'),
      context: z.string().optional().describe('Summary of progress so far'),
      agent: z.string().optional().describe('Agent saving the checkpoint'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ taskId, name, context, agent }) => {
    await requireDaemon();
    const result = await request('POST', baseUrl, '/task/checkpoint', { taskId, name, context: context || '', agent: agent || '' });
    const output = { checkpoint: result.checkpoint };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_handoffs_pending',
  {
    title: 'Get Pending Handoffs',
    description: [
      'Get unacknowledged handoffs waiting for a specific agent. Requires daemon.',
      '',
      'Args:',
      '  - agent: Agent name to check handoffs for (claude, gemini, codex)',
      '',
      'Returns: { handoffs, count }',
    ].join('\n'),
    inputSchema: {
      agent: z.string().describe('Agent to check handoffs for (claude, gemini, codex)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ agent }) => {
    await requireDaemon();
    const state = await request('GET', baseUrl, '/state');
    const handoffs = (state.state?.handoffs || []).filter((h) => h.to === agent && !h.acknowledgedAt);
    const output = { handoffs, count: handoffs.length };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_handoffs_ack',
  {
    title: 'Acknowledge Handoff',
    description: [
      'Acknowledge a handoff, marking it as received by the agent. Requires daemon.',
      '',
      'Args:',
      '  - handoffId: Handoff ID to acknowledge (from hydra_handoffs_pending)',
      '  - agent: Agent acknowledging the handoff',
      '',
      'Returns: { handoff }',
    ].join('\n'),
    inputSchema: {
      handoffId: z.string().describe('Handoff ID to acknowledge (from hydra_handoffs_pending)'),
      agent: z.string().describe('Agent acknowledging the handoff'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ handoffId, agent }) => {
    await requireDaemon();
    const result = await request('POST', baseUrl, '/handoff/ack', { handoffId, agent });
    const output = { handoff: result.handoff };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_council_request',
  {
    title: 'Request Council Deliberation',
    description: [
      'Queue a prompt for multi-agent council deliberation across Claude, Gemini, and Codex. Requires daemon.',
      'After queueing, open the Hydra operator console and run `:council` to begin deliberation.',
      '',
      'Args:',
      '  - prompt: The question or objective for council to deliberate on',
      '',
      'Returns: { queued, decision, message }',
    ].join('\n'),
    inputSchema: {
      prompt: z.string().min(1).describe('The prompt or objective for council deliberation'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ prompt }) => {
    await requireDaemon();
    const result = await request('POST', baseUrl, '/decision', {
      title: `Council requested: ${prompt.slice(0, 80)}`,
      owner: 'human',
      rationale: `Agent requested council deliberation for: ${prompt}`,
      impact: 'pending council review',
    });
    const output = {
      queued: true,
      decision: result.decision,
      message: 'Council request recorded. Open the Hydra operator console (`npm run go`) and run `:council` to begin deliberation.',
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_status',
  {
    title: 'Get Daemon Status',
    description: [
      'Get Hydra daemon health and summary statistics. Requires daemon.',
      '',
      'Returns: daemon health object with task counts, worker status, and uptime.',
    ].join('\n'),
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    await requireDaemon();
    const health = await request('GET', baseUrl, '/health');
    return {
      content: [{ type: 'text', text: JSON.stringify(health) }],
      structuredContent: health,
    };
  },
);

server.registerTool(
  'hydra_forge',
  {
    title: 'Forge Virtual Agent',
    description: [
      'Create a specialized virtual agent using a multi-model collaboration pipeline.',
      'Pipeline: ANALYZE (Gemini) → DESIGN (Claude) → CRITIQUE (Gemini) → REFINE (Claude).',
      'Works without the daemon.',
      '',
      'Args:',
      '  - description: What the agent should specialize in (e.g. "API testing specialist")',
      '  - name: Optional lowercase-hyphenated name (auto-generated if omitted)',
      '  - baseAgent: Optional base agent override (claude, gemini, codex)',
      '  - skipTest: Skip the test phase (default: true for MCP)',
      '',
      'Returns: { agent, phases, warnings }',
    ].join('\n'),
    inputSchema: {
      description: z.string().min(1).describe('What the agent should specialize in (e.g. "API testing specialist")'),
      name: z.string().optional().describe('Optional lowercase-hyphenated name override'),
      baseAgent: z.enum(['claude', 'gemini', 'codex']).optional().describe('Optional base agent override'),
      skipTest: z.boolean().optional().describe('Skip the test phase (default: true for MCP)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ description, name, baseAgent, skipTest }) => {
    const result = await forgeAgent(description, {
      name: name || undefined,
      baseAgent: baseAgent || undefined,
      skipTest: skipTest !== false,
    });
    if (!result.ok) {
      return errResponse(`Forge failed: ${result.errors?.join(', ') || 'unknown error'}. Check that Gemini and Claude agents are available and configured.`);
    }
    const output = {
      agent: {
        name: result.spec.name,
        displayName: result.spec.displayName,
        baseAgent: result.spec.baseAgent,
        strengths: result.spec.strengths,
        tags: result.spec.tags,
      },
      phases: result.phases,
      warnings: result.validation?.warnings || [],
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  'hydra_forge_list',
  {
    title: 'List Forged Agents',
    description: [
      'List all forged (custom-created) virtual agents with their specializations and metadata.',
      'Works without the daemon.',
      '',
      'Returns: { agents, count }',
    ].join('\n'),
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const forged = listForgedAgents();
    const output = { agents: forged, count: forged.length };
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

// ── Hub Tools (no daemon required) ─────────────────────────────────────────

server.registerTool(
  'hydra_hub_list',
  {
    title: 'Hub List',
    description: [
      'List active agent sessions in the coordination hub. Works without the Hydra daemon.',
      'Use this to see which Claude Code CLIs, forge agents, and daemon tasks are active on this project.',
      '',
      'Args:',
      '  - cwd: Optional working directory filter. Omit to list all projects.',
      '',
      'Returns: { sessions, count, hubPath }',
    ].join('\n'),
    inputSchema: {
      cwd: z.string().optional().describe('Filter to sessions in this working directory'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ cwd }) => {
    const sessions = hubListSessions({ cwd });
    const output = { sessions, count: sessions.length, hubPath: hubPath() };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  },
);

server.registerTool(
  'hydra_hub_register',
  {
    title: 'Hub Register',
    description: [
      'Register a Claude Code session in the coordination hub. Works without the Hydra daemon.',
      'Call this at session start instead of writing sess_*.json directly.',
      '',
      'Args:',
      '  - agent: Agent type — use "claude-code" for Claude Code CLI',
      '  - cwd: Working directory (will be normalized)',
      '  - project: Human-readable project name',
      '  - focus: Brief description of current work',
      '  - files: Files you plan to claim (optional)',
      '  - taskId: Hydra task ID if you have one from hydra_tasks_claim',
      '',
      'Returns: { id, hubPath }',
    ].join('\n'),
    inputSchema: {
      agent: z.string().describe('Agent type (claude-code, gemini-forge, etc.)'),
      cwd: z.string().describe('Working directory'),
      project: z.string().describe('Human-readable project name'),
      focus: z.string().describe('Brief description of current work'),
      files: z.array(z.string()).optional().describe('Files claimed by this session'),
      taskId: z.string().optional().describe('Hydra task ID if linked'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ agent, cwd, project, focus, files, taskId }) => {
    const id = hubRegisterSession({ agent, cwd, project, focus, files, taskId });
    const output = { id, hubPath: hubPath() };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  },
);

server.registerTool(
  'hydra_hub_update',
  {
    title: 'Hub Update',
    description: [
      'Update an active hub session — files, status, or focus. Works without the Hydra daemon.',
      'Call this when your file list changes or your work focus shifts.',
      '',
      'Args:',
      '  - id: Session ID from hydra_hub_register',
      '  - files: Updated file list (replaces previous)',
      '  - status: New status (working, idle, blocked, waiting)',
      '  - focus: Updated focus description',
      '',
      'Returns: { ok }',
    ].join('\n'),
    inputSchema: {
      id: z.string().describe('Session ID from hydra_hub_register'),
      files: z.array(z.string()).optional().describe('Updated file list'),
      status: z.string().optional().describe('New status: working, idle, blocked, waiting'),
      focus: z.string().optional().describe('Updated focus description'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, files, status, focus }) => {
    const updates = {};
    if (files !== undefined) updates.files = files;
    if (status !== undefined) updates.status = status;
    if (focus !== undefined) updates.focus = focus;
    hubUpdateSession(id, updates);
    const output = { ok: true };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  },
);

server.registerTool(
  'hydra_hub_deregister',
  {
    title: 'Hub Deregister',
    description: [
      'Remove a session from the coordination hub. Works without the Hydra daemon.',
      'Call this at session end when work is complete.',
      '',
      'Args:',
      '  - id: Session ID from hydra_hub_register',
      '',
      'Returns: { ok }',
    ].join('\n'),
    inputSchema: {
      id: z.string().describe('Session ID from hydra_hub_register'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => {
    hubDeregisterSession(id);
    const output = { ok: true };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  },
);

server.registerTool(
  'hydra_hub_conflicts',
  {
    title: 'Hub Check Conflicts',
    description: [
      'Check if any planned files are already claimed by another active session in the same project.',
      'Works without the Hydra daemon. Call before starting to edit files.',
      '',
      'Args:',
      '  - files: Files you plan to edit',
      '  - cwd: Working directory (for project filtering)',
      '  - excludeId: Your own session ID to exclude yourself from results',
      '',
      'Returns: { conflicts: Array<{ file, claimedBy }> }',
    ].join('\n'),
    inputSchema: {
      files: z.array(z.string()).describe('Files you plan to edit'),
      cwd: z.string().describe('Working directory'),
      excludeId: z.string().optional().describe('Your session ID to exclude from results'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ files, cwd, excludeId }) => {
    const conflicts = hubCheckConflicts(files, { cwd, excludeId });
    const output = { conflicts };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  },
);

// ── Resources ──────────────────────────────────────────────────────────────

server.registerResource(
  'config',
  'hydra://config',
  { description: 'Current Hydra configuration (hydra.config.json)', mimeType: 'application/json' },
  async () => ({
    contents: [{
      uri: 'hydra://config',
      mimeType: 'application/json',
      text: JSON.stringify(loadHydraConfig(), null, 2),
    }],
  }),
);

server.registerResource(
  'metrics',
  'hydra://metrics',
  { description: 'Session metrics and SLO status', mimeType: 'application/json' },
  async () => ({
    contents: [{
      uri: 'hydra://metrics',
      mimeType: 'application/json',
      text: JSON.stringify(getMetricsSummary(), null, 2),
    }],
  }),
);

server.registerResource(
  'agents',
  'hydra://agents',
  { description: 'Agent registry with models and affinities', mimeType: 'application/json' },
  async () => ({
    contents: [{
      uri: 'hydra://agents',
      mimeType: 'application/json',
      text: JSON.stringify(listAgents(), null, 2),
    }],
  }),
);

server.registerResource(
  'activity',
  'hydra://activity',
  { description: 'Recent activity digest (last 20 events)', mimeType: 'application/json' },
  async () => ({
    contents: [{
      uri: 'hydra://activity',
      mimeType: 'application/json',
      text: JSON.stringify(getRecentActivity(20), null, 2),
    }],
  }),
);

server.registerResource(
  'status',
  'hydra://status',
  { description: 'Daemon status (if available)', mimeType: 'application/json' },
  async () => {
    try {
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      const data = health.ok ? await health.json() : { available: false };
      return { contents: [{ uri: 'hydra://status', mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    } catch {
      return { contents: [{ uri: 'hydra://status', mimeType: 'application/json', text: JSON.stringify({ available: false }) }] };
    }
  },
);

server.registerResource(
  'self',
  'hydra://self',
  { description: 'Hydra self snapshot (version, git, models, config, metrics)', mimeType: 'application/json' },
  async () => ({
    contents: [{
      uri: 'hydra://self',
      mimeType: 'application/json',
      text: JSON.stringify(buildSelfSnapshot({ includeAgents: false, includeConfig: true, includeMetrics: true }), null, 2),
    }],
  }),
);

// ── Prompts ────────────────────────────────────────────────────────────────

server.registerPrompt(
  'hydra_council',
  {
    description: 'Council deliberation template with role assignments for multi-agent structured reasoning',
    argsSchema: { objective: z.string().describe('The objective for council deliberation') },
  },
  ({ objective }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            '# Council Deliberation',
            '',
            '## Objective',
            objective,
            '',
            '## Process',
            '1. **Architect** (Claude): Propose a comprehensive approach with trade-offs',
            '2. **Analyst** (Gemini): Critique the proposal — identify risks, gaps, edge cases',
            '3. **Architect** (Claude): Refine based on critique, produce final specification',
            '4. **Implementer** (Codex): Execute the specification with precision',
            '',
            '## Guidelines',
            '- Consider security implications',
            '- Evaluate performance trade-offs',
            '- Check for backward compatibility',
            '- Ensure testability',
          ].join('\n'),
        },
      },
    ],
  }),
);

server.registerPrompt(
  'hydra_review',
  {
    description: 'Code review prompt optimized for multi-agent review across security, performance, and correctness',
    argsSchema: {
      code: z.string().describe('The code or diff to review'),
      focus: z.string().optional().describe('Specific areas to focus on (security, performance, etc.)'),
    },
  },
  ({ code, focus }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            '# Multi-Agent Code Review',
            '',
            ...(focus ? [`## Focus Areas`, focus, ''] : []),
            '## Code',
            '```',
            code,
            '```',
            '',
            '## Review Checklist',
            '- [ ] Security: injection, XSS, OWASP top 10',
            '- [ ] Error handling: edge cases, graceful degradation',
            '- [ ] Performance: hot paths, memory allocation',
            '- [ ] Correctness: logic bugs, off-by-one, race conditions',
            '- [ ] Maintainability: naming, structure, complexity',
          ].join('\n'),
        },
      },
    ],
  }),
);

server.registerPrompt(
  'hydra_analyze',
  {
    description: 'Architecture analysis prompt using a structured 6-step framework',
    argsSchema: { topic: z.string().describe('Architecture topic or question to analyze') },
  },
  ({ topic }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            '# Architecture Analysis',
            '',
            '## Topic',
            topic,
            '',
            '## Analysis Framework',
            '1. **Current State**: What exists today?',
            '2. **Problem**: What\'s the gap or issue?',
            '3. **Options**: What are the possible approaches? (minimum 3)',
            '4. **Trade-offs**: Compare each option on: complexity, performance, maintainability, risk',
            '5. **Recommendation**: Which option and why?',
            '6. **Migration Plan**: How to get there incrementally?',
          ].join('\n'),
        },
      },
    ],
  }),
);

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  baseUrl = options.url || process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';

  // Check daemon availability on startup (non-blocking for standalone tools)
  daemonAvailable = await checkDaemon();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Hydra MCP server failed: ${err.message}\n`);
  process.exit(1);
});
