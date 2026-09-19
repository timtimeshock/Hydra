/**
 * Extended Daemon Integration Tests
 *
 * Tests for new endpoints: /session/status, /tasks/stale, /stats,
 * /session/pause, /session/resume, /state/archive, /shutdown,
 * and the claim_owned_task flow.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(REPO_ROOT, 'lib', 'orchestrator-daemon.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempProject(packageJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-daemon-ext-'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  return root;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((closeErr) => {
        if (closeErr) { reject(closeErr); return; }
        resolve(port);
      });
    });
  });
}

async function requestJson(baseUrl, method, route, body = null, timeoutMs = 4_000) {
  const target = new URL(route, baseUrl);
  const payload = body ? JSON.stringify(body) : '';

  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : undefined,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch { json = {}; }
        const status = res.statusCode || 0;
        resolve({ response: { status, ok: status >= 200 && status < 300 }, json, text });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Request timeout: ${method} ${route}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(baseUrl, child, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before becoming healthy (exit=${child.exitCode})`);
    }
    try {
      const { response } = await requestJson(baseUrl, 'GET', '/health');
      if (response.ok) return;
    } catch { /* retry */ }
    await sleep(125);
  }
  throw new Error('Timed out waiting for daemon health check');
}

async function waitForExit(child, timeoutMs = 4_000) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function startDaemon(projectRoot) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, 'start', 'host=127.0.0.1', `port=${port}`, `project=${projectRoot}`],
    { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'ignore'] }
  );
  child.unref();
  await waitForHealth(baseUrl, child);
  return { child, baseUrl };
}

async function stopDaemon(instance) {
  if (!instance?.child) return;
  try {
    await requestJson(instance.baseUrl, 'POST', '/shutdown', {}, 1_500);
  } catch { /* fallback */ }
  await waitForExit(instance.child, 1_500);
  if (instance.child.exitCode === null) {
    instance.child.kill();
    await waitForExit(instance.child, 2_000);
  }
}

async function removeDirBestEffort(dirPath, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dirPath, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(String(error?.code || '')) || i === attempts - 1) return;
      await sleep(150);
    }
  }
}

// ── GET /session/status ──────────────────────────────────────────────────────

test('GET /session/status returns session health data', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-session-status', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Start a session first
  await requestJson(daemon.baseUrl, 'POST', '/session/start', {
    focus: 'Test session status endpoint',
    owner: 'human',
  });

  // Add a task so there's data
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'Status check task', owner: 'claude' });

  const result = await requestJson(daemon.baseUrl, 'GET', '/session/status');
  assert.equal(result.response.status, 200);
  assert.ok(result.json.ok);
  assert.ok(result.json.activeSession, 'Should have activeSession');
  assert.equal(result.json.activeSession.focus, 'Test session status endpoint');
  assert.ok(Array.isArray(result.json.staleTasks));
  assert.ok(Array.isArray(result.json.inProgressTasks));
  assert.ok(Array.isArray(result.json.pendingHandoffs));
  assert.ok(result.json.agentSuggestions);
  assert.ok(result.json.agentSuggestions.claude);
  assert.ok(result.json.agentSuggestions.gemini);
  assert.ok(result.json.agentSuggestions.codex);
});

// ── GET /tasks/stale ─────────────────────────────────────────────────────────

test('GET /tasks/stale returns stale task list', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-stale', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Fresh tasks should not be stale
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'Fresh task', owner: 'claude' });

  const result = await requestJson(daemon.baseUrl, 'GET', '/tasks/stale');
  assert.equal(result.response.status, 200);
  assert.ok(result.json.ok);
  assert.ok(Array.isArray(result.json.tasks));
  assert.equal(result.json.tasks.length, 0, 'Fresh tasks should not be stale');
});

// ── GET /stats ───────────────────────────────────────────────────────────────

test('GET /stats returns metrics and usage data', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-stats', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  const result = await requestJson(daemon.baseUrl, 'GET', '/stats');
  assert.equal(result.response.status, 200);
  assert.ok(result.json.ok);
  assert.ok(result.json.metrics, 'Should include metrics');
  assert.ok(result.json.metrics.startedAt);
  assert.ok(typeof result.json.metrics.totalCalls === 'number');
});

