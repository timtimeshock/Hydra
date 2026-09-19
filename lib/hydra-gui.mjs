#!/usr/bin/env node
/**
 * Hydra Windows GUI — local web window over the existing daemon.
 * Console operator stays available; this is the clickable front-end.
 */
import './hydra-env.mjs';
import http from 'http';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFile, spawnSync } from 'child_process';
import { spawnHydraNode } from './hydra-exec.mjs';
import { resolveProject, HYDRA_ROOT } from './hydra-config.mjs';
import { getActiveModel } from './hydra-agents.mjs';
import { request } from './hydra-utils.mjs';
import { extractAgentAnswer } from './hydra-shared/agent-executor.mjs';
import {
  initConcierge,
  isConciergeAvailable,
  conciergeTurn,
  getConciergeModelLabel,
  setConciergeBaseUrl,
} from './hydra-concierge.mjs';
import {
  parseCouncilPhaseEvents,
  currentPhaseFromEvents,
  buildRunStatus,
  isHeartbeatChunk,
  parseHeartbeatEvent,
  formatHeartbeatLine,
  formatExitCode,
  isForcedExit,
  stripAnsi,
} from './hydra-run-status.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.HYDRA_PROJECT = HYDRA_ROOT;
// Local daemon/GUI must work without WAN — never send 127.0.0.1 through a system proxy.
{
  const bypass = '127.0.0.1,localhost,::1';
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const cur = String(process.env[key] || '').trim();
    process.env[key] = cur ? `${cur},${bypass}` : bypass;
  }
}

const GUI_HOST = process.env.HYDRA_GUI_HOST || '127.0.0.1';
const GUI_PORT = Number.parseInt(process.env.HYDRA_GUI_PORT || '4176', 10);
const DAEMON_URL = process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';
const GUI_DIR = path.join(HYDRA_ROOT, 'gui');

const logLines = [];
const MAX_LOG = 400;
const LOG_FILE = path.join(HYDRA_ROOT, 'docs', 'coordination', 'gui-log.txt');
const hiddenAnswerIds = new Set();
const localAnswers = [];
const MAX_LOCAL_ANSWERS = 8;
let job = null;
let liveCliCache = { at: 0, agents: [] };

function noteJobOutput(chunk) {
  if (!job) return;
  if (!isHeartbeatChunk(chunk)) {
    job.lastOutputAt = Date.now();
  }
  const events = parseCouncilPhaseEvents(chunk);

  // Log errors from council phases
  for (const evt of events) {
    if (evt.action === 'complete' && evt.ok === false) {
      const agent = evt.agent || '?';
      const phase = evt.phase || '?';
      const error = evt.errorDetail || evt.error || 'Unknown error';
      const cat = evt.errorCategory ? `[${evt.errorCategory}] ` : '';
      appendLog(`✗ ${agent} ${phase}: ${cat}${error.slice(0, 150)}`);
    }
  }

  const phase = currentPhaseFromEvents(events);
  if (phase?.agent) {
    job.currentAgent = phase.agent;
    job.currentPhase = phase.phase || job.currentPhase || '';
    if (phase.round) job.currentRound = phase.round;
  }
}

function formatLogPart(part) {
  const text = stripAnsi(part).replace(/\r/g, '').trimEnd();
  if (!text) return '';
  if (/^\s*\{/.test(text) && /"type"\s*:\s*"council_/.test(text)) return '';
  const hb = parseHeartbeatEvent(text);
  if (hb) return formatHeartbeatLine(hb);
  return text;
}

function savePersistedLog() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, logLines.join('\n') + (logLines.length ? '\n' : ''), 'utf8');
  } catch {
    /* disk full / lock */
  }
}

function loadPersistedLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const raw = fs.readFileSync(LOG_FILE, 'utf8').replace(/\r/g, '');
    const lines = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-MAX_LOG);
    logLines.push(...lines);
  } catch {
    /* missing / unreadable */
  }
}

