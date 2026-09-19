/**
 * Hydra Concierge — Multi-provider conversational front-end.
 *
 * Handles user-facing chat, answers questions directly, and only escalates
 * to the full agent dispatch pipeline when actual work needs doing.
 * Supports OpenAI, Anthropic, and Google via a fallback chain.
 */

import path from 'path';
import { loadHydraConfig } from './hydra-config.mjs';
import { getMode, getModelSummary } from './hydra-agents.mjs';
import {
  detectAvailableProviders,
  buildFallbackChain,
  streamWithFallback,
  providerLabel,
} from './hydra-concierge-providers.mjs';
import { shortModelName } from './hydra-ui.mjs';
import { COST_PER_1K, estimateCost } from './hydra-provider-usage.mjs';
import { getConciergeIdentity } from './hydra-persona.mjs';
import { getSessionContext } from './hydra-activity.mjs';

// Re-export for backward compat (concierge was the original home)
export { COST_PER_1K };

// ── State ────────────────────────────────────────────────────────────────────

let history = [];          // {role, content}[]
let stats = { turns: 0, promptTokens: 0, completionTokens: 0 };
let systemPromptCache = { text: '', builtAt: 0, fingerprint: '' };
let activeProvider = null; // {provider, model, isFallback}
const SYSTEM_PROMPT_TTL_MS = 30_000;

// ── Config ───────────────────────────────────────────────────────────────────

