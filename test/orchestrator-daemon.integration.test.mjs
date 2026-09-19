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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-daemon-it-'));
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
        if (closeErr) {
          reject(closeErr);
          return;
        }
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
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
        : undefined,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let json = {};
        try {
          json = JSON.parse(text);
        } catch {
          json = {};
        }
        const status = res.statusCode || 0;
        resolve({
          response: {
            status,
            ok: status >= 200 && status < 300,
          },
          json,
          text,
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout: ${method} ${route}`));
    });
    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }
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
      if (response.ok) {
        return;
      }
    } catch {
      // Keep retrying until timeout.
    }
    await sleep(125);
  }
  throw new Error('Timed out waiting for daemon health check');
}

async function waitForExit(child, timeoutMs = 4_000) {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startDaemon(projectRoot) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, 'start', 'host=127.0.0.1', `port=${port}`, `project=${projectRoot}`],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );
  child.unref();

  await waitForHealth(baseUrl, child);
  return { child, baseUrl };
}

async function stopDaemon(instance) {
  if (!instance?.child) {
    return;
  }
  try {
    await requestJson(instance.baseUrl, 'POST', '/shutdown', {}, 1_500);
  } catch {
    // Fallback to force stop below.
  }
  await waitForExit(instance.child, 1_500);
  if (instance.child.exitCode === null) {
    instance.child.kill();
    await waitForExit(instance.child, 2_000);
  }
}

async function removeDirBestEffort(dirPath, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = String(error?.code || '');
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || i === attempts - 1) {
        return;
      }
      await sleep(150);
    }
  }
}

test('/task/update returns skipped verification when auto-detection finds no command', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-no-verify',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'integration no-verify task' });
  assert.equal(add.response.status, 200);
  const taskId = add.json?.task?.id;
  assert.ok(taskId);

  const update = await requestJson(daemon.baseUrl, 'POST', '/task/update', { taskId, status: 'done' });
  assert.equal(update.response.status, 200);
  assert.equal(update.json.verifying, false);
  assert.equal(update.json.verification?.enabled, false);
  assert.equal(update.json.verification?.command, null);
  assert.match(String(update.json.verification?.reason || ''), /No project-specific verification command/i);
});

test('/verify and /task/update report enabled verification when verify script is present', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-verify',
    private: true,
    type: 'module',
    scripts: {
      verify: 'node -e "process.exit(0)"',
    },
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'integration verify task' });
  assert.equal(add.response.status, 200);
  const taskId = add.json?.task?.id;
  assert.ok(taskId);

  const verify = await requestJson(daemon.baseUrl, 'POST', '/verify', { taskId });
  assert.equal(verify.response.status, 200);
  assert.equal(verify.json.verification?.enabled, true);
  assert.equal(verify.json.verification?.command, 'npm run verify');
  assert.match(String(verify.json.message || ''), /Verification started/i);

  const update = await requestJson(daemon.baseUrl, 'POST', '/task/update', { taskId, status: 'done' });
  assert.equal(update.response.status, 200);
  assert.equal(update.json.verifying, true);
  assert.equal(update.json.verification?.enabled, true);
  assert.equal(update.json.verification?.command, 'npm run verify');
});

test('GET /self returns a structured snapshot with project root and models', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-self',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const self = await requestJson(daemon.baseUrl, 'GET', '/self');
  assert.equal(self.response.status, 200);
  assert.equal(self.json?.ok, true);
  assert.ok(self.json?.self);
  assert.equal(self.json.self.project?.root, projectRoot);
  assert.ok(self.json.self.models, 'Should include model summary');
});

// ── Phase 1: Event-Sourced Mutation Log ─────────────────────────────────────

test('events have monotonic seq numbers and category fields', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-event-seq',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Create a few mutations to generate events
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'seq test task 1' });
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'seq test task 2' });
  await requestJson(daemon.baseUrl, 'POST', '/decision', { title: 'seq test decision', owner: 'human', rationale: 'test' });

  // Fetch all events
  const events = await requestJson(daemon.baseUrl, 'GET', '/events?limit=500');
  assert.equal(events.response.status, 200);
  const list = events.json.events;
  assert.ok(list.length >= 3, `Expected at least 3 events, got ${list.length}`);

  // Check seq numbers are present and monotonically increasing
  let lastSeq = -1;
  for (const evt of list) {
    if (typeof evt.seq !== 'number') continue; // skip legacy events without seq
    assert.ok(evt.seq > lastSeq, `Expected seq ${evt.seq} > ${lastSeq}`);
    lastSeq = evt.seq;
  }

  // Check category fields
  const taskEvents = list.filter((e) => e.category === 'task');
  const decisionEvents = list.filter((e) => e.category === 'decision');
  assert.ok(taskEvents.length >= 2, 'Should have at least 2 task-category events');
  assert.ok(decisionEvents.length >= 1, 'Should have at least 1 decision-category event');
});

test('/events/replay returns events from a given seq', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-replay',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'replay task 1' });
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'replay task 2' });
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'replay task 3' });

  // Get all events to find a midpoint seq
  const all = await requestJson(daemon.baseUrl, 'GET', '/events/replay?from=0');
  assert.equal(all.response.status, 200);
  assert.ok(all.json.events.length >= 3);

  // Replay from a midpoint
  const midSeq = all.json.events[Math.floor(all.json.events.length / 2)].seq;
  const partial = await requestJson(daemon.baseUrl, 'GET', `/events/replay?from=${midSeq}`);
  assert.equal(partial.response.status, 200);
  assert.ok(partial.json.events.length > 0);
  assert.ok(partial.json.events.length <= all.json.events.length);
  assert.ok(partial.json.events[0].seq >= midSeq);

  // Filter by category
  const taskOnly = await requestJson(daemon.baseUrl, 'GET', '/events/replay?from=0&category=task');
  assert.equal(taskOnly.response.status, 200);
  for (const evt of taskOnly.json.events) {
    assert.equal(evt.category, 'task');
  }
});

// ── Phase 1: Atomic Task Claiming ───────────────────────────────────────────

test('/task/claim returns claimToken and /task/update validates it', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-claim-token',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Add a task then claim it
  const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'claimable task' });
  const taskId = add.json.task.id;

  const claim = await requestJson(daemon.baseUrl, 'POST', '/task/claim', { taskId, agent: 'claude' });
  assert.equal(claim.response.status, 200);
  assert.ok(claim.json.task.claimToken, 'Claim should return a claimToken');
  const token = claim.json.task.claimToken;

  // Update with correct token should succeed
  const goodUpdate = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
    taskId,
    notes: 'progress update',
    claimToken: token,
  });
  assert.equal(goodUpdate.response.status, 200);

  // Update with wrong token should fail
  const badUpdate = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
    taskId,
    notes: 'rogue update',
    claimToken: '00000000-0000-0000-0000-000000000000',
  });
  assert.equal(badUpdate.response.status, 400);
  assert.match(String(badUpdate.json.error || ''), /claim token mismatch/i);

  // Force override should work
  const forceUpdate = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
    taskId,
    notes: 'forced update',
    claimToken: '00000000-0000-0000-0000-000000000000',
    force: true,
  });
  assert.equal(forceUpdate.response.status, 200);
});

test('/task/claim by title creates task with claimToken', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-claim-new',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const claim = await requestJson(daemon.baseUrl, 'POST', '/task/claim', {
    title: 'brand new claimed task',
    agent: 'gemini',
  });
  assert.equal(claim.response.status, 200);
  assert.ok(claim.json.task.claimToken, 'New task via claim should have a claimToken');
  assert.equal(claim.json.task.owner, 'gemini');
  assert.equal(claim.json.task.status, 'in_progress');
});

// ── Phase 2: Checkpoint/Resume ──────────────────────────────────────────────

test('POST /task/checkpoint creates and GET retrieves checkpoints', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-checkpoint',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'checkpoint test task', owner: 'claude' });
  const taskId = add.json.task.id;

  // Create first checkpoint
  const cp1 = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', {
    taskId,
    name: 'proposal_complete',
    context: 'Initial proposal drafted with 3 subtasks',
    agent: 'claude',
  });
  assert.equal(cp1.response.status, 200);
  assert.ok(cp1.json.ok);
  assert.equal(cp1.json.checkpoint.name, 'proposal_complete');
  assert.equal(cp1.json.checkpoint.agent, 'claude');
  assert.ok(cp1.json.checkpoint.savedAt);

  // Create second checkpoint
  const cp2 = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', {
    taskId,
    name: 'critique_done',
    context: 'Gemini reviewed and found 2 issues',
    agent: 'gemini',
  });
  assert.equal(cp2.response.status, 200);
  assert.equal(cp2.json.checkpoint.name, 'critique_done');

  // Retrieve checkpoints
  const list = await requestJson(daemon.baseUrl, 'GET', `/task/${taskId}/checkpoints`);
  assert.equal(list.response.status, 200);
  assert.equal(list.json.taskId, taskId);
  assert.equal(list.json.checkpoints.length, 2);
  assert.equal(list.json.checkpoints[0].name, 'proposal_complete');
  assert.equal(list.json.checkpoints[1].name, 'critique_done');
});

test('POST /task/checkpoint rejects missing taskId or name', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-checkpoint-validate',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const noTaskId = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', { name: 'test' });
  assert.equal(noTaskId.response.status, 400);

  const noName = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', { taskId: 'T001' });
  assert.equal(noName.response.status, 400);

  const badTask = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', { taskId: 'TXXX', name: 'test' });
  assert.equal(badTask.response.status, 400);
});

test('GET /task/:id/checkpoints returns 404 for missing task', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-checkpoint-404',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const result = await requestJson(daemon.baseUrl, 'GET', '/task/T999/checkpoints');
  assert.equal(result.response.status, 404);
});

// ── Phase 3: Git Worktree / MCP ─────────────────────────────────────────────

test('GET /worktrees returns worktree listing', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-worktrees',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const result = await requestJson(daemon.baseUrl, 'GET', '/worktrees');
  assert.equal(result.response.status, 200);
  assert.ok(result.json.ok);
  assert.equal(result.json.enabled, false); // disabled by default
  assert.ok(Array.isArray(result.json.worktrees));
  assert.equal(result.json.worktrees.length, 0);
});

// ── Phase 4: Session Fork/Spawn ─────────────────────────────────────────────

test('POST /session/fork creates a fork of the active session', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-session-fork',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Start a session first
  const session = await requestJson(daemon.baseUrl, 'POST', '/session/start', {
    focus: 'test fork session',
    owner: 'human',
  });
  assert.equal(session.response.status, 200);
  const parentId = session.json.session.id;

  // Fork it
  const fork = await requestJson(daemon.baseUrl, 'POST', '/session/fork', {
    reason: 'exploring alternative approach',
  });
  assert.equal(fork.response.status, 200);
  assert.ok(fork.json.session.id);
  assert.equal(fork.json.session.type, 'fork');
  assert.equal(fork.json.session.parentId, parentId);
  assert.ok(fork.json.session.contextSnapshot);

  // List sessions
  const sessions = await requestJson(daemon.baseUrl, 'GET', '/sessions');
  assert.equal(sessions.response.status, 200);
  assert.ok(sessions.json.activeSession);
  assert.ok(sessions.json.activeSession.children.length >= 1);
  assert.equal(sessions.json.childSessions.length, 1);
  assert.equal(sessions.json.childSessions[0].type, 'fork');
});

test('POST /session/spawn creates a child session with fresh focus', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-session-spawn',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Start a parent session
  await requestJson(daemon.baseUrl, 'POST', '/session/start', {
    focus: 'parent session',
    owner: 'human',
  });

  // Spawn a child
  const spawn = await requestJson(daemon.baseUrl, 'POST', '/session/spawn', {
    focus: 'investigate auth module',
    owner: 'claude',
  });
  assert.equal(spawn.response.status, 200);
  assert.ok(spawn.json.session.id);
  assert.equal(spawn.json.session.type, 'spawn');
  assert.equal(spawn.json.session.focus, 'investigate auth module');
  assert.equal(spawn.json.session.owner, 'claude');

  // Spawn another
  const spawn2 = await requestJson(daemon.baseUrl, 'POST', '/session/spawn', {
    focus: 'optimize database queries',
    owner: 'gemini',
  });
  assert.equal(spawn2.response.status, 200);

  // Verify session tree
  const sessions = await requestJson(daemon.baseUrl, 'GET', '/sessions');
  assert.equal(sessions.json.childSessions.length, 2);
  assert.ok(sessions.json.activeSession.children.length >= 2);
});

test('POST /session/fork rejects when no active session', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-fork-no-session',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const fork = await requestJson(daemon.baseUrl, 'POST', '/session/fork', {});
  assert.equal(fork.response.status, 400);
  assert.match(String(fork.json.error || ''), /no active session/i);
});

test('POST /session/spawn rejects missing focus', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-spawn-no-focus',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const spawn = await requestJson(daemon.baseUrl, 'POST', '/session/spawn', {});
  assert.equal(spawn.response.status, 400);
});

// ── Phase 5: Strict Agent Validation ────────────────────────────────────────

test('POST /handoff strict-validates agents: accepts opus, rejects local/unassigned', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-strict-agent',
    private: true,
    type: 'module',
  });
  let daemon = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Council publish flow uses strict-mode validation (allowUnassigned=false).
  // Test that opus (physical agent) is accepted in strict mode.
  const toOpus = await requestJson(daemon.baseUrl, 'POST', '/handoff', {
    from: 'claude',
    to: 'opus',
    summary: 'critique phase complete',
  });
  assert.equal(toOpus.response.status, 200, 'Handoff to opus should succeed in strict mode');
  assert.ok(toOpus.json.ok);
  assert.equal(toOpus.json.handoff.to, 'opus');

  // Verify strict mode rejects 'local'
  const toLocal = await requestJson(daemon.baseUrl, 'POST', '/handoff', {
    from: 'claude',
    to: 'local',
    summary: 'test local handoff',
  });
  assert.equal(toLocal.response.status, 400, 'Handoff to local should fail');
  assert.match(String(toLocal.json.error || ''), /unknown agent/i);

  // Verify strict mode rejects 'unassigned'
  const toUnassigned = await requestJson(daemon.baseUrl, 'POST', '/handoff', {
    from: 'claude',
    to: 'unassigned',
    summary: 'test unassigned handoff',
  });
  assert.equal(toUnassigned.response.status, 400, 'Handoff to unassigned should fail');
  assert.match(String(toUnassigned.json.error || ''), /unknown agent/i);
});
