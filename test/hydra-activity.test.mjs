import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSituationalQuery,
  annotateDispatch,
  annotateHandoff,
  annotateCompletion,
  pushActivity,
  getRecentActivity,
  clearActivityLog,
  formatDigestForPrompt,
} from '../lib/hydra-activity.mjs';

// ── detectSituationalQuery ──────────────────────────────────────────────────

test('activity: detects "what\'s going on?" as situational (all)', () => {
  const r = detectSituationalQuery("What's going on?");
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'all');
});

test('activity: detects "status update" as situational (all)', () => {
  const r = detectSituationalQuery('Give me a status update');
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'all');
});

test('activity: detects "sitrep" as situational (all)', () => {
  const r = detectSituationalQuery('sitrep');
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'all');
});

test('activity: detects agent-specific query for claude', () => {
  const r = detectSituationalQuery("What's claude working on?");
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'claude');
});

test('activity: detects agent-specific query for gemini', () => {
  const r = detectSituationalQuery("How's gemini doing?");
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'gemini');
});

test('activity: detects agent-specific query for codex', () => {
  const r = detectSituationalQuery('codex status');
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'codex');
});

test('activity: detects task-specific query', () => {
  const r = detectSituationalQuery('What tasks are open?');
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'tasks');
});

test('activity: detects handoff-specific query', () => {
  const r = detectSituationalQuery("What's that handoff about?");
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'handoffs');
});

test('activity: detects dispatch query', () => {
  const r = detectSituationalQuery("What's the last dispatch?");
  assert.equal(r.isSituational, true);
  assert.equal(r.focus, 'dispatch');
});

test('activity: non-situational prompt returns false', () => {
  const r = detectSituationalQuery('Fix the auth bug in login.js');
  assert.equal(r.isSituational, false);
  assert.equal(r.focus, null);
});

test('activity: empty/null input returns false', () => {
  assert.equal(detectSituationalQuery('').isSituational, false);
  assert.equal(detectSituationalQuery(null).isSituational, false);
  assert.equal(detectSituationalQuery(undefined).isSituational, false);
});

// ── Annotations ─────────────────────────────────────────────────────────────

test('activity: annotateDispatch produces readable narrative', () => {
  const result = annotateDispatch({
    prompt: 'Fix the auth bug',
    classification: { tier: 'simple', taskType: 'implementation', confidence: 0.85 },
    mode: 'auto',
    route: 'fast-path',
    agent: 'codex',
  });
  assert.ok(result.includes('Fix the auth bug'));
  assert.ok(result.includes('simple'));
  assert.ok(result.includes('codex'));
  assert.ok(result.includes('85%'));
});

test('activity: annotateHandoff produces readable narrative', () => {
  const result = annotateHandoff({
    from: 'claude',
    to: 'codex',
    summary: 'Implement the activity digest module',
    taskTitle: 'Create hydra-activity.mjs',
  });
  assert.ok(result.includes('claude'));
  assert.ok(result.includes('codex'));
  assert.ok(result.includes('Implement the activity'));
});

test('activity: annotateCompletion produces readable narrative', () => {
  const result = annotateCompletion({
    agent: 'codex',
    taskId: 'T005',
    title: 'Implement endpoint',
    durationMs: 47000,
    outputSummary: 'Added GET /activity',
    status: 'done',
  });
  assert.ok(result.includes('codex'));
  assert.ok(result.includes('T005'));
  assert.ok(result.includes('47s'));
  assert.ok(result.includes('completed'));
});

test('activity: annotateCompletion handles error status', () => {
  const result = annotateCompletion({
    agent: 'claude',
    taskId: 'T006',
    status: 'error',
  });
  assert.ok(result.includes('FAILED'));
});

// ── Ring Buffer ─────────────────────────────────────────────────────────────

test('activity: ring buffer push/read/clear', () => {
  clearActivityLog();
  assert.equal(getRecentActivity().length, 0);

  pushActivity('dispatch', 'Test dispatch', { mode: 'auto' });
  pushActivity('handoff', 'Test handoff', { from: 'claude', to: 'codex' });
  pushActivity('completion', 'Test completion');

  const entries = getRecentActivity();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].type, 'dispatch');
  assert.equal(entries[0].narrative, 'Test dispatch');
  assert.ok(entries[0].at);
  assert.deepEqual(entries[0].meta, { mode: 'auto' });

  assert.equal(entries[2].type, 'completion');

  // Read with limit
  assert.equal(getRecentActivity(1).length, 1);
  assert.equal(getRecentActivity(1)[0].type, 'completion');

  clearActivityLog();
  assert.equal(getRecentActivity().length, 0);
});