export function getConciergeConfig() {
  const cfg = loadHydraConfig();
  return cfg.concierge || {
    enabled: true,
    model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh',
    maxHistoryMessages: 40,
    autoActivate: false,
    showProviderInPrompt: true,
    welcomeMessage: true,
    fallbackChain: [
      { provider: 'openai', model: 'gpt-5.6-terra' },
      { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      { provider: 'google', model: 'gemini-3-flash-preview' },
    ],
  };
}

// ── Availability ─────────────────────────────────────────────────────────────

export function isConciergeAvailable() {
  const cfg = getConciergeConfig();
  if (!cfg.enabled) return false;
  return detectAvailableProviders().length > 0;
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initConcierge(opts = {}) {
  const chain = buildFallbackChain().filter((e) => e.available);
  if (chain.length === 0) {
    throw new Error(
      'No API keys configured — concierge requires at least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY'
    );
  }
  history = [];
  stats = { turns: 0, promptTokens: 0, completionTokens: 0 };
  systemPromptCache = { text: '', builtAt: 0, fingerprint: '' };
  activeProvider = null;
}

// ── Conversation Management ──────────────────────────────────────────────────

export function resetConversation() {
  history = [];
  stats.turns = 0;
  systemPromptCache = { text: '', builtAt: 0, fingerprint: '' };
}

export function getConciergeStats() {
  return { ...stats };
}

/**
 * Get info about the currently active provider.
 * @returns {{provider: string, model: string, isFallback: boolean}|null}
 */
export function getActiveProvider() {
  return activeProvider ? { ...activeProvider } : null;
}

/**
 * Get a short display label for the active concierge model.
 * @returns {string}
 */
export function getConciergeModelLabel() {
  if (activeProvider) {
    const short = shortModelName(activeProvider.model);
    return activeProvider.isFallback ? `${short} \u2193` : short;
  }
  // Fallback to config primary
  const cfg = getConciergeConfig();
  return shortModelName(cfg.model);
}

/**
 * Switch the concierge to a different model at runtime.
 * Inserts the specified model at the front of the fallback chain.
 * @param {string} modelSpec - Model name or alias (e.g. "sonnet", "gpt-5", "flash")
 */
export function switchConciergeModel(modelSpec) {
  // Resolve common aliases
  const ALIASES = {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-5-20250929',
    haiku: 'claude-haiku-4-5-20251001',
    terra: 'gpt-5.6-terra',
    flash: 'gemini-3-flash-preview',
    pro: 'gemini-3-pro-preview',
  };

  const resolved = ALIASES[modelSpec.toLowerCase()] || modelSpec;

  // Detect provider from model name
  let provider = 'openai';
  if (resolved.startsWith('claude-')) provider = 'anthropic';
  else if (resolved.startsWith('gemini-')) provider = 'google';

  activeProvider = { provider, model: resolved, isFallback: false };
}

/**
 * Export the conversation history for archiving.
 * @returns {object}
 */
export function exportConversation() {
  return {
    exportedAt: new Date().toISOString(),
    provider: activeProvider ? `${activeProvider.provider}:${activeProvider.model}` : 'unknown',
    turns: stats.turns,
    stats: { ...stats },
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  };
}

/**
 * Get the last N user messages for dispatch context.
 * @param {number} n
 * @returns {string[]}
 */
export function getRecentContext(n = 3) {
  return history
    .filter((m) => m.role === 'user')
    .slice(-n)
    .map((m) => m.content.slice(0, 200));
}

function trimHistory(maxMessages) {
  if (history.length <= maxMessages) return;
  // Summarize trimmed messages before discarding
  const cfg = loadHydraConfig();
  const summarizeOnTrim = cfg.concierge?.summarizeOnTrim !== false;
  if (summarizeOnTrim && history.length > maxMessages + 4) {
    const trimCount = history.length - maxMessages;
    const trimmed = history.slice(0, trimCount);
    const bullets = trimmed
      .filter(m => m.role === 'user')
      .slice(0, 5)
      .map(m => `- ${m.content.slice(0, 80)}`);
    if (bullets.length > 0) {
      const summaryContent = `Prior conversation topics:\n${bullets.join('\n')}`;
      // Remove old summary if present
      if (history[0]?.role === 'system' && history[0]?.content?.startsWith('Prior conversation')) {
        history.splice(0, 1);
      }
      history.splice(0, trimCount, { role: 'system', content: summaryContent });
      return;
    }
  }
  while (history.length > maxMessages) {
    history.splice(0, 2);
  }
}

// ── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(context = {}) {
  const now = Date.now();

  // Context-hash fingerprint for cache invalidation
  const fingerprint = JSON.stringify([
    context.mode || '',
    context.openTasks ?? 0,
    context.gitInfo?.branch || '',
    (context.recentCompletions || []).length,
    context.selfAwarenessKey || '',
  ]);

  if (
    systemPromptCache.text &&
    systemPromptCache.fingerprint === fingerprint &&
    (now - systemPromptCache.builtAt) < SYSTEM_PROMPT_TTL_MS
  ) {
    return systemPromptCache.text;
  }

  const project = context.projectName || 'unknown';
  const projectRoot = context.projectRoot || '';
  const mode = context.mode || 'auto';
  const openTasks = context.openTasks ?? 0;
  const agentModels = context.agentModels || {};
  const knownProjects = context.knownProjects || [];

  const modelLines = Object.entries(agentModels)
    .map(([agent, model]) => `  - ${agent}: ${model}`)
    .join('\n');

  const otherProjects = knownProjects
    .filter((p) => p !== projectRoot)
    .map((p) => `  - ${path.basename(p)} (${p})`)
    .join('\n');

  // Build enriched awareness sections
  let awarenessBlock = '';

  // Git info
  if (context.gitInfo) {
    const gi = context.gitInfo;
    awarenessBlock += `\n- Git branch: ${gi.branch || 'unknown'}`;
    if (gi.modifiedFiles != null) {
      awarenessBlock += ` (${gi.modifiedFiles} modified file${gi.modifiedFiles !== 1 ? 's' : ''})`;
    }
  }

  // Recent completions
  if (context.recentCompletions && context.recentCompletions.length > 0) {
    awarenessBlock += '\n- Recently completed tasks:';
    for (const c of context.recentCompletions.slice(0, 3)) {
      awarenessBlock += `\n  - [${c.agent}] ${c.title || c.taskId || 'untitled'}`;
    }
  }

  // Recent errors
  if (context.recentErrors && context.recentErrors.length > 0) {
    awarenessBlock += '\n- Recent errors:';
    for (const e of context.recentErrors.slice(0, 3)) {
      awarenessBlock += `\n  - [${e.agent || 'system'}] ${(e.error || e.message || 'unknown').slice(0, 80)}`;
    }
  }

  // Active workers
  if (context.activeWorkers && context.activeWorkers.length > 0) {
    awarenessBlock += `\n- Active workers: ${context.activeWorkers.join(', ')}`;
  }

  // Prior session context (cross-session continuity)
  try {
    const sessionCtx = getSessionContext();
    if (sessionCtx.priorSessions.length > 0) {
      awarenessBlock += '\n- Prior sessions:';
      for (const s of sessionCtx.priorSessions) {
        const when = new Date(s.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        awarenessBlock += `\n  - ${when}: ${s.summary.slice(0, 120)}`;
      }
    }
  } catch { /* skip on error */ }

  // Permanent codebase baseline (always injected when available)
  if (context.codebaseBaseline) {
    awarenessBlock += '\n\n' + context.codebaseBaseline;
  }

  // Always-on self-awareness blocks (operator-provided)
  if (context.selfSnapshotBlock) {
    awarenessBlock += '\n\n' + context.selfSnapshotBlock;
  }
  if (context.selfIndexBlock) {
    awarenessBlock += '\n\n' + context.selfIndexBlock;
  }

  // On-demand activity digest (for "what's going on?" queries)
  if (context.activityDigest) {
    awarenessBlock += '\n\n' + context.activityDigest;
  }

  // On-demand topic context (for "how does X work?" queries)
  if (context.codebaseContext) {
    awarenessBlock += '\n\n' + context.codebaseContext;
  }

  // Persona-aware identity block (falls back to hardcoded text when persona disabled)
  const openingParagraph = getConciergeIdentity() || 'You are the Hydra Concierge \u2014 the conversational front-end for the Hydra multi-agent orchestration system.';

  const text = `${openingParagraph}

Current state:
- Project: ${project} (${projectRoot})
- Operator mode: ${mode}
- Open tasks: ${openTasks}
- Agent models:
${modelLines || '  (none loaded)'}${awarenessBlock}
${otherProjects ? `\nOther known projects:\n${otherProjects}` : ''}

Your role:
1. Answer questions about Hydra, the project, general programming, and anything the user asks conversationally.
2. Help the user think through problems, refine their objectives, and plan their work.
3. When asked about the codebase architecture, modules, or patterns, provide specific, detailed answers referencing modules, functions, and config keys by name.
3. When the user gives you an instruction that requires actual code changes, file modifications, debugging, investigation, or any hands-on work that Hydra agents should execute — you MUST escalate by prefixing your entire response with [DISPATCH] followed by a clean, actionable prompt for the dispatch pipeline.

Project awareness:
- You know which project is currently active and what other projects the user works on.
- If the user's prompt clearly relates to a DIFFERENT project (e.g. mentions concepts, files, or terminology that belong to another known project, not the current one), point this out and suggest they switch first: "That sounds like it belongs to **<project name>** — you'll want to restart the operator from that directory (cd <path> && npm run go) or launch a separate session for it."
- Do NOT blindly dispatch work that targets the wrong project. A heads-up saves the user from wasted agent runs.
- If you're unsure whether the prompt matches the current project, ask for clarification.

Intent rules:
- Questions, discussion, brainstorming, explanations → respond directly (NO [DISPATCH] prefix)
- Requests for code changes, bug fixes, feature implementation, file creation, refactoring, running commands, investigation that requires reading files → respond with [DISPATCH] followed by a refined prompt
- If ambiguous, ask the user to clarify rather than guessing

Disambiguation — when input is ambiguous, ALWAYS ask a brief clarifying question:
- Short ambiguous phrases ("fix it", "try again", "do it") → ask what specifically to fix/retry/do
- Input that could be a command shortcut ("status", "clear") → suggest the :command form
- When unsure if a request needs code changes or discussion → ask: "Should I dispatch this to an agent, or discuss it here?"
- NEVER interpret single-digit inputs (1-9) as messages — these are UI selection inputs

Command awareness — the operator supports these colon-prefixed commands:
  :help                 Show help
  :status               Dashboard with agents & tasks
  :self                 Hydra self snapshot (models, config, runtime)
  :aware                Hyper-awareness toggle (self snapshot/index injection)
  :mode auto            Mini-round triage then delegate/escalate
  :mode smart           Auto-select model tier per prompt complexity
  :mode handoff         Direct handoffs (fast, no triage)
  :mode council         Full council deliberation
  :mode dispatch        Headless pipeline (Claude→Gemini→Codex)
  :model                Show mode & active models
  :model mode=economy   Switch global mode (performance/balanced/economy/custom)
  :model claude=sonnet  Override agent model
  :model reset          Clear all overrides
  :usage                Token usage & contingencies
  :stats                Agent metrics & performance
  :resume               Ack handoffs, reset stale tasks, launch agents
  :pause [reason]       Pause the active session
  :unpause              Resume a paused session
  :fork                 Fork current session (explore alternatives)
  :spawn <focus>        Spawn child session (fresh context)
  :tasks                List active tasks
  :handoffs             List pending & recent handoffs
  :cancel <id>          Cancel a task (e.g. :cancel T003)
  :clear                Interactive menu to select clear target
  :clear all            Cancel all tasks & ack all handoffs
  :clear tasks          Cancel all open tasks
  :clear handoffs       Ack all pending handoffs
  :clear concierge      Clear conversation history
  :clear metrics        Reset session metrics
  :clear screen         Clear terminal
  :archive              Archive completed work & trim events
  :events               Show recent event log
  :workers              Show worker status
  :workers start [agent]  Start worker(s)
  :workers stop [agent]   Stop worker(s)
  :workers restart        Restart all workers
  :workers mode <mode>    Change permission mode (auto-edit/full-auto)
  :watch <agent>        Open visible terminal for agent observation
  :chat                 Toggle concierge on/off
  :chat off             Disable concierge
  :chat reset           Clear conversation history
  :chat stats           Show token usage
  :chat model           Show active model & fallback chain
  :chat model <name>    Switch concierge model (e.g. sonnet, flash)
  :chat export          Export conversation to file
  :evolve               Launch evolve session (research→plan→test→implement)
  :evolve focus=<area>  Focus on specific area (e.g. testing-reliability)
  :evolve max-rounds=N  Limit rounds (default: 3)
  :evolve status        Show latest evolve session report
  :evolve knowledge     Browse accumulated knowledge base
  :actualize            Experimental self-actualization runner (branches only)
  :actualize dry-run    Scan + discover + prioritize without executing
  :actualize review     Interactive branch review & merge
  :actualize status     Show latest actualize report
  :actualize clean      Delete all actualize/* branches
  :confirm              Show/toggle dispatch confirmations
  :confirm on/off       Enable/disable confirmations
  :shutdown             Stop the daemon
  :quit / :exit         Exit operator console
  !<prompt>             Force dispatch (bypass concierge)

If the user's input looks like a mistyped or approximate command (e.g. "stats", "satus", ":staus", "show status", "clear tasks", "halp", "mode economy", "switch to council"), you MUST:
- Identify the most likely intended command
- Respond briefly: suggest the exact command they should type, formatted as \`:command\`
- Do NOT execute the command yourself — just tell them what to type
- Be concise: one or two sentences max

Important constraints:
- You cannot read files, make changes, or execute commands yourself
- You can only converse and decide when to escalate to the agent pipeline
- Keep responses concise and focused
- When escalating with [DISPATCH], write a clear, actionable prompt that includes all necessary context from the conversation`;

  systemPromptCache = { text, builtAt: now, fingerprint };
  return text;
}

// ── Event Posting (bidirectional) ────────────────────────────────────────────

let _daemonBaseUrl = null;

/**
 * Set the daemon base URL for event posting.
 * @param {string} baseUrl
 */
export function setConciergeBaseUrl(baseUrl) {
  _daemonBaseUrl = baseUrl;
}

async function postConciergeEvent(type, payload) {
  if (!_daemonBaseUrl) return;
  try {
    await fetch(`${_daemonBaseUrl}/events/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    // Best-effort, but log error for debugging
    console.error(`[Concierge] Event post failed: ${err.message}`);
  }
}

// ── Main Turn ────────────────────────────────────────────────────────────────

/**
 * Process one conversational turn.
 * @param {string} userMsg - The user's message
 * @param {object} opts
 * @param {Function} [opts.onChunk] - Called with each streamed text chunk
 * @param {Function} [opts.onFirstChunk] - Called once when first chunk arrives (for spinner stop)
 * @param {object} [opts.context] - Live state for system prompt
 * @returns {Promise<{intent: 'chat'|'dispatch', response: string, dispatchPrompt?: string, provider?: string, model?: string, isFallback?: boolean, estimatedCost?: number}>}
 */
export async function conciergeTurn(userMsg, opts = {}) {
  const cfg = getConciergeConfig();
  const systemPrompt = buildSystemPrompt(opts.context || {});

  // Add user message to history
  history.push({ role: 'user', content: userMsg });
  trimHistory(cfg.maxHistoryMessages || 40);

  // Build messages array
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  // Track whether we've detected [DISPATCH] prefix
  let isDispatch = false;
  let dispatchDetected = false;
  let responseBuffer = '';
  let chunkCount = 0;
  let firstChunkFired = false;

  const onChunk = (chunk) => {
    responseBuffer += chunk;
    chunkCount++;

    // Notify on first chunk (for spinner)
    if (!firstChunkFired && opts.onFirstChunk) {
      firstChunkFired = true;
      opts.onFirstChunk();
    }

    // Check for [DISPATCH] prefix in first few chunks
    if (!dispatchDetected && chunkCount <= 5) {
      const trimmed = responseBuffer.trimStart();
      if (trimmed.startsWith('[DISPATCH]')) {
        isDispatch = true;
        dispatchDetected = true;
        return;
      } else if (trimmed.length > 12) {
        dispatchDetected = true;
      }
    }

    // Stream to user only if it's a chat response
    if (dispatchDetected && !isDispatch && opts.onChunk) {
      opts.onChunk(chunk);
    }
  };

  // If we have an explicitly set provider, use streamWithFallback which
  // respects the chain. If activeProvider was set via switchConciergeModel,
  // it will be the first entry tried.
  const streamCfg = { ...cfg };
  if (activeProvider) {
    streamCfg.model = activeProvider.model;
  }

  const result = await streamWithFallback(messages, streamCfg, onChunk);

  // Update active provider info
  activeProvider = {
    provider: result.provider,
    model: result.model,
    isFallback: result.isFallback,
  };

  // If we buffered early chunks waiting for dispatch detection, flush them now
  if (!isDispatch && !dispatchDetected && opts.onChunk) {
    opts.onChunk(responseBuffer);
  }

  // Fire onFirstChunk if nothing came through (empty response edge case)
  if (!firstChunkFired && opts.onFirstChunk) {
    opts.onFirstChunk();
  }

  // Update stats
  stats.turns++;
  if (result.usage) {
    stats.promptTokens += result.usage.prompt_tokens || 0;
    stats.completionTokens += result.usage.completion_tokens || 0;
  }

  // Estimate cost
  const cost = estimateCost(result.model, result.usage);

  // Add assistant response to history
  history.push({ role: 'assistant', content: result.fullResponse });

  // Post summary event every 5 turns
  if (stats.turns % 5 === 0) {
    const lastTopic = history
      .filter((m) => m.role === 'user')
      .slice(-1)[0]?.content.slice(0, 80) || '';
    postConciergeEvent('concierge:summary', {
      turns: stats.turns,
      lastTopic,
      tokensUsed: stats.promptTokens + stats.completionTokens,
    });
  }

  // Determine intent
  const trimmedResponse = result.fullResponse.trimStart();
  if (trimmedResponse.startsWith('[DISPATCH]')) {
    const dispatchPrompt = trimmedResponse.slice('[DISPATCH]'.length).trim();

    // Post dispatch event
    postConciergeEvent('concierge:dispatch', {
      dispatchPrompt: dispatchPrompt.slice(0, 200),
      conversationContext: getRecentContext(3),
      provider: result.provider,
      model: result.model,
    });

    return {
      intent: 'dispatch',
      response: result.fullResponse,
      dispatchPrompt,
      provider: result.provider,
      model: result.model,
      isFallback: result.isFallback,
      estimatedCost: cost,
    };
  }

  return {
    intent: 'chat',
    response: result.fullResponse,
    provider: result.provider,
    model: result.model,
    isFallback: result.isFallback,
    estimatedCost: cost,
  };
}

// ── Suggestion Generation (stateless, no history mutation) ──────────────────

const SUGGEST_SYSTEM_PROMPT = `You suggest a single actionable prompt the user could type at a CLI operator console that dispatches work to AI coding agents. Given context about blocked tasks, suggest ONE prompt (under 120 chars) to investigate or unblock the situation. Output ONLY the suggested prompt text — no quotes, no explanation, no prefix.`;

/**
 * Generate a contextual suggestion without mutating conversation history.
 * Designed for ghost-text hints — lightweight, stateless, capped output.
 *
 * @param {string} contextDescription - Brief description of current state
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=80] - Max output tokens
 * @returns {Promise<{suggestion: string, provider: string, model: string}|null>}
 */
export async function conciergeSuggest(contextDescription, opts = {}) {
  const cfg = getConciergeConfig();
  if (!cfg.enabled) return null;

  const messages = [
    { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
    { role: 'user', content: contextDescription },
  ];

  const streamCfg = { ...cfg, maxTokens: opts.maxTokens || 300 };
  if (activeProvider) {
    streamCfg.model = activeProvider.model;
  }

  try {
    const result = await streamWithFallback(messages, streamCfg, () => {});
    const suggestion = (result.fullResponse || '').trim();
    if (!suggestion || suggestion.length > 150) return null;
    return { suggestion, provider: result.provider, model: result.model };
  } catch {
    return null;
  }
}
