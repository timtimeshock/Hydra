/**
 * Shared Agent Executor — Unified executeAgent() with all options from both pipelines.
 *
 * Features adopted from evolve:
 *   - Stderr capture (32KB buffer)
 *   - Stdin piping (avoids Windows 8191-char limit)
 *   - Progress ticking (elapsed + KB every N seconds)
 *   - Status bar integration
 *   - Configurable output buffer size (default 128KB)
 *
 * Features from nightly:
 *   - Simple agent dispatch (claude/codex)
 *   - Timeout + kill
 */

import spawn from 'cross-spawn';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getActiveModel, getModelReasoningCaps, getReasoningEffort, getAgent, resolveGeminiApproval } from '../hydra-agents.mjs';
import { detectModelError, recoverFromModelError, isModelRecoveryEnabled, detectUsageLimitError, formatResetTime, detectRateLimitError, calculateBackoff, isCircuitOpen, recordModelFailure, verifyAgentQuota } from '../hydra-model-recovery.mjs';
import { loadHydraConfig } from '../hydra-config.mjs';
import { startAgentSpan, endAgentSpan, startPipelineSpan, endPipelineSpan } from '../hydra-telemetry.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from '../hydra-metrics.mjs';
import { streamLocalCompletion } from '../hydra-local.mjs';
import {
  registerSession as hubRegister,
  deregisterSession as hubDeregister,
} from '../hydra-hub.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 128 * 1024;

/**
 * Build the environment for Gemini CLI.
 * Paid Gemini / Code Assist uses Google login (GCA). A GEMINI_API_KEY in env
 * forces auth type gemini-api-key and hides the paid account.
 */
export function buildGeminiCliEnvironment(parentEnv = process.env) {
  const env = { ...parentEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
  const key = String(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '');
  if (key.startsWith('AIza')) {
    if (env.GEMINI_API_KEY && env.GOOGLE_API_KEY) delete env.GOOGLE_API_KEY;
    return env;
  }
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  env.GOOGLE_GENAI_USE_GCA = 'true';
  return env;
}

// Map Hydra internal permission modes to Claude CLI --permission-mode values
const CLAUDE_PERM_MAP = {
  'auto-edit': 'acceptEdits',
  'plan': 'plan',
  'full-auto': 'bypassPermissions',
  'default': 'default',
};
function resolveClaudePerm(mode) {
  return CLAUDE_PERM_MAP[mode] || mode; // pass through if already a valid CLI value
}

// ── Gemini Direct API Workaround (bypass broken CLI v0.27.x) ─────────────────

const GEMINI_OAUTH = {
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
};
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal';
export const CODE_ASSIST_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
};

let _geminiToken = null;
let _geminiTokenExpiry = 0;
let _geminiProjectId = null;

export function pickGeminiProjectId(loadRes, envProject = '') {
  const raw = loadRes?.cloudaicompanionProject;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object') {
    const id = raw.id || raw.projectId;
    if (id) return String(id);
  }
  const env = String(envProject || '').trim();
  if (env && !/^\d+$/.test(env)) return env;
  return null;
}

export function pickGeminiOnboardTierId(loadRes) {
  const tiers = Array.isArray(loadRes?.allowedTiers) ? loadRes.allowedTiers : [];
  const def = tiers.find((t) => t && t.isDefault) || tiers[0];
  if (def?.id) return def.id;
  if (loadRes?.currentTier?.id) return loadRes.currentTier.id;
  return 'free-tier';
}

/** Gemini CLI reads the prompt from stdin. Putting -p <prompt> on argv hits the Windows 8191 limit. */
export function buildGeminiCliArgs({ permissionMode, model } = {}) {
  const geminiPerm = resolveGeminiApproval(permissionMode || 'full-auto');
  const args = ['--approval-mode', geminiPerm, '--skip-trust', '-o', 'json'];
  if (model && model !== 'unknown') args.push('--model', model);
  return args;
}

async function getGeminiToken() {
  if (_geminiToken && Date.now() < _geminiTokenExpiry - 60_000) return _geminiToken;

  const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  if (!fs.existsSync(credsPath)) return null;

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

  if (creds.access_token && creds.expiry_date && Date.now() < creds.expiry_date - 60_000) {
    _geminiToken = creds.access_token;
    _geminiTokenExpiry = creds.expiry_date;
    return _geminiToken;
  }

  if (!creds.refresh_token) return null;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GEMINI_OAUTH.clientId,
      client_secret: GEMINI_OAUTH.clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  _geminiToken = data.access_token;
  _geminiTokenExpiry = Date.now() + (data.expires_in * 1000);

  // Persist so Gemini CLI also benefits
  creds.access_token = data.access_token;
  creds.expiry_date = _geminiTokenExpiry;
  try { fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), 'utf8'); } catch { /* best effort */ }

  return _geminiToken;
}

async function getGeminiProjectId(token) {
  if (_geminiProjectId) return _geminiProjectId;

  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const loadBody = {
    metadata: {
      ...CODE_ASSIST_METADATA,
      ...(envProject ? { duetProject: envProject } : {}),
    },
  };
  if (envProject) loadBody.cloudaicompanionProject = envProject;

  const resp = await fetch(`${CODE_ASSIST_ENDPOINT}:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify(loadBody),
  });
  if (!resp.ok) return pickGeminiProjectId(null, envProject);

  const loadRes = await resp.json().catch(() => ({}));
  let projectId = pickGeminiProjectId(loadRes, envProject);
  if (projectId) {
    _geminiProjectId = projectId;
    return projectId;
  }

  const tierId = pickGeminiOnboardTierId(loadRes);
  const onboardReq = {
    tierId,
    metadata: CODE_ASSIST_METADATA,
  };
  if (tierId !== 'free-tier' && envProject) {
    onboardReq.cloudaicompanionProject = envProject;
    onboardReq.metadata = { ...CODE_ASSIST_METADATA, duetProject: envProject };
  }

  const onboardResp = await fetch(`${CODE_ASSIST_ENDPOINT}:onboardUser`, {
    method: 'POST',
    headers,
    body: JSON.stringify(onboardReq),
  });
  if (!onboardResp.ok) return null;

  let lroRes = await onboardResp.json().catch(() => ({}));
  const deadline = Date.now() + 45_000;
  while (lroRes && !lroRes.done && lroRes.name && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const opResp = await fetch(`${CODE_ASSIST_ENDPOINT}/${lroRes.name}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!opResp.ok) break;
    lroRes = await opResp.json().catch(() => lroRes);
  }

  const onboardProject = lroRes?.response?.cloudaicompanionProject;
  projectId = pickGeminiProjectId(
    { cloudaicompanionProject: onboardProject?.id || onboardProject },
    envProject,
  );
  if (projectId) _geminiProjectId = projectId;
  return projectId;
}

// ── Codex JSONL Helpers ────────────────────────────────────────────────────

/**
 * Extract human-readable text from Codex --json JSONL output.
 */