// ── POST /session/pause and /session/resume ──────────────────────────────────

test('POST /session/pause and /session/resume lifecycle', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-pause', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Start a session
  await requestJson(daemon.baseUrl, 'POST', '/session/start', {
    focus: 'Pause/resume test',
    owner: 'human',
  });

  // Pause the session
  const pause = await requestJson(daemon.baseUrl, 'POST', '/session/pause', {
    reason: 'lunch break',
  });
  assert.equal(pause.response.status, 200);
  assert.ok(pause.json.ok);

  // Verify session is paused via pause response
  assert.ok(pause.json.session || pause.json.ok, 'Pause should return session or ok');

  const stateAfterPause = await requestJson(daemon.baseUrl, 'GET', '/state');
  assert.equal(stateAfterPause.json.state?.activeSession?.status, 'paused');

  // Resume the session
  const resume = await requestJson(daemon.baseUrl, 'POST', '/session/resume', {});
  assert.equal(resume.response.status, 200);
  assert.ok(resume.json.ok);

  // Verify session is active again
  const stateAfterResume = await requestJson(daemon.baseUrl, 'GET', '/state');
  assert.equal(stateAfterResume.json.state?.activeSession?.status, 'active');
});

test('POST /session/pause fails without active session', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-pause-nosess', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Pause without starting a session
  const pause = await requestJson(daemon.baseUrl, 'POST', '/session/pause', {});
  assert.ok(!pause.response.ok || !pause.json.ok, 'Should fail without active session');
});

// ── POST /state/archive ──────────────────────────────────────────────────────

test('POST /state/archive archives completed tasks', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-archive', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Add and complete a task
  const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'Archive me' });
  const taskId = add.json?.task?.id;
  await requestJson(daemon.baseUrl, 'POST', '/task/update', { taskId, status: 'done' });

  // Archive
  const archive = await requestJson(daemon.baseUrl, 'POST', '/state/archive', {});
  assert.equal(archive.response.status, 200);
  assert.ok(archive.json.ok);
});

// ── claim_owned_task flow ────────────────────────────────────────────────────

test('claim_owned_task: agent claims their own task via /next + /task/claim', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-claim-owned', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Add a task owned by claude
  const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', {
    title: 'Owned task for claude',
    owner: 'claude',
  });
  const taskId = add.json?.task?.id;
  assert.ok(taskId);

  // Check what claude should do next
  const next = await requestJson(daemon.baseUrl, 'GET', `/next?agent=claude`);
  assert.equal(next.response.status, 200);
  const action = next.json?.next?.action;
  // Should suggest claiming this task
  assert.ok(
    ['claim_owned_task', 'claim_unassigned_task', 'continue_task'].includes(action),
    `Expected claim action, got: ${action}`
  );

  // Claim the task
  const claim = await requestJson(daemon.baseUrl, 'POST', '/task/claim', {
    agent: 'claude',
    taskId,
  });
  assert.equal(claim.response.status, 200);
  assert.ok(claim.json.ok);
  assert.ok(claim.json.claimToken || claim.json.task?.claimToken, 'Should return a claim token');

  // Verify task is now in_progress
  const state = await requestJson(daemon.baseUrl, 'GET', '/state');
  const task = state.json.state?.tasks?.find((t) => t.id === taskId);
  assert.ok(task);
  assert.equal(task.status, 'in_progress');
});

// ── POST /shutdown ───────────────────────────────────────────────────────────

test('POST /shutdown gracefully stops the daemon', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-shutdown', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => {
    // Daemon should already be stopped, but clean up just in case
    if (daemon?.child?.exitCode === null) {
      daemon.child.kill();
      await waitForExit(daemon.child, 2_000);
    }
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Shutdown
  const result = await requestJson(daemon.baseUrl, 'POST', '/shutdown', {});
  assert.equal(result.response.status, 200);
  assert.ok(result.json.ok);

  // Wait for process to exit
  await waitForExit(daemon.child, 5_000);
  assert.ok(daemon.child.exitCode !== null, 'Daemon should have exited');
});