test('activity: ring buffer enforces max size', () => {
  clearActivityLog();
  for (let i = 0; i < 60; i++) {
    pushActivity('dispatch', `Entry ${i}`);
  }
  // Max is 50
  assert.equal(getRecentActivity(100).length, 50);
  // Oldest should be entry 10 (first 10 were evicted)
  assert.equal(getRecentActivity(100)[0].narrative, 'Entry 10');
  clearActivityLog();
});

// ── formatDigestForPrompt ───────────────────────────────────────────────────

test('activity: formatDigestForPrompt produces valid output', () => {
  const digest = {
    generatedAt: new Date().toISOString(),
    session: { status: 'active', startedAt: new Date().toISOString(), focus: 'testing' },
    agents: [
      { name: 'claude', status: 'working', action: 'Testing', taskTitle: 'Run tests', model: 'opus', phase: null, step: null, execMode: 'worker', elapsedMs: 60000, pendingHandoffs: [], worker: null, metrics: null },
      { name: 'gemini', status: 'idle', action: 'Waiting', taskTitle: null, model: 'pro', phase: null, step: null, execMode: null, elapsedMs: 0, pendingHandoffs: [], worker: null, metrics: null },
    ],
    activeTasks: [
      { id: 'T001', status: 'in_progress', owner: 'claude', title: 'Run tests', type: 'testing', blockedBy: [] },
    ],
    recentCompletions: [
      { id: 'T000', owner: 'codex', title: 'Setup', durationMs: 30000 },
    ],
    pendingHandoffs: [],
    recentHandoffs: [
      { id: 'H001', from: 'human', to: 'claude', summary: 'Run the test suite', acknowledged: true },
    ],
    recentDecisions: [],
    lastDispatch: { type: 'dispatch', narrative: 'Dispatched "run tests" - simple/testing to claude', at: new Date().toISOString() },
    activityLog: [
      { at: new Date().toISOString(), type: 'dispatch', narrative: 'Dispatched run tests' },
    ],
    counts: null,
    metrics: { totalCalls: 5, totalTokens: 50000, totalCost: 0.42 },
  };

  const output = formatDigestForPrompt(digest);
  assert.ok(output.startsWith('=== ACTIVITY DIGEST ==='));
  assert.ok(output.endsWith('=== END DIGEST ==='));
  assert.ok(output.includes('claude [working]'));
  assert.ok(output.includes('T001'));
  assert.ok(output.includes('LAST DISPATCH'));
  assert.ok(output.includes('5 calls'));
});

test('activity: formatDigestForPrompt respects maxChars', () => {
  const digest = {
    agents: [],
    activeTasks: [],
    recentCompletions: [],
    pendingHandoffs: [],
    recentHandoffs: [],
    recentDecisions: [],
    lastDispatch: null,
    activityLog: [],
    metrics: {},
  };
  const output = formatDigestForPrompt(digest, { maxChars: 100 });
  assert.ok(output.length <= 120); // some margin for truncation footer
});

test('activity: formatDigestForPrompt respects focus filter', () => {
  const digest = {
    agents: [
      { name: 'claude', status: 'working', action: 'Testing', taskTitle: 'Fix bug', model: null, phase: null, step: null, execMode: null, elapsedMs: 0, pendingHandoffs: [] },
      { name: 'gemini', status: 'idle', action: '', taskTitle: null, model: null, phase: null, step: null, execMode: null, elapsedMs: 0, pendingHandoffs: [] },
    ],
    activeTasks: [
      { id: 'T001', status: 'in_progress', owner: 'claude', title: 'Fix bug', blockedBy: [] },
      { id: 'T002', status: 'todo', owner: 'gemini', title: 'Review', blockedBy: [] },
    ],
    recentCompletions: [],
    pendingHandoffs: [],
    recentHandoffs: [],
    recentDecisions: [],
    lastDispatch: null,
    activityLog: [],
    metrics: {},
  };

  const focused = formatDigestForPrompt(digest, { focus: 'claude' });
  assert.ok(focused.includes('claude [working]'));
  // Gemini agent line should not appear when focus is 'claude'
  assert.ok(!focused.includes('gemini [idle]'));
});