function parseJsonObjects(raw) {
  const out = [];
  const s = String(raw || '');
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('{', i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    try { out.push(JSON.parse(s.slice(start, end + 1))); } catch { /* skip */ }
    i = end + 1;
  }
  return out;
}

function unescapeJsonString(chunk) {
  try {
    return JSON.parse(`"${chunk}"`);
  } catch {
    return chunk.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }
}

/**
 * Extract human-readable text from Codex --json JSONL (or concatenated JSON).
 */
export function extractCodexText(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const texts = [];
  const seen = new Set();
  const push = (value) => {
    const s = String(value || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    texts.push(s);
  };
  for (const obj of parseJsonObjects(raw)) {
    const item = obj.item;
    if (item?.type === 'agent_message' && item.text) push(item.text);
    const content = obj.message?.content;
    if (typeof content === 'string') push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') push(part);
        else if (part?.text) push(part.text);
      }
    }
    if (typeof obj.content === 'string') push(obj.content);
    if (typeof obj.text === 'string' && obj.type !== 'error' && obj.type !== 'command_execution') {
      push(obj.text);
    }
  }
  if (!texts.length) {
    const re = /"type"\s*:\s*"agent_message"[\s\S]{0,800}?"text"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/g;
    let match;
    while ((match = re.exec(raw))) push(unescapeJsonString(match[1]));
  }
  return texts.length > 0 ? texts.join('\n\n') : raw;
}

/**
 * Best-effort human answer from stored worker output (JSONL, truncated JSON, or plain text).
 */
export function extractAgentAnswer(raw) {
  if (!raw) return '';
  const fromClaude = extractClaudeResult(raw);
  if (fromClaude) return fromClaude.slice(0, 8000);

  const extracted = extractCodexText(raw);
  const text = String(extracted || '').trim();
  if (!text) return '';
  // Only discard explicit error JSON (is_error: true or type: "error"), not all JSON
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (obj.is_error === true || obj.type === 'error') return '';
    } catch {
      // Not valid JSON or truncated - return as-is
    }
  }
  return text.slice(0, 8000);
}

function extractClaudeResult(text) {
  try {
    const obj = JSON.parse(text);
    if (typeof obj.result === 'string' && obj.result.trim()) return obj.result.trim();
    if (typeof obj.message === 'string' && obj.message.trim() && obj.is_error === false) {
      return obj.message.trim();
    }
  } catch {
    /* truncated JSON */
  }
  const match = text.match(/"result"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/);
  if (match) {
    const value = unescapeJsonString(match[1]).trim();
    if (value) return value;
  }
  return '';
}

/**
 * Extract token usage from Codex --json JSONL output.
 * Returns { inputTokens, outputTokens, totalTokens } or null.
 */
export function extractCodexUsage(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const lines = raw.split('\n');
  let usage = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      const u = obj.usage || obj.token_usage;
      if (u) {
        if (!usage) usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        usage.inputTokens += u.input_tokens || u.prompt_tokens || 0;
        usage.outputTokens += u.output_tokens || u.completion_tokens || 0;
        usage.totalTokens += u.total_tokens || (
          (u.input_tokens || u.prompt_tokens || 0) +
          (u.output_tokens || u.completion_tokens || 0)
        );
      }
    } catch { /* skip */ }
  }
  return usage;
}

/**
 * Extract error objects from Codex --json JSONL output.
 */
export function extractCodexErrors(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const lines = raw.split('\n');
  const errors = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === 'error' && obj.message) {
        errors.push(obj.message);
      } else if (obj.error?.message) {
        errors.push(obj.error.message);
      } else if (obj.error && typeof obj.error === 'string') {
        errors.push(obj.error);
      }
    } catch { /* skip */ }
  }
  return errors;
}

// ── Exit Code Interpretation ────────────────────────────────────────────────

const EXIT_CODE_LABELS = {
  1:   'general error',
  2:   'misuse of shell command / invalid arguments',
  126: 'command found but not executable (permission denied)',
  127: 'command not found',
  128: 'invalid exit argument',
  130: 'terminated by Ctrl-C (SIGINT)',
  137: 'killed (SIGKILL / OOM)',
  139: 'segmentation fault (SIGSEGV)',
  143: 'terminated (SIGTERM)',
};

// ── Agent-Specific Error Patterns ───────────────────────────────────────────
// Checked against combined stderr+stdout to produce a structured errorCategory.

const AGENT_ERROR_PATTERNS = [
  // Auth / credential failures
  { pattern: /(?:auth(?:entication|orization)?|credentials?|api.?key|token)\s*(?:failed|expired|invalid|missing|required|denied|error)/i,
    category: 'auth', detail: 'Authentication or API key issue' },
  { pattern: /OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY/i,
    category: 'auth', detail: 'Missing or invalid API key environment variable' },
  { pattern: /unauthorized|401\b|403\b/i,
    category: 'auth', detail: 'Unauthorized or forbidden API response' },

  // Codex sandbox / permission errors
  { pattern: /sandbox\s*(?:violation|error|timeout|denied)/i,
    category: 'sandbox', detail: 'Codex sandbox restriction triggered' },
  { pattern: /execution\s*(?:not permitted|denied|failed|blocked)/i,
    category: 'sandbox', detail: 'Code execution was denied or blocked' },
  { pattern: /permission\s*(?:denied|error|failed)/i,
    category: 'permission', detail: 'Filesystem or execution permission denied' },

  // CLI invocation issues (wrong flags, missing binary)
  { pattern: /unknown\s+(?:flag|option|argument)|unrecognized\s+(?:flag|option)/i,
    category: 'invocation', detail: 'CLI received an unknown flag or option' },
  { pattern: /directory\s+not\s+found|no\s+such\s+directory|invalid\s+working\s+directory|chdir\b/i,
    category: 'invocation', detail: 'Invalid working directory (CWD)' },
  { pattern: /prompt\s*(?:too long|invalid|malformed|format)/i,
    category: 'invocation', detail: 'Prompt formatting or length error' },
  { pattern: /(?:command|binary|executable)\s*not\s*found/i,
    category: 'invocation', detail: 'Agent CLI binary not found on PATH' },
  { pattern: /ENOENT|spawn\s+.*\s+ENOENT/i,
    category: 'invocation', detail: 'Agent CLI binary not found (ENOENT)' },

  // Network / connectivity
  { pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i,
    category: 'network', detail: 'Network connectivity error' },
  { pattern: /(?:fetch|request)\s*failed|network\s*error/i,
    category: 'network', detail: 'HTTP request failed' },
  { pattern: /\b50[023]\b.*(?:error|status)/i,
    category: 'server', detail: 'API server error (5xx)' },

  // JSON / output parsing failures
  { pattern: /(?:unexpected|invalid)\s*(?:token|json|end of)/i,
    category: 'parse', detail: 'Output parsing failure (malformed JSON)' },

  // Generic / Mystery errors (opaque agent or backend failures)
  { pattern: /something went wrong/i,
    category: 'internal', detail: 'Internal agent error (something went wrong)' },
  { pattern: /mystery error/i,
    category: 'internal', detail: 'Internal agent error (mystery error)' },
  { pattern: /internal\s*(?:server\s*)?error|unexpected\s*error/i,
    category: 'internal', detail: 'Internal agent or API error' },
  { pattern: /unhandled\s*(?:exception|error|rejection)/i,
    category: 'internal', detail: 'Unhandled exception in agent process' },

  // Out of memory
  { pattern: /(?:out of memory|heap|ENOMEM|JavaScript heap)/i,
    category: 'oom', detail: 'Process ran out of memory' },

  // Account-level usage/spend limits (NOT transient rate limits — no retry)
  { pattern: /you'?ve hit your usage limit|usage limit has been reached|usage_limit_reached/i,
    category: 'usage-limit', detail: 'API usage limit reached — upgrade or wait for reset' },
  { pattern: /spending_limit_reached|credit balance.*(?:exhausted|zero|empty)/i,
    category: 'usage-limit', detail: 'API spend limit reached — check billing settings' },
];

