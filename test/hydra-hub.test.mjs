import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Use a temp dir so tests never touch the real hub
const TEMP_HUB = path.join(os.tmpdir(), `hydra-hub-test-${process.pid}`);

// Patch the module to use our temp dir by setting the env var before import
process.env.HYDRA_HUB_OVERRIDE = TEMP_HUB;

const {
  hubPath,
  registerSession,
  updateSession,
  deregisterSession,
  listSessions,
  checkConflicts,
  logActivity,
} = await import('../lib/hydra-hub.mjs');

test.after(() => {
  fs.rmSync(TEMP_HUB, { recursive: true, force: true });
  delete process.env.HYDRA_HUB_OVERRIDE;
});

test('hubPath returns a string', () => {
  assert.ok(typeof hubPath() === 'string');
});

test('registerSession writes a sess_*.json file and returns an id', () => {
  const id = registerSession({ agent: 'claude-code', cwd: '/e/Dev/Test', project: 'Test', focus: 'testing' });
  assert.ok(typeof id === 'string' && id.length > 0);
  const files = fs.readdirSync(TEMP_HUB).filter(f => f.startsWith('sess_'));
  assert.ok(files.length >= 1);
});

test('listSessions returns registered session', () => {
  const id = registerSession({ agent: 'claude-code', cwd: '/e/Dev/ListTest', project: 'ListTest', focus: 'list test' });
  const sessions = listSessions({ cwd: '/e/Dev/ListTest' });
  assert.ok(sessions.some(s => s.id === id));
});

test('listSessions normalizes cwd: Windows and Unix paths match', () => {
  registerSession({ agent: 'hydra-tasks', cwd: 'E:\\Dev\\NormTest', project: 'NormTest', focus: 'norm test' });
  const sessions = listSessions({ cwd: '/e/Dev/NormTest' }); // Unix-style
  assert.ok(sessions.some(s => s.project === 'NormTest'));
});

test('updateSession patches fields and touches lastUpdate', async () => {
  const id = registerSession({ agent: 'codex-forge', cwd: '/e/Dev/UpdTest', project: 'UpdTest', focus: 'update test' });
  const before = listSessions({ cwd: '/e/Dev/UpdTest' }).find(s => s.id === id).startedAt;
  await new Promise(r => setTimeout(r, 10));
  updateSession(id, { focus: 'updated focus', files: ['src/foo.ts'] });
  const sessions = listSessions({ cwd: '/e/Dev/UpdTest' });
  const s = sessions.find(s => s.id === id);
  assert.equal(s.focus, 'updated focus');
  assert.deepEqual(s.files, ['src/foo.ts']);
  assert.ok(s.lastUpdate > before, 'lastUpdate must be strictly after startedAt');
});

test('deregisterSession removes the file', () => {
  const id = registerSession({ agent: 'gemini-forge', cwd: '/e/Dev/DelTest', project: 'DelTest', focus: 'delete test' });
  deregisterSession(id);
  const sessions = listSessions({ cwd: '/e/Dev/DelTest' });
  assert.ok(!sessions.some(s => s.id === id));
});

test('checkConflicts detects file overlap in same project', () => {
  const id = registerSession({
    agent: 'claude-code', cwd: '/e/Dev/ConflictTest', project: 'ConflictTest',
    focus: 'conflict test', files: ['src/api/auth.ts'],
  });
  const conflicts = checkConflicts(['src/api/auth.ts'], { cwd: '/e/Dev/ConflictTest' });
  assert.ok(conflicts.length >= 1);
  assert.equal(conflicts[0].file, 'src/api/auth.ts');
  deregisterSession(id);
});

test('checkConflicts returns empty when no overlap', () => {
  registerSession({
    agent: 'claude-code', cwd: '/e/Dev/NoConflictTest', project: 'NoConflictTest',
    focus: 'no conflict', files: ['src/api/auth.ts'],
  });
  const conflicts = checkConflicts(['src/unrelated.ts'], { cwd: '/e/Dev/NoConflictTest' });
  assert.equal(conflicts.length, 0);
});

test('checkConflicts excludes own session', () => {
  const id = registerSession({
    agent: 'claude-code', cwd: '/e/Dev/ExcludeTest', project: 'ExcludeTest',
    focus: 'exclude test', files: ['src/api/auth.ts'],
  });
  const conflicts = checkConflicts(['src/api/auth.ts'], { cwd: '/e/Dev/ExcludeTest', excludeId: id });
  assert.equal(conflicts.length, 0);
});

test('listSessions does not filter when no cwd given', () => {
  const id = registerSession({ agent: 'claude-code', cwd: '/e/Dev/AllTest', project: 'AllTest', focus: 'all' });
  const all = listSessions();
  assert.ok(all.some(s => s.id === id));
});

test('logActivity appends a valid JSON line to activity.ndjson', () => {
  logActivity({ event: 'test', session: 'test-sess', agent: 'claude-code', project: 'TestProject' });
  const activityPath = path.join(TEMP_HUB, 'activity.ndjson');
  assert.ok(fs.existsSync(activityPath), 'activity.ndjson should exist');
  const lines = fs.readFileSync(activityPath, 'utf8').trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.event, 'test');
  assert.equal(last.agent, 'claude-code');
  assert.ok(last.at, 'should have at timestamp');
});

test('logActivity does not throw on invalid input', () => {
  // Should silently swallow — no assertion needed beyond not throwing
  assert.doesNotThrow(() => logActivity(null));
  assert.doesNotThrow(() => logActivity(undefined));
  assert.doesNotThrow(() => logActivity({ circular: undefined }));
});