function appendLog(line) {
  const text = stripAnsi(String(line || '')).replace(/\r/g, '').trimEnd();
  if (!text) return;
  for (const part of text.split('\n')) {
    const cleaned = formatLogPart(part);
    if (!cleaned) continue;
    logLines.push(`[${new Date().toLocaleTimeString('cs-CZ')}] ${cleaned}`);
  }
  if (logLines.length > MAX_LOG) logLines.splice(0, logLines.length - MAX_LOG);
  savePersistedLog();
}

function listLiveAgentClis() {
  const now = Date.now();
  if (now - liveCliCache.at < 2500) return Promise.resolve(liveCliCache.agents);
  if (process.platform !== 'win32') {
    liveCliCache = { at: now, agents: [] };
    return Promise.resolve([]);
  }
  const ps = [
    "Get-CimInstance Win32_Process |",
    "Where-Object { $_.CommandLine -match 'gemini\\.js|@openai/codex|@anthropic-ai/claude' } |",
    "ForEach-Object {",
    "  if ($_.CommandLine -match 'gemini\\.js') { 'gemini' }",
    "  elseif ($_.CommandLine -match '@openai/codex|codex\\.exe') { 'codex' }",
    "  elseif ($_.CommandLine -match '@anthropic-ai/claude') { 'claude' }",
    "}",
  ].join(' ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 4000,
      maxBuffer: 200_000,
    }, (err, stdout) => {
      const agents = [];
      if (!err) {
        for (const name of String(stdout || '').split(/\r?\n/)) {
          const n = name.trim().toLowerCase();
          if (n && !agents.includes(n)) agents.push(n);
        }
      }
      liveCliCache = { at: Date.now(), agents };
      resolve(agents);
    });
  });
}

async function daemonJson(method, route, body) {
  return request(method, DAEMON_URL, route, body, { timeoutMs: 4_000 });
}

async function daemonHealthy(timeoutMs = 1_500) {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  if (await daemonHealthy()) return true;
  const project = resolveProject({ skipValidation: true });
  appendLog('Starting daemon…');
  const child = spawnHydraNode(path.join(HYDRA_ROOT, 'lib', 'orchestrator-daemon.mjs'), ['start'], {
    cwd: process.env.HYDRA_PROJECT || project.projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonHealthy()) {
      appendLog('Daemon running');
      return true;
    }
  }
  return false;
}

/** Cached WAN probe — GUI stays up either way; agents need this true. */
let internetCache = { at: 0, ok: null };
function probeInternet(timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}
async function getInternetOk() {
  if (Date.now() - internetCache.at < 20_000 && internetCache.ok !== null) {
    return internetCache.ok;
  }
  const ok = await probeInternet();
  internetCache = { at: Date.now(), ok };
  return ok;
}