/**
 * Diagnose a failed agent result by interpreting exit code + stderr patterns.
 * Enriches the result object with errorCategory and errorDetail fields.
 * Exported for use in worker and evolve pipelines.
 *
 * @param {string} agent - Agent name
 * @param {object} result - executeAgent result (mutated in place)
 * @returns {object} The same result, with errorCategory and errorDetail added
 */
export function diagnoseAgentError(agent, result) {
  if (!result || result.ok) return result;

  const code = result.exitCode;
  const stderr = result.stderr || '';
  const stdout = result.output || '';
  const error = result.error || '';
  const combined = [stderr, stdout, error].join('\n');

  // 1. Check agent-specific patterns first (highest signal)
  for (const { pattern, category, detail } of AGENT_ERROR_PATTERNS) {
    if (pattern.test(combined)) {
      result.errorCategory = category;
      result.errorDetail = detail;
      // Extract the matching line for context
      const matchLine = combined.split('\n').find(l => pattern.test(l));
      if (matchLine) result.errorContext = matchLine.trim().slice(0, 300);
      enrichFailureError(result);
      return result;
    }
  }

  // 2. Interpret signal (process killed by signal — code may be null)
  const signal = result.signal;
  if (signal) {
    const signalMap = {
      SIGKILL: { category: 'oom', detail: 'killed (SIGKILL / OOM)' },
      SIGTERM: { category: 'signal', detail: 'terminated (SIGTERM)' },
      SIGINT:  { category: 'signal', detail: 'interrupted (SIGINT)' },
      SIGSEGV: { category: 'crash', detail: 'segmentation fault (SIGSEGV)' },
      SIGABRT: { category: 'crash', detail: 'aborted (SIGABRT)' },
      SIGBUS:  { category: 'crash', detail: 'bus error (SIGBUS)' },
    };
    const mapped = signalMap[signal] || { category: 'signal', detail: `terminated by ${signal}` };
    result.errorCategory = mapped.category;
    result.errorDetail = mapped.detail;
    enrichFailureError(result);
    return result;
  }

  // 3. For Codex with --json output, extract JSONL error events (higher signal than exit code 1)
  if (agent === 'codex') {
    const jsonlErrors = extractCodexErrors(result.stdout || result.output || '');
    if (jsonlErrors.length > 0) {
      result.errorCategory = 'codex-jsonl-error';
      // Show ALL errors, not just count
      const allErrors = jsonlErrors.map(e => String(e).trim()).join(' | ');
      result.errorDetail = jsonlErrors.length === 1
        ? `Codex error: ${jsonlErrors[0].slice(0, 150)}`
        : `Codex errors (${jsonlErrors.length}): ${allErrors.slice(0, 300)}`;
      result.errorContext = allErrors.slice(0, 1000);
      // Fall through to step 8 for error message enrichment
    }
  }

  // 4. Interpret exit code (only if not already classified, e.g. by JSONL extraction)
  if (!result.errorCategory && code !== null && code !== undefined && EXIT_CODE_LABELS[code]) {
    result.errorCategory = code === 127 ? 'invocation' :
                           code === 126 ? 'permission' :
                           code === 137 ? 'oom' :
                           code === 139 ? 'crash' :
                           (code >= 128 && code <= 159) ? 'signal' : 'runtime';
    result.errorDetail = EXIT_CODE_LABELS[code];
    enrichFailureError(result);
    return result;
  }

  // 5. Null exit code with no signal = process died without normal exit
  if (code === null || code === undefined) {
    const stderrTrimmed = stderr.replace(/\[Hydra Telemetry\].*?\n/g, '').trim();
    if (stderrTrimmed) {
      result.errorCategory = 'unclassified';
      result.errorDetail = `${agent} terminated without exit code, but produced stderr`;
      result.errorContext = stderrTrimmed.split('\n').slice(0, 3).join(' | ').slice(0, 300);
    } else {
      result.errorCategory = 'silent-crash';
      result.errorDetail = `${agent} terminated without exit code or signal — possible spawn failure, missing binary, or env issue`;
      if (result.error) result.errorContext = result.error.slice(0, 300);
    }
    enrichFailureError(result);
    return result;
  }

  // 6. Empty output with non-zero exit = likely process died before producing output
  if (!result.errorCategory && code !== 0 && !stdout.trim() && !stderr.trim()) {
    result.errorCategory = 'silent-crash';
    result.errorDetail = `${agent} exited with code ${code} but produced no output — possible early crash, missing binary, or env issue`;
    enrichFailureError(result);
    return result;
  }

  // 7. Non-zero exit with stderr but no pattern match = unclassified
  if (code !== 0 && !result.errorCategory) {
    result.errorCategory = 'unclassified';
    result.errorDetail = `Exit code ${code}`;
    if (stderr.trim()) {
      result.errorContext = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    }
  }

  // 8. Final enrichment: Ensure result.error is descriptive
  if (!result.ok && result.errorCategory && result.errorDetail) {
    enrichFailureError(result);
  }

  return result;
}

/**
 * Replace generic process errors with the structured diagnosis while retaining
 * the original error in errorContext. This is deliberately safe to persist:
 * execution metadata has command shape and environment presence only, never
 * environment values or prompt content.
 */
function enrichFailureError(result) {
  const originalError = result.error || '';
  const isGeneric = !originalError ||
                   originalError.includes('Exit code') ||
                   originalError.includes('Spawn error') ||
                   originalError.includes('Process terminated') ||
                   originalError.includes('mystery error') ||
                   originalError.includes('something went wrong');

  if (!isGeneric) return;

  const signalPart = result.signal ? ` (signal ${result.signal})` : '';
  const codePart = (result.exitCode !== null && result.exitCode !== undefined) ? ` (exit code ${result.exitCode})` : ' (exit code unavailable)';
  result.error = `[${result.errorCategory}] ${result.errorDetail}${signalPart || codePart}`;
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
}