// ── GET /health ──────────────────────────────────────────────────────────────

test('GET /health returns daemon status', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-health', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  const result = await requestJson(daemon.baseUrl, 'GET', '/health');
  assert.equal(result.response.status, 200);
  assert.ok(result.json.ok);
  assert.ok(result.json.status || result.json.ok, 'Health should return status or ok');
});

// ── Handoff + ack flow ───────────────────────────────────────────────────────

test('handoff lifecycle: create, appear in /next, ack', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-handoff', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Create a handoff
  const handoff = await requestJson(daemon.baseUrl, 'POST', '/handoff', {
    from: 'claude',
    to: 'gemini',
    summary: 'Review the auth changes',
    nextStep: 'Check for security issues',
  });
  assert.equal(handoff.response.status, 200);
  assert.ok(handoff.json.ok);
  const handoffId = handoff.json.handoff?.id;
  assert.ok(handoffId);

  // Gemini should see the handoff in /next
  const next = await requestJson(daemon.baseUrl, 'GET', '/next?agent=gemini');
  assert.equal(next.json?.next?.action, 'pickup_handoff');
  assert.equal(next.json?.next?.handoff?.id, handoffId);

  // Ack the handoff
  const ack = await requestJson(daemon.baseUrl, 'POST', '/handoff/ack', {
    handoffId,
    agent: 'gemini',
  });
  assert.equal(ack.response.status, 200);
  assert.ok(ack.json.ok);

  // After ack, gemini should no longer see the handoff
  const nextAfter = await requestJson(daemon.baseUrl, 'GET', '/next?agent=gemini');
  assert.notEqual(nextAfter.json?.next?.action, 'pickup_handoff');
});

test('strict handoff validation accepts opus and rejects local and unassigned', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-opus-handoff', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  const opus = await requestJson(daemon.baseUrl, 'POST', '/handoff', {
    from: 'claude', to: 'opus', summary: 'Council critique is ready',
  });
  assert.equal(opus.response.status, 200);
  assert.equal(opus.json.ok, true);

  for (const disallowed of ['local', 'unassigned']) {
    const result = await requestJson(daemon.baseUrl, 'POST', '/handoff', {
      from: 'claude', to: disallowed, summary: 'Must be rejected in strict mode',
    });
    assert.equal(result.response.status, 400, `${disallowed} must be rejected`);
    assert.match(String(result.json.error || ''), new RegExp(`Unknown agent "${disallowed}"`));
  }
});

// ── Session fork creates sibling ─────────────────────────────────────────────

test('session fork + spawn + list lifecycle', { timeout: 30_000 }, async (t) => {
  const projectRoot = createTempProject({ name: 'hydra-ext-fork-spawn', private: true, type: 'module' });
  let daemon = null;
  t.after(async () => { await stopDaemon(daemon); await removeDirBestEffort(projectRoot); });
  daemon = await startDaemon(projectRoot);

  // Start a session
  await requestJson(daemon.baseUrl, 'POST', '/session/start', {
    focus: 'Main session',
    owner: 'human',
  });

  // Fork
  const fork = await requestJson(daemon.baseUrl, 'POST', '/session/fork', {});
  assert.equal(fork.response.status, 200);
  assert.ok(fork.json.ok);
  assert.ok(fork.json.session?.id);
  assert.equal(fork.json.session?.type, 'fork');

  // Spawn
  const sp = await requestJson(daemon.baseUrl, 'POST', '/session/spawn', { focus: 'Subtask A' });
  assert.equal(sp.response.status, 200);
  assert.ok(sp.json.ok);
  assert.equal(sp.json.session?.type, 'spawn');
  assert.equal(sp.json.session?.focus, 'Subtask A');

  // List sessions
  const list = await requestJson(daemon.baseUrl, 'GET', '/sessions');
  assert.equal(list.response.status, 200);
  assert.ok(Array.isArray(list.json.childSessions), 'Should have childSessions array');
  assert.ok(list.json.childSessions.length >= 2, 'Should have at least fork + spawn');
});