function sendJson(res, code, data) {
  const raw = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function collectAnswers(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  return tasks.slice(-8).reverse().map((t) => {
    const results = Array.isArray(t.results) ? t.results : [];
    const last = results[results.length - 1] || {};
    const parts = [];
    for (const result of results) {
      const text = extractAgentAnswer(result.output || '');
      if (text && !parts.includes(text)) parts.push(text);
    }
    return {
      id: t.id,
      title: t.title || '',
      status: t.status,
      agent: last.agent || t.owner || '',
      answer: parts.join('\n\n'),
    };
  }).filter((row) => row.answer || row.status === 'done');
}

function parseCouncilPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* mixed stdout — take the last JSON object */
  }
  const start = text.lastIndexOf('{"ok"');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function extractCouncilAnswer(raw) {
  const payload = parseCouncilPayload(raw);
  const report = payload?.report;
  if (!report) return extractAgentAnswer(raw);
  const transcript = Array.isArray(report.transcript) ? report.transcript : [];
  const implementation = [...transcript].reverse().find((entry) => entry.phase === 'implement') || {};
  const parsed = implementation.parsed || {};
  const changedPaths = parsed.changed_paths || parsed.changedPaths
    || parsed.files_changed || parsed.filesChanged || [];
  const paths = Array.isArray(changedPaths) ? changedPaths.filter((value) => typeof value === 'string') : [];
  const lastOk = [...transcript].reverse().find((entry) => entry.ok && entry.parsed);
  const view = lastOk?.parsed?.decision?.summary
    || lastOk?.parsed?.view
    || lastOk?.parsed?.critique
    || '';
  const errors = transcript
    .filter((entry) => entry && entry.ok === false && entry.error)
    .map((entry) => `${entry.agent || '?'} ${entry.phase || ''}: ${String(entry.error).slice(0, 280)}`);
  return [
    report.consensus || report.finalDecision?.summary || view,
    paths.length ? `Změněné soubory:\n${paths.map((file) => `- ${file}`).join('\n')}` : '',
    errors.length ? `Chyby:\n${errors.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function addLocalAnswer(answer) {
  if (!answer?.answer) return;
  localAnswers.unshift(answer);
  if (localAnswers.length > MAX_LOCAL_ANSWERS) localAnswers.length = MAX_LOCAL_ANSWERS;
}

function writePromptFile(text) {
  const file = path.join(os.tmpdir(), `hydra-gui-prompt-${Date.now()}-${process.pid}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function startJob(kind, scriptName, extraArgs, promptText) {
  if (job) {
    throw new Error('Už běží úloha: ' + job.kind);
  }
  const projectRoot = process.env.HYDRA_PROJECT || resolveProject({ skipValidation: true }).projectRoot;
  const promptFile = writePromptFile(promptText);
  const args = [`promptFile=${promptFile}`, ...extraArgs];
  appendLog(`▶ ${kind} (${promptText.length} znaků, soubor)`);
  const child = spawnHydraNode(path.join(HYDRA_ROOT, 'lib', scriptName), args, {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HYDRA_PROJECT: projectRoot },
  });
  job = {
    kind,
    startedAt: Date.now(),
    lastOutputAt: Date.now(),
    currentAgent: null,
    currentPhase: '',
    currentRound: null,
    child,
    stdout: '',
    promptFile,
    stopped: false,
    lastHangLogAt: 0,
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d) => {
    job?.stdout !== undefined && (job.stdout += d);
    noteJobOutput(d);
    appendLog(d);
  });
  child.stderr?.on('data', (d) => {
    noteJobOutput(d);
    appendLog(d);
  });
  child.on('close', async (code) => {
    const finishedJob = job;
    const stopped = Boolean(finishedJob?.stopped) || isForcedExit(code);
    job = null;
    if (finishedJob?.promptFile) {
      try { fs.unlinkSync(finishedJob.promptFile); } catch { /* temp */ }
    }
    if (stopped) {
      appendLog(`■ ${kind} zastaveno (${formatExitCode(code)})`);
      appendLog('Council byl zastaven — žádná hotová odpověď.');
      return;
    }
    appendLog(`■ ${kind} skončilo (kód ${formatExitCode(code)})`);
    if (kind === 'council') {
      const answer = extractCouncilAnswer(finishedJob?.stdout || '');
      if (answer) {
        addLocalAnswer({
          id: `council-${Date.now()}`,
          title: 'Hydra Council',
          status: code === 0 ? 'done' : 'failed',
          agent: 'council',
          answer,
        });
        appendLog(`Odpověď Council: ${answer}`);
        return;
      }
    }
    try {
      const packed = await daemonJson('GET', '/state');
      const latest = collectAnswers(packed?.state)[0];
      if (latest?.answer) {
        appendLog(`Odpověď ${latest.agent || ''} ${latest.id}: ${latest.answer}`);
      } else {
        appendLog('Council skončil bez čitelné odpovědi.');
      }
    } catch {
      /* ignore */
    }
  });
  child.on('error', (err) => {
    appendLog(`✗ ${kind}: ${err.message}`);
    if (job?.promptFile) {
      try { fs.unlinkSync(job.promptFile); } catch { /* temp */ }
    }
    job = null;
  });
}

function killJobTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** True if a CLI binary is on PATH. Auth method (Anthropic / Bedrock / ChatGPT / API) is irrelevant. */
function cliOnPath(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(cmd, [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 && Boolean((result.stdout || '').trim());
  } catch {
    return false;
  }
}

async function diagnoseGeminiAccount(_home) {
  return {
    id: 'gemini',
    nameKey: 'diagNameGemini',
    detailKey: 'diagGeminiSkip',
    ok: true,
    skip: true,
  };
}

function diagnoseClaudeCli() {
  if (cliOnPath('claude')) {
    return {
      id: 'claude',
      nameKey: 'diagNameClaude',
      detailKey: 'diagClaudeOk',
      ok: true,
    };
  }
  return {
    id: 'claude',
    nameKey: 'diagNameClaude',
    detailKey: 'diagClaudeMissing',
    ok: false,
  };
}

function diagnoseCodexCli() {
  if (cliOnPath('codex')) {
    return {
      id: 'codex',
      nameKey: 'diagNameCodex',
      detailKey: 'diagCodexOk',
      ok: true,
    };
  }
  return {
    id: 'codex',
    nameKey: 'diagNameCodex',
    detailKey: 'diagCodexMissing',
    ok: false,
  };
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/snapshot') {
    let health = null;
    let summary = null;
    let session = null;
    try { health = await daemonJson('GET', '/health'); } catch { /* down */ }
    try { summary = await daemonJson('GET', '/summary'); } catch { /* down */ }
    try { session = await daemonJson('GET', '/session/status'); } catch { /* down */ }
    let answers = [];
    try {
      const packed = await daemonJson('GET', '/state');
      answers = collectAnswers(packed?.state).filter((row) => !hiddenAnswerIds.has(row.id));
    } catch { /* down */ }
    answers = [...localAnswers, ...answers].filter((row) => !hiddenAnswerIds.has(row.id));
    const agents = { claude: 'idle', opus: 'idle', codex: 'idle' };
    const inProgress = session?.inProgressTasks || [];
    for (const t of inProgress) {
      const owner = String(t.owner || '').toLowerCase();
      if (agents[owner] !== undefined) agents[owner] = 'working';
    }
    if (job && !job.currentAgent) {
      const phase = currentPhaseFromEvents(parseCouncilPhaseEvents(logLines.join('\n')));
      if (phase?.agent) {
        job.currentAgent = phase.agent;
        job.currentPhase = phase.phase || '';
        job.currentRound = phase.round || job.currentRound;
      }
    }
    const liveClis = job ? await listLiveAgentClis() : [];
    if (job?.currentAgent === 'opus' && liveClis.includes('claude') && !liveClis.includes('opus')) {
      liveClis.push('opus');
    }
    const runStatus = buildRunStatus({ daemon: Boolean(health?.running), job, liveClis });
    if (job && runStatus.level === 'hanging' && !job.stopped) {
      const now = Date.now();
      if (!job.lastHangLogAt || now - job.lastHangLogAt >= 30_000) {
        job.lastHangLogAt = now;
        appendLog(`⚠ VISÍ — ${runStatus.detail}`);
      }
    }
    if (job) {
      const who = runStatus.agent;
      if (who && agents[who] !== undefined) {
        agents[who] = runStatus.level === 'hanging' ? 'hanging' : 'working';
      }
    }
    const suggestions = session?.agentSuggestions || {};
    for (const [name, info] of Object.entries(suggestions)) {
      if (info?.action === 'resolve_blocker') agents[name] = 'error';
    }
    const tasks = (summary?.summary?.openTasks || []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      owner: t.owner,
    }));
    if (job && !runStatus.agent) {
      const mark = runStatus.level === 'hanging' ? 'hanging' : 'working';
      for (const t of tasks) {
        const owner = String(t.owner || '').toLowerCase();
        if (agents[owner] === 'idle') agents[owner] = mark;
      }
    }
    const internetOk = internetCache.ok === null
      ? await getInternetOk()
      : internetCache.ok;
    if (Date.now() - internetCache.at > 20_000) {
      getInternetOk().catch(() => {});
    }
    sendJson(res, 200, {
      daemon: Boolean(health?.running),
      hydraRoot: HYDRA_ROOT,
      project: health?.project || resolveProject({ skipValidation: true }).projectName,
      projectRoot: health?.projectRoot || process.env.HYDRA_PROJECT || '',
      localGui: true,
      internetOk,
      agentsNeedInternet: true,
      models: {
        ...(health?.models || {}),
        claude: getActiveModel('claude') || health?.models?.claude,
        opus: getActiveModel('opus') || 'claude-opus-4-6',
        codex: getActiveModel('codex') || health?.models?.codex,
      },
      concierge: isConciergeAvailable() ? getConciergeModelLabel() : null,
      job: job ? {
        kind: job.kind,
        elapsedMs: Date.now() - job.startedAt,
        silentMs: Date.now() - (job.lastOutputAt || job.startedAt),
        agent: job.currentAgent,
        phase: job.currentPhase,
      } : null,
      runStatus,
      agents,
      tasks,
      answers,
      log: logLines.slice(-120),
    });
    return;
  }

  if (req.method === 'POST' && route === '/api/chat') {
    const body = await readBody(req);
    const text = String(body.prompt || '').trim();
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'Prázdný prompt' });
      return;
    }
    if (!isConciergeAvailable()) {
      sendJson(res, 400, { ok: false, error: 'Concierge nemá API klíč' });
      return;
    }
    appendLog(`Chat: ${text}`);
    try {
      initConcierge();
      setConciergeBaseUrl(DAEMON_URL);
      const result = await conciergeTurn(text, {});
      appendLog(result.response || '');
      if (result.response) {
        addLocalAnswer({
          id: `chat-${Date.now()}`,
          title: text.slice(0, 80),
          status: 'done',
          agent: 'chat',
          answer: result.response,
        });
      }
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      appendLog(`Chat error: ${err.message}`);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/run') {
    const body = await readBody(req);
    const text = String(body.prompt || '').trim();
    const mode = String(body.mode || 'auto');
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'Prázdný prompt' });
      return;
    }
    try {
      if (mode === 'council') {
        startJob('council', 'hydra-council.mjs', ['publish=true', 'emit=json', 'fresh=true'], text);
      } else {
        startJob('dispatch', 'hydra-operator.mjs', ['mode=auto', `url=${DAEMON_URL}`], text);
      }
      sendJson(res, 200, { ok: true, kind: mode === 'council' ? 'council' : 'dispatch' });
    } catch (err) {
      sendJson(res, 409, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/stop') {
    try {
      let stopped = false;
      let stoppedKind = null;
      // Stop running job (council/dispatch)
      if (job?.child) {
        stoppedKind = job.kind;
        try {
          job.stopped = true;
          killJobTree(job.child);
          appendLog(`⏹ Zastavuji běžící ${stoppedKind}…`);
          stopped = true;
        } catch (killErr) {
          appendLog(`⚠ Chyba při zastavení: ${killErr.message}`);
        }
      }
      // Cancel in-progress tasks
      const { state } = await daemonJson('GET', '/state');
      let cancelled = 0;
      for (const t of state.tasks || []) {
        if (t.status === 'in_progress' || t.status === 'todo') {
          await daemonJson('POST', '/task/update', {
            taskId: t.id,
            status: 'cancelled',
            notes: 'stopped from Hydra GUI',
          });
          cancelled++;
        }
      }
      appendLog(`✓ Zastaveno: ${stopped ? stoppedKind : 'žádný job'}, ${cancelled} úloh zrušeno`);
      sendJson(res, 200, { ok: true, stopped, cancelled });
    } catch (err) {
      appendLog(`✗ Stop error: ${err.message}`);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/clear') {
    try {
      const { state } = await daemonJson('GET', '/state');
      let cancelled = 0;
      for (const t of state.tasks || []) {
        if (!['done', 'cancelled'].includes(t.status)) {
          await daemonJson('POST', '/task/update', {
            taskId: t.id,
            status: 'cancelled',
            notes: 'cleared from Hydra GUI',
          });
          cancelled++;
        }
      }
      for (const h of state.handoffs || []) {
        if (!h.acknowledgedAt) {
          await daemonJson('POST', '/handoff/ack', {
            handoffId: h.id,
            agent: String(h.to || 'human').toLowerCase(),
          });
        }
      }
      await daemonJson('POST', '/state/archive', {});
      appendLog(`Vyčištěno: ${cancelled} úloh`);
      sendJson(res, 200, { ok: true, cancelled });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/answers/hide') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (id) hiddenAnswerIds.add(id);
    sendJson(res, 200, { ok: true, hidden: [...hiddenAnswerIds] });
    return;
  }

  if (req.method === 'POST' && route === '/api/answers/clear') {
    for (const row of localAnswers) hiddenAnswerIds.add(row.id);
    try {
      const packed = await daemonJson('GET', '/state');
      for (const row of collectAnswers(packed?.state)) {
        if (row.id) hiddenAnswerIds.add(row.id);
      }
    } catch {
      /* hide nothing extra */
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && route === '/api/answers/local') {
    const body = await readBody(req);
    const answer = String(body.answer || '').trim();
    if (!answer) {
      sendJson(res, 400, { ok: false, error: 'Prázdná odpověď' });
      return;
    }
    addLocalAnswer({
      id: `local-${Date.now()}`,
      title: String(body.title || 'Poznámka').slice(0, 120),
      status: 'done',
      agent: String(body.agent || 'system').slice(0, 40),
      answer,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && route === '/api/log/clear') {
    logLines.length = 0;
    appendLog('Log vymazán');
    savePersistedLog();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && route === '/api/diagnostics') {
    const results = [
      diagnoseClaudeCli(),
      diagnoseCodexCli(),
      await diagnoseGeminiAccount(),
    ];
    const allOk = results.filter((r) => !r.skip).every((r) => r.ok);
    sendJson(res, 200, { ok: true, allOk, results });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Unknown API route' });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${GUI_HOST}:${GUI_PORT}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const filePath = path.normalize(path.join(GUI_DIR, rel));
      if (!filePath.startsWith(GUI_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      serveFile(res, filePath);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });
}

function findAppBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

export function openWindow(pageUrl = `http://${GUI_HOST}:${GUI_PORT}/`) {
  const browser = findAppBrowser();
  if (browser) {
    // Local app window — don't wait on Edge/Chrome background online services.
    spawn(browser, [
      `--app=${pageUrl}`,
      '--new-window',
      '--window-size=1180,820',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=TranslateUI',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
    return;
  }
  spawn('cmd', ['/c', 'start', '', pageUrl], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  }).unref();
}

export async function startGui({ open = true } = {}) {
  loadPersistedLog();
  const pageUrl = `http://${GUI_HOST}:${GUI_PORT}/?v=10`;
  const ok = await ensureDaemon();
  if (!ok) appendLog('Daemon se nespustil — GUI poběží, stav bude prázdný.');
  if (isConciergeAvailable()) {
    try { initConcierge(); setConciergeBaseUrl(DAEMON_URL); } catch { /* optional */ }
  }
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(GUI_PORT, GUI_HOST, resolve);
    });
    appendLog(`GUI ${pageUrl}`);
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      appendLog('GUI už běží — otevírám okno');
    } else {
      throw err;
    }
  }
  if (open && process.env.HYDRA_GUI_NO_OPEN !== '1') openWindow(pageUrl);
  return pageUrl;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  startGui().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