function buildExecutionMetadata({ cmd, args, cwd, prompt, useStdin, timeoutMs, stdoutBytes = 0, stderrBytes = 0, terminationEvent }) {
  return {
    command: cmd,
    args: [...args],
    cwd: cwd || process.cwd(),
    promptBytes: Buffer.byteLength(String(prompt || ''), 'utf8'),
    stdinUsed: Boolean(useStdin),
    timeoutMs,
    stdoutBytes,
    stderrBytes,
    terminationEvent,
    // Record presence only. Never persist environment values or secrets.
    environment: {
      pathPresent: Boolean(process.env.PATH),
      openaiApiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
      codexHomePresent: Boolean(process.env.CODEX_HOME),
    },
  };
}

function hasGeminiOauthCreds() {
  try {
    return fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
  } catch {
    return false;
  }
}

function geminiPreferApiDirect() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (hasGeminiOauthCreds()) return false;
  return String(key).startsWith('AIza');
}

const GEMINI_API_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest'];

async function executeGeminiWithApiKey(prompt, opts, apiKey, ctx) {
  const {
    timeoutMs = 300_000,
    phaseLabel,
    onStatusBar,
  } = opts;
  const { startTime, model, metricsHandle } = ctx;
  const models = [model, ...GEMINI_API_MODELS].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastStatus = 0;
  let lastErr = '';

  try {
    for (const candidate of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = resp.status;
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
        const durationMs = Date.now() - startTime;
        recordCallComplete(metricsHandle, { output: text, stderr: '' });
        if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'done', step: 'idle' });
        return { ok: true, output: text, stderr: '', durationMs, timedOut: false };
      }
      lastErr = await resp.text().catch(() => '');
      if (resp.status !== 404) break;
    }

    const durationMs = Date.now() - startTime;
    const err = `Gemini API ${lastStatus}`;
    recordCallError(metricsHandle, err);
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
    return { ok: false, output: '', stderr: lastErr.slice(0, 500), error: err, durationMs, timedOut: false };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const timedOut = err.name === 'TimeoutError';
    const message = timedOut ? 'Gemini API timeout' : err.message;
    recordCallError(metricsHandle, message);
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
    return { ok: false, output: '', stderr: '', error: message, durationMs, timedOut };
  }
}

async function executeGeminiWithGoogleAuth(prompt, opts, token, ctx) {
  const {
    timeoutMs = 300_000,
    phaseLabel,
    onStatusBar,
  } = opts;
  const { startTime, model, metricsHandle } = ctx;
  const models = [model, ...GEMINI_API_MODELS].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastStatus = 0;
  let lastErr = '';

  try {
    for (const candidate of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = resp.status;
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
        const durationMs = Date.now() - startTime;
        recordCallComplete(metricsHandle, { output: text, stderr: '' });
        if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'done', step: 'idle' });
        return { ok: true, output: text, stderr: '', durationMs, timedOut: false };
      }
      lastErr = await resp.text().catch(() => '');
      if (resp.status !== 404) break;
    }

    const durationMs = Date.now() - startTime;
    const err = `Gemini Google účet bez Code Assist projektu (HTTP ${lastStatus})`;
    recordCallError(metricsHandle, err);
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
    return { ok: false, output: '', stderr: lastErr.slice(0, 500), error: err, durationMs, timedOut: false };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const timedOut = err.name === 'TimeoutError';
    const message = timedOut ? 'Gemini API timeout' : err.message;
    recordCallError(metricsHandle, message);
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
    return { ok: false, output: '', stderr: '', error: message, durationMs, timedOut };
  }
}

async function executeGeminiDirect(prompt, opts = {}) {
  const {
    timeoutMs = 300_000,
    modelOverride,
    phaseLabel,
    onProgress,
    onStatusBar,
  } = opts;

  const startTime = Date.now();
  const model = modelOverride || getActiveModel('gemini');
  const metricsLabel = phaseLabel || 'execute';

  const metricsHandle = recordCallStart('gemini', model);
  if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'executing', step: 'running' });

  try {
    const token = await getGeminiToken();
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!token && apiKey) {
      return await executeGeminiWithApiKey(prompt, opts, apiKey, { startTime, model, metricsHandle });
    }
    if (!token) {
      const durationMs = Date.now() - startTime;
      const err = 'No Gemini OAuth credentials (~/.gemini/oauth_creds.json) and no GEMINI_API_KEY';
      recordCallError(metricsHandle, err);
      if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
      return { ok: false, output: '', stderr: '', error: err, durationMs, timedOut: false };
    }

    const projectId = await getGeminiProjectId(token);
    if (!projectId) {
      return await executeGeminiWithGoogleAuth(prompt, opts, token, { startTime, model, metricsHandle });
    }

    const cfg = loadHydraConfig();
    const rlCfg = cfg.rateLimits || {};
    const maxRetries = rlCfg.maxRetries ?? 3;
    const baseDelayMs = rlCfg.baseDelayMs ?? 5000;
    const maxDelayMs = rlCfg.maxDelayMs ?? 60_000;

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const resp = await fetch(`${CODE_ASSIST_ENDPOINT}:generateContent`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          project: projectId,
          user_prompt_id: crypto.randomUUID(),
          request: {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (resp.ok) {
        const data = await resp.json();
        const text = data?.response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        const durationMs = Date.now() - startTime;
        recordCallComplete(metricsHandle, { output: text, stderr: '' });
        if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'done', step: 'idle' });
        return { ok: true, output: text, stderr: '', durationMs, timedOut: false };
      }

      const errText = await resp.text().catch(() => '');

      if (resp.status === 429 || /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/i.test(errText)) {
        if (attempt < maxRetries) {
          const serverRetryAfter = resp.headers?.get?.('retry-after');
          const retryAfterMs = serverRetryAfter ? parseInt(serverRetryAfter, 10) * 1000 : null;
          const delay = calculateBackoff(attempt, { baseDelayMs, maxDelayMs, retryAfterMs });
          if (onProgress) onProgress(Date.now() - startTime, 0, `Rate limited, retrying in ${(delay / 1000).toFixed(0)}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        lastError = `Gemini API 429 (exhausted ${maxRetries} retries)`;
      } else {
        const durationMs = Date.now() - startTime;
        recordCallError(metricsHandle, `Gemini API ${resp.status}`);
        if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
        return { ok: false, output: '', stderr: errText, error: `Gemini API ${resp.status}`, durationMs, timedOut: false };
      }
    }

    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, lastError || 'Gemini API 429');
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
    return { ok: false, output: '', stderr: '', error: lastError || 'Gemini API 429', durationMs, timedOut: false };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, err.message);
    if (onStatusBar) onStatusBar('gemini', { phase: phaseLabel || 'error', step: 'idle' });
    return {
      ok: false,
      output: '',
      stderr: '',
      error: err.name === 'TimeoutError' ? 'Gemini API timeout' : err.message,
      durationMs,
      timedOut: err.name === 'TimeoutError',
    };
  }
}

// ── Local Agent (OpenAI-compat HTTP) ─────────────────────────────────────────

async function executeLocalAgent(prompt, opts = {}) {
  const {
    timeoutMs = 3 * 60 * 1000,
    onProgress,
    onStatusBar,
    phaseLabel,
    modelOverride,
  } = opts;

  const cfg = loadHydraConfig();
  if (!cfg.local?.enabled) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Local agent not enabled. Set config.local.enabled = true.',
      error: 'local-disabled',
      errorCategory: 'local-disabled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const baseUrl = cfg.local.baseUrl || 'http://localhost:11434/v1';
  const model   = modelOverride || cfg.local.model || 'mistral:7b';
  const startTime = Date.now();
  const metricsHandle = recordCallStart('local', model);
  const span = await startAgentSpan('local', model, { phase: phaseLabel });

  let output = '';
  try {
    const messages = [{ role: 'user', content: prompt }];
    const result = await streamLocalCompletion(
      messages,
      { baseUrl, model, maxTokens: cfg.local.maxTokens },
      (chunk) => {
        output += chunk;
        if (onProgress) {
          const elapsed = Date.now() - startTime;
          onProgress(elapsed, Math.round(Buffer.byteLength(output, 'utf8') / 1024));
        }
      }
    );

    const durationMs = Date.now() - startTime;

    if (!result.ok) {
      recordCallError(metricsHandle, result.errorCategory);
      await endAgentSpan(span, { ok: false, error: result.errorCategory });
      return {
        ok: false,
        output: '',
        stdout: '',
        stderr: result.errorCategory || 'local-unavailable',
        error: result.errorCategory || 'local-unavailable',
        errorCategory: result.errorCategory || 'local-unavailable',
        exitCode: null,
        signal: null,
        durationMs,
        timedOut: false,
      };
    }

    recordCallComplete(metricsHandle, { output: result.output, stdout: result.output });
    await endAgentSpan(span, { ok: true });
    return {
      ok: true,
      output: result.output,
      stdout: result.output,
      stderr: '',
      error: null,
      exitCode: 0,
      signal: null,
      durationMs,
      timedOut: false,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, err.message);
    await endAgentSpan(span, { ok: false, error: err.message });
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: err.message,
      error: err.message,
      errorCategory: 'local-error',
      exitCode: null,
      signal: null,
      durationMs,
      timedOut: false,
    };
  }
}

// ── Custom Agent Helpers ──────────────────────────────────────────────────────

/**
 * Expand {placeholder} tokens in an args array.
 * Unknown placeholders are left intact.
 * @param {string[]} args
 * @param {Record<string, string>} vars
 * @returns {string[]}
 */
export function expandInvokeArgs(args, vars) {
  return args.map(arg =>
    arg.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match))
  );
}

/**
 * Parse CLI stdout based on the agent's responseParser setting.
 * @param {string} stdout
 * @param {'plaintext'|'json'|'markdown'} parser
 * @returns {string}
 */
export function parseCliResponse(stdout, parser) {
  if (parser === 'json') {
    try {
      const data = JSON.parse(stdout);
      return data.content ?? data.text ?? data.message ?? data.output ?? stdout;
    } catch {
      return stdout;
    }
  }
  return stdout; // plaintext and markdown both return raw stdout
}

// ── Custom CLI Agent ──────────────────────────────────────────────────────────

async function executeCustomCliAgent(agentName, prompt, opts = {}) {
  const { cwd, timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const cfg = loadHydraConfig();
  // Prefer registry definition (supports programmatically registered agents), fall back to config
  const def = getAgent(agentName) || (cfg.agents?.customAgents || []).find(a => a.name === agentName);

  if (!def || def.enabled === false) {
    return {
      ok: false, output: '', stdout: '', stderr: 'Custom agent disabled or not found.',
      error: 'custom-cli-disabled', errorCategory: 'custom-cli-disabled',
      exitCode: null, signal: null, durationMs: 0, timedOut: false,
    };
  }

  const invokeConfig = def.invoke?.headless || def.invoke?.nonInteractive;
  if (!invokeConfig?.cmd || !Array.isArray(invokeConfig?.args)) {
    return {
      ok: false, output: '', stdout: '', stderr: 'Custom agent has no valid invoke config.',
      error: 'custom-cli-error', errorCategory: 'custom-cli-error',
      exitCode: null, signal: null, durationMs: 0, timedOut: false,
    };
  }

  const vars = { prompt, cwd: cwd || process.cwd() };
  const args = expandInvokeArgs(invokeConfig.args, vars);
  const cmd = invokeConfig.cmd;
  const startTime = Date.now();
  const metricsHandle = recordCallStart(agentName, agentName);
  const span = await startAgentSpan(agentName, agentName, { phase: phaseLabel });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.on('error', async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const isUnavailable = err.code === 'ENOENT';
      const errorCategory = isUnavailable ? 'custom-cli-unavailable' : 'custom-cli-error';
      recordCallError(metricsHandle, errorCategory);
      await endAgentSpan(span, { ok: false, error: errorCategory });
      resolve({
        ok: false, output: '', stdout: '', stderr: err.message,
        error: errorCategory, errorCategory, exitCode: null,
        signal: null, durationMs, timedOut: false,
      });
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (onProgress) onProgress(Date.now() - startTime, Math.round(stdout.length / 1024));
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const isFailure = (code !== 0 || Boolean(signal)) && !timedOut;
      if (isFailure) {
        recordCallError(metricsHandle, 'custom-cli-error');
        await endAgentSpan(span, { ok: false, error: 'custom-cli-error' });
        resolve({
          ok: false, output: '', stdout, stderr,
          error: 'custom-cli-error', errorCategory: 'custom-cli-error',
          exitCode: code, signal, durationMs, timedOut: false,
        });
        return;
      }
      const output = parseCliResponse(stdout, def.responseParser || 'plaintext');
      recordCallComplete(metricsHandle, { output, stdout: output });
      await endAgentSpan(span, { ok: !timedOut });
      resolve({
        ok: !timedOut, output, stdout: output, stderr,
        error: timedOut ? 'timeout' : null,
        errorCategory: timedOut ? 'custom-cli-error' : null,
        exitCode: code, signal, durationMs, timedOut,
      });
    });
  });
}

// ── Custom API Agent ──────────────────────────────────────────────────────────

async function executeCustomApiAgent(agentName, prompt, opts = {}) {
  const { timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const cfg = loadHydraConfig();
  // Prefer registry definition (supports programmatically registered agents), fall back to config
  const def = getAgent(agentName) || (cfg.agents?.customAgents || []).find(a => a.name === agentName);

  if (!def || def.enabled === false) {
    return {
      ok: false, output: '', stdout: '', stderr: 'Custom API agent disabled or not found.',
      error: 'custom-api-disabled', errorCategory: 'custom-api-disabled',
      exitCode: null, signal: null, durationMs: 0, timedOut: false,
    };
  }

  const baseUrl = def.baseUrl || 'http://localhost:11434/v1';
  const model = def.model || 'default';
  const startTime = Date.now();
  const metricsHandle = recordCallStart(agentName, model);
  const span = await startAgentSpan(agentName, model, { phase: phaseLabel });
  const abortSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  let output = '';
  try {
    const messages = [{ role: 'user', content: prompt }];
    const result = await streamLocalCompletion(
      messages,
      { baseUrl, model, maxTokens: def.maxTokens, signal: abortSignal },
      (chunk) => {
        output += chunk;
        if (onProgress) onProgress(Date.now() - startTime, Math.round(Buffer.byteLength(output, 'utf8') / 1024));
      }
    );

    const durationMs = Date.now() - startTime;
    if (!result.ok) {
      recordCallError(metricsHandle, result.errorCategory);
      await endAgentSpan(span, { ok: false, error: result.errorCategory });
      return {
        ok: false, output: '', stdout: '', stderr: result.errorCategory,
        error: result.errorCategory, errorCategory: result.errorCategory,
        exitCode: null, signal: null, durationMs, timedOut: false,
      };
    }

    recordCallComplete(metricsHandle, { output: result.output, stdout: result.output });
    await endAgentSpan(span, { ok: true });
    return {
      ok: true, output: result.output, stdout: result.output, stderr: '',
      error: null, errorCategory: null, exitCode: 0, signal: null, durationMs, timedOut: false,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, 'custom-cli-error');
    await endAgentSpan(span, { ok: false, error: err.message });
    return {
      ok: false, output: '', stdout: '', stderr: err.message,
      error: 'custom-cli-error', errorCategory: 'custom-cli-error',
      exitCode: null, signal: null, durationMs, timedOut: false,
    };
  }
}

/**
 * Execute an agent CLI as a headless subprocess.
 *
 * @param {string} agent - Agent name: 'claude', 'codex', 'gemini'
 * @param {string} prompt - The prompt to send
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Working directory
 * @param {number} [opts.timeoutMs] - Timeout in ms (default: 15 min)
 * @param {string} [opts.modelOverride] - Model override string
 * @param {boolean} [opts.collectStderr=true] - Collect stderr output
 * @param {boolean} [opts.useStdin=true] - Pipe prompt via stdin (avoids Windows cmd limits)
 * @param {number} [opts.progressIntervalMs=0] - Log progress every N ms (0 = disabled)
 * @param {Function} [opts.onProgress] - Callback: (elapsed, outputKB, status?) => void
 * @param {Function} [opts.onStatusBar] - Callback for status bar updates: (agent, meta) => void
 * @param {number} [opts.maxOutputBytes] - Max stdout buffer (default: 128KB)
 * @param {number} [opts.maxStderrBytes] - Max stderr buffer (default: 32KB)
 * @param {string} [opts.phaseLabel] - Label for status bar (e.g., 'Task 3/5')
 * @param {string} [opts.permissionMode] - Override permission mode (claude: 'plan'|'auto-edit', codex: 'read-only'|'full-auto')
 * @returns {Promise<{ok: boolean, output: string, stderr: string, error: string|null, exitCode: number|null, signal: string|null, durationMs: number, timedOut: boolean, errorCategory?: string, errorDetail?: string}>}
 */
export async function executeAgent(agent, prompt, opts = {}) {
  // Hub registration (opt-in via opts.hubCwd)
  let _hubSessId = null;
  if (opts.hubCwd) {
    try {
      _hubSessId = hubRegister({
        agent: opts.hubAgent || `${agent}-forge`,
        cwd: opts.hubCwd,
        project: opts.hubProject || path.basename(opts.hubCwd),
        focus: String(prompt).slice(0, 100),
      });
    } catch { /* hub is non-critical */ }
  }

  const _hubCleanup = () => {
    if (_hubSessId) {
      try { hubDeregister(_hubSessId); } catch { /* non-critical */ }
      _hubSessId = null;
    }
  };

  // Gemini: without OAuth the CLI ignores a working GEMINI_API_KEY (AQ. / no settings).
  // Diagnostics already proved the HTTP key works — skip the broken CLI.
  if (agent === 'gemini' && geminiPreferApiDirect()) {
    try {
      process.stderr.write('[gemini] bez OAuth — jdu rovnou na Gemini API\n');
      return await executeGeminiDirect(prompt, opts);
    } finally {
      _hubCleanup();
    }
  }

  // Local agent: call OpenAI-compat HTTP endpoint directly (no cross-spawn)
  if (agent === 'local') {
    try {
      return await executeLocalAgent(prompt, opts);
    } finally {
      _hubCleanup();
    }
  }

  // Custom physical agents (CLI and API types registered via agents.customAgents config)
  const _customDef = getAgent(agent);
  if (_customDef?.customType === 'cli') {
    try {
      return await executeCustomCliAgent(agent, prompt, opts);
    } finally {
      _hubCleanup();
    }
  }
  if (_customDef?.customType === 'api') {
    try {
      return await executeCustomApiAgent(agent, prompt, opts);
    } finally {
      _hubCleanup();
    }
  }

  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    modelOverride,
    reasoningEffort: effortOverride,
    collectStderr = true,
    useStdin = true,
    progressIntervalMs = 0,
    onProgress,
    onStatusBar,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    phaseLabel,
    permissionMode,
  } = opts;

  if (modelOverride && !/^[a-zA-Z0-9-.:]+$/.test(modelOverride)) {
    _hubCleanup();
    return {
      ok: false,
      output: '',
      stderr: `Invalid model override format: "${modelOverride}"`,
      error: 'Security violation: invalid model format',
      exitCode: null,
      durationMs: 0,
      timedOut: false
    };
  }

  const effectiveModel = modelOverride || getActiveModel(agent) || 'unknown';

  // OTel tracing
  const spanPromise = startAgentSpan(agent, effectiveModel, {
    phase: phaseLabel,
    taskType: opts.taskType,
  });

  // Metrics recording
  const metricsHandle = recordCallStart(agent, effectiveModel);

  const runCli = () => new Promise((resolve) => {
    let cmd, args;
    let useStdinForPrompt = useStdin;

    if (agent === 'codex') {
      if (permissionMode === 'read-only') {
        args = ['exec', '-', '-s', 'read-only'];
      } else {
        args = ['exec', '-', '--sandbox', process.platform === 'win32' ? 'danger-full-access' : 'workspace-write', '--skip-git-repo-check'];
      }
      if (cwd) args.push('-C', cwd);
      if (effectiveModel) args.push('--model', effectiveModel);
      // Reasoning effort for o-series models
      const codexEffort = effortOverride || getReasoningEffort('codex');
      if (codexEffort && effectiveModel) {
        const caps = getModelReasoningCaps(effectiveModel);
        if (caps.type === 'effort') {
          args.push('--reasoning-effort', codexEffort);
        }
      }
      // Request JSON output for better structured parsing if supported
      args.push('--json');
      cmd = 'codex';
    } else if (agent === 'gemini') {
      args = buildGeminiCliArgs({ permissionMode, model: effectiveModel });
      useStdinForPrompt = true;
      cmd = 'gemini';
    } else {
      // claude + opus (Opus is Claude CLI with --model opus)
      const claudePerm = resolveClaudePerm(permissionMode || 'full-auto');
      if (useStdinForPrompt) {
        args = ['--output-format', 'json', '--permission-mode', claudePerm];
      } else {
        args = ['-p', prompt, '--output-format', 'json', '--permission-mode', claudePerm];
      }
      const claudeModel = agent === 'opus'
        ? (modelOverride || getActiveModel('opus') || 'claude-opus-4-6')
        : modelOverride;
      if (claudeModel) args.push('--model', claudeModel);
      cmd = 'claude';
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    const stderrChunks = [];
    let stderrBytes = 0;

    const stdinMode = useStdinForPrompt ? 'pipe' : 'ignore';

    // Strip CLAUDECODE env var so nested Claude sessions don't get blocked
    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;
    if (agent === 'gemini') Object.assign(childEnv, buildGeminiCliEnvironment(childEnv));

    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: [stdinMode, 'pipe', 'pipe'],
    });

    if (useStdinForPrompt && child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => {
      stdoutBytes += Buffer.byteLength(d);
      stdoutChunks.push(d);
      while (stdoutBytes > maxOutputBytes && stdoutChunks.length > 1) {
        const dropped = stdoutChunks.shift();
        stdoutBytes -= Buffer.byteLength(dropped);
      }
    });

    if (collectStderr) {
      child.stderr.on('data', (d) => {
        stderrBytes += Buffer.byteLength(d);
        stderrChunks.push(d);
        while (stderrBytes > maxStderrBytes && stderrChunks.length > 1) {
          const dropped = stderrChunks.shift();
          stderrBytes -= Buffer.byteLength(dropped);
        }
      });
    }

    const startTime = Date.now();
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.stderr.write(`[${agent}] timeout ${timeoutMs}ms — zabijím proces\n`);
      } catch { /* ignore */ }
      killProcessTree(child);
    }, timeoutMs);

    let progressTimer = null;
    if (progressIntervalMs > 0 && onProgress) {
      progressTimer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const outputKB = Math.round(stdoutBytes / 1024);
        onProgress(elapsed, outputKB);
      }, progressIntervalMs);
    }

    if (onStatusBar) {
      onStatusBar(agent, { phase: phaseLabel || 'executing', step: 'running' });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      const output = stdoutChunks.join('');
      let stderr = stderrChunks.join('');

      // Add telemetry to stderr on spawn error
      const fullCmd = `${cmd} ${args.join(' ')}`;
      const telemetry = `[Hydra Telemetry] Failed Command: ${fullCmd}\n[Hydra Telemetry] Spawn Error: ${err.message}`;
      stderr = `${stderr}\n\n${telemetry}`.trim();

      const result = {
        ok: false,
        output,
        stdout: output,
        stderr,
        error: `Spawn error: ${err.message}`,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startTime,
        timedOut: false,
        command: cmd,
        args,
        promptSnippet: prompt.slice(0, 500),
        execution: buildExecutionMetadata({
          cmd, args, cwd, prompt, useStdin: useStdinForPrompt, timeoutMs,
          stdoutBytes, stderrBytes, terminationEvent: 'error',
        }),
      };
      diagnoseAgentError(agent, result);
      recordCallError(metricsHandle, result.error);
      spanPromise.then(span => endAgentSpan(span, result)).catch(() => {});
      _hubCleanup();
      resolve(result);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      if (onStatusBar) {
        onStatusBar(agent, { phase: phaseLabel || 'done', step: 'idle' });
      }
      const rawOutput = stdoutChunks.join('');
      let stderr = stderrChunks.join('');

      let output = rawOutput;
      let tokenUsage = null;
      let jsonlErrors = [];

      // Codex-specific JSONL processing
      if (agent === 'codex') {
        try {
          output = extractCodexText(rawOutput);
          tokenUsage = extractCodexUsage(rawOutput);
          jsonlErrors = extractCodexErrors(rawOutput);
        } catch { /* use raw */ }
      }

      const hasJsonlErrors = jsonlErrors.length > 0;
      const isOk = code === 0 && !signal && !hasJsonlErrors;
      const elapsedMs = Date.now() - startTime;

      if (!isOk) {
        const fullCmd = `${cmd} ${args.join(' ')}`;
        let telemetry = `[Hydra Telemetry] Failed Command: ${fullCmd}\n[Hydra Telemetry] Exit Code: ${code ?? 'null'}\n[Hydra Telemetry] Signal: ${signal ?? 'null'}\n[Hydra Telemetry] Duration: ${elapsedMs}ms`;
        if (elapsedMs < 5000 && !timedOut) telemetry += ` (startup failure suspected — exited before doing real work)`;
        if (hasJsonlErrors) telemetry += `\n[Hydra Telemetry] JSONL Errors: ${jsonlErrors.length}`;
        if (timedOut) telemetry += `\n[Hydra Telemetry] Status: Timed Out`;
        stderr = `${stderr}\n\n${telemetry}`.trim();
      }

      let error = null;
      if (!isOk) {
        const parts = [];
        if (signal) parts.push(`Signal ${signal}`);
        if (code !== null && code !== undefined && code !== 0) parts.push(`Exit code ${code}`);
        if (hasJsonlErrors) parts.push(`JSONL errors: ${jsonlErrors.join('; ')}`);
        if (!parts.length) parts.push('Process terminated abnormally');
        if (timedOut) parts.push('(timed out)');
        error = parts.join(', ');
      }

      const result = {
        ok: isOk,
        output,
        stdout: rawOutput,
        stderr,
        error,
        exitCode: code,
        signal: signal || null,
        durationMs: elapsedMs,
        timedOut,
        startupFailure: !isOk && elapsedMs < 5000 && !timedOut,
        tokenUsage,
        command: cmd,
        args,
        promptSnippet: prompt.slice(0, 500),
        execution: buildExecutionMetadata({
          cmd, args, cwd, prompt, useStdin: useStdinForPrompt, timeoutMs,
          stdoutBytes, stderrBytes, terminationEvent: 'close',
        }),
      };

      if (!result.ok) {
        diagnoseAgentError(agent, result);
        recordCallError(metricsHandle, result.error);
      } else {
        recordCallComplete(metricsHandle, { output: rawOutput, stderr, tokenUsage });
      }

      spanPromise.then(span => endAgentSpan(span, result)).catch(() => {});
      _hubCleanup();
      resolve(result);
    });
  });

  const cliResult = await runCli();
  if (agent !== 'gemini' || cliResult.ok) {
    return cliResult;
  }
  try {
    const why = cliResult.timedOut ? 'timeout' : (cliResult.error || `kód ${cliResult.exitCode}`);
    process.stderr.write(`[gemini] CLI selhal (${why}) — zkouším Gemini API\n`);
    const fallback = await executeGeminiDirect(prompt, opts);
    if (fallback.ok) {
      fallback.output = `${fallback.output || ''}`.trim();
      fallback.stderr = [cliResult.stderr, fallback.stderr].filter(Boolean).join('\n');
      return fallback;
    }
    fallback.stderr = [cliResult.stderr, fallback.stderr].filter(Boolean).join('\n');
    fallback.error = fallback.error || cliResult.error;
    return fallback;
  } catch {
    return cliResult;
  }
}

/**
 * Execute an agent with automatic model-error recovery.
 *
 * Calls executeAgent() first. If the result indicates a model error
 * (e.g. "model not found"), attempts to select a fallback model and retry.
 *
 * @param {string} agent - Agent name
 * @param {string} prompt - The prompt to send
 * @param {object} [opts] - Same options as executeAgent, plus:
 * @param {object} [opts.rl] - readline interface for interactive fallback selection
 * @returns {Promise<object>} executeAgent result, augmented with { recovered, originalModel }
 */
export async function executeAgentWithRecovery(agent, prompt, opts = {}) {
  const cfg = loadHydraConfig();
  const currentModel = opts.modelOverride || null;
  const recoverySpan = await startPipelineSpan('agent-recovery', { 'gen_ai.agent.name': agent });

  let finalResult;
  try {
    // Circuit breaker: skip directly to fallback if model is tripped
    if (currentModel && isCircuitOpen(currentModel)) {
      const recovery = await recoverFromModelError(agent, currentModel, { rl: opts.rl });
      if (recovery.recovered) {
        const retryResult = await executeAgent(agent, prompt, { ...opts, modelOverride: recovery.newModel });
        retryResult.recovered = true;
        retryResult.originalModel = currentModel;
        retryResult.newModel = recovery.newModel;
        retryResult.circuitBreakerTripped = true;
        finalResult = retryResult;
        return retryResult;
      }
      finalResult = { ok: false, output: '', stdout: '', stderr: '', error: 'Circuit breaker open, no fallback available', exitCode: null, durationMs: 0, timedOut: false, circuitBreakerTripped: true };
      return finalResult;
    }

    const result = await executeAgent(agent, prompt, opts);

    if (result.ok || !isModelRecoveryEnabled()) {
      finalResult = result;
      return result;
    }

    if (result.errorCategory === 'auth') {
      finalResult = result;
      return result;
    }

    // Local-unavailable: transparent cloud fallback, no circuit breaker
    if (result.errorCategory === 'local-unavailable') {
      const cfg = loadHydraConfig();
      const fallback = cfg.routing?.mode === 'economy' ? 'codex' : 'claude';
      process.stderr.write(`[local] server unreachable — falling back to ${fallback}\n`);
      finalResult = await executeAgent(fallback, prompt, { ...opts, _localFallback: true });
      return finalResult;
    }

    // Custom-CLI-unavailable: binary not found on PATH — fall back to cloud agent
    if (result.errorCategory === 'custom-cli-unavailable') {
      const fallback = 'claude';
      process.stderr.write(`[${agent}] CLI not found on PATH — falling back to ${fallback}\n`);
      finalResult = await executeAgent(fallback, prompt, { ...opts, _customFallback: true });
      return finalResult;
    }

    // Check usage limits — verify with API before committing to disable.
    // Pattern matching alone can produce false positives (e.g. Codex echoing
    // documentation that mentions "usage_limit_reached"). A quick GET /models
    // call tells us whether the account is actually quota-exhausted.
    const usageCheck = detectUsageLimitError(agent, result);
    if (usageCheck.isUsageLimit) {
      const verification = await verifyAgentQuota(agent, { hintText: usageCheck.errorMessage });
      if (verification.verified === true) {
        // API confirmed quota exhausted — hard-disable the agent.
        const resetLabel = formatResetTime(usageCheck.resetInSeconds);
        result.usageLimited = true;
        result.usageLimitConfirmed = true;
        result.resetInSeconds = usageCheck.resetInSeconds;
        result.usageLimitDetail = usageCheck.errorMessage;
        result.error = `${agent} usage limit confirmed by API (resets in ${resetLabel})`;
        finalResult = result;
        return result;
      } else if (verification.verified === 'unknown' && result.errorCategory === 'codex-jsonl-error') {
        // Structured JSONL event from the Codex CLI itself — authoritative, not a
        // text pattern match on arbitrary output. Trust it even without API key.
        const resetLabel = formatResetTime(usageCheck.resetInSeconds);
        result.usageLimited = true;
        result.usageLimitConfirmed = true;
        result.usageLimitStructured = true; // from JSONL, not pattern match
        result.resetInSeconds = usageCheck.resetInSeconds;
        result.usageLimitDetail = usageCheck.errorMessage;
        result.error = `${agent} usage limit (structured JSONL — resets in ${resetLabel})`;
        finalResult = result;
        return result;
      } else {
        // verified === false (API says account active) OR verified === 'unknown'
        // without a structured error source — cannot confirm quota exhaustion.
        // Fall through to rate-limit handling (may be a false positive).
        result.usageLimitFalsePositive = true;
        result.usageLimitPattern = usageCheck.errorMessage;
        if (verification.verified === 'unknown') {
          result.usageLimitUnverifiable = true; // callers can log/surface this
        }
      }
    }

    // Rate limit retry with exponential backoff
    const rateCheck = detectRateLimitError(agent, result);
    if (rateCheck.isRateLimit) {
      const maxRetries = cfg.rateLimits?.maxRetries || 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const delayMs = calculateBackoff(attempt, {
          baseDelayMs: cfg.rateLimits?.baseDelayMs,
          maxDelayMs: cfg.rateLimits?.maxDelayMs,
          retryAfterMs: rateCheck.retryAfterMs,
        });
        await new Promise(r => setTimeout(r, delayMs));
        const retryResult = await executeAgent(agent, prompt, opts);
        if (retryResult.ok) {
          retryResult.rateLimitRetries = attempt;
          finalResult = retryResult;
          return retryResult;
        }
        // Check if still rate limited
        const recheck = detectRateLimitError(agent, retryResult);
        if (!recheck.isRateLimit) {
          retryResult.rateLimitRetries = attempt;
          finalResult = retryResult;
          return retryResult;
        }
      }
      result.rateLimitExhausted = true;
      result.rateLimitRetries = maxRetries;
      finalResult = result;
      return result;
    }

    // Model error → fallback
    const detection = detectModelError(agent, result);
    if (!detection.isModelError) {
      finalResult = result;
      return result;
    }

    // Record failure for circuit breaker
    if (detection.failedModel) {
      recordModelFailure(detection.failedModel);
    }

    const recovery = await recoverFromModelError(agent, detection.failedModel, {
      rl: opts.rl,
    });

    if (!recovery.recovered) {
      result.modelError = detection;
      finalResult = result;
      return result;
    }

    // Retry with the new model
    const retryResult = await executeAgent(agent, prompt, {
      ...opts,
      modelOverride: recovery.newModel,
    });

    retryResult.recovered = true;
    retryResult.originalModel = detection.failedModel;
    retryResult.newModel = recovery.newModel;
    finalResult = retryResult;
    return retryResult;
  } finally {
    await endPipelineSpan(recoverySpan, { ok: finalResult?.ok ?? false, error: finalResult?.error });
  }
}
