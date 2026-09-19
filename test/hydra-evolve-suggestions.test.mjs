import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadSuggestions,
  saveSuggestions,
  addSuggestion,
  updateSuggestion,
  removeSuggestion,
  getPendingSuggestions,
  getSuggestionById,
  searchSuggestions,
  createSuggestionFromRound,
  getSuggestionStats,
  formatSuggestionsForPrompt,
} from '../lib/hydra-evolve-suggestions.mjs';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sug-test-'));
}

function emptySuggestions() {
  return { version: 1, entries: [], stats: {} };
}

// ── loadSuggestions ─────────────────────────────────────────────────────────

test('loadSuggestions returns empty object for missing file', () => {
  const dir = tmpDir();
  const sg = loadSuggestions(dir);
  assert.equal(sg.version, 1);
  assert.deepEqual(sg.entries, []);
  assert.equal(sg.stats.totalPending, 0);
  fs.rmSync(dir, { recursive: true });
});

test('loadSuggestions returns empty object for invalid JSON', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'SUGGESTIONS.json'), 'not json', 'utf8');
  const sg = loadSuggestions(dir);
  assert.deepEqual(sg.entries, []);
  fs.rmSync(dir, { recursive: true });
});

test('loadSuggestions returns empty for missing entries array', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'SUGGESTIONS.json'), '{"version":1}', 'utf8');
  const sg = loadSuggestions(dir);
  assert.deepEqual(sg.entries, []);
  fs.rmSync(dir, { recursive: true });
});

test('loadSuggestions reads valid file', () => {
  const dir = tmpDir();
  const data = {
    version: 1,
    entries: [{ id: 'SUG_001', title: 'Test', status: 'pending' }],
    stats: {},
  };
  fs.writeFileSync(path.join(dir, 'SUGGESTIONS.json'), JSON.stringify(data), 'utf8');
  const sg = loadSuggestions(dir);
  assert.equal(sg.entries.length, 1);
  assert.equal(sg.entries[0].id, 'SUG_001');
  fs.rmSync(dir, { recursive: true });
});

// ── saveSuggestions ─────────────────────────────────────────────────────────

test('saveSuggestions writes file and computes stats', () => {
  const dir = tmpDir();
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'One', description: 'First suggestion', area: 'testing' });
  addSuggestion(sg, { title: 'Two', description: 'Second suggestion', area: 'tools' });
  saveSuggestions(dir, sg);

  const raw = fs.readFileSync(path.join(dir, 'SUGGESTIONS.json'), 'utf8');
  const loaded = JSON.parse(raw);
  assert.equal(loaded.entries.length, 2);
  assert.equal(loaded.stats.totalPending, 2);
  fs.rmSync(dir, { recursive: true });
});

// ── addSuggestion ───────────────────────────────────────────────────────────

test('addSuggestion generates sequential IDs', () => {
  const sg = emptySuggestions();
  const a = addSuggestion(sg, { title: 'First', description: 'A' });
  const b = addSuggestion(sg, { title: 'Second', description: 'B' });
  assert.equal(a.id, 'SUG_001');
  assert.equal(b.id, 'SUG_002');
});

test('addSuggestion sets default fields', () => {
  const sg = emptySuggestions();
  const entry = addSuggestion(sg, { title: 'Test' });
  assert.equal(entry.status, 'pending');
  assert.equal(entry.source, 'user:manual');
  assert.equal(entry.priority, 'medium');
  assert.equal(entry.attempts, 0);
  assert.equal(entry.maxAttempts, 3);
  assert.equal(entry.area, 'general');
  assert.equal(entry.specPath, null);
  assert.equal(entry.lastAttemptDate, null);
});

test('addSuggestion deduplicates similar titles', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, {
    title: 'Implement a lightweight repository map generator for token-budgeted summaries',
    description: 'Build a repo map with regex parsing',
  });
  const dupe = addSuggestion(sg, {
    title: 'Implement a lightweight repository map generator that produces token-budgeted summaries',
    description: 'Build a repo map with regex parsing and Node APIs',
  });
  assert.equal(dupe, null);
  assert.equal(sg.entries.length, 1);
});

test('addSuggestion allows sufficiently different entries', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'Judge critic quality gate', description: 'Add verifier phase' });
  const different = addSuggestion(sg, { title: 'Mock agent test layer', description: 'Build test fixtures' });
  assert.notEqual(different, null);
  assert.equal(sg.entries.length, 2);
});

test('addSuggestion ignores abandoned entries during dedup', () => {
  const sg = emptySuggestions();
  const first = addSuggestion(sg, {
    title: 'Implement repository map generator for token-budgeted summaries',
    description: 'Same long description about repo maps',
  });
  removeSuggestion(sg, first.id);
  const retry = addSuggestion(sg, {
    title: 'Implement repository map generator for token-budgeted summaries',
    description: 'Same long description about repo maps',
  });
  assert.notEqual(retry, null);
  assert.equal(sg.entries.length, 2);
});

// ── updateSuggestion ────────────────────────────────────────────────────────

test('updateSuggestion merges fields', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'Test' });
  const updated = updateSuggestion(sg, 'SUG_001', { status: 'exploring', attempts: 1 });
  assert.equal(updated.status, 'exploring');
  assert.equal(updated.attempts, 1);
  assert.equal(updated.title, 'Test');
});

test('updateSuggestion returns null for missing ID', () => {
  const sg = emptySuggestions();
  assert.equal(updateSuggestion(sg, 'SUG_999', { status: 'exploring' }), null);
});

// ── removeSuggestion ────────────────────────────────────────────────────────

test('removeSuggestion sets status to abandoned', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'Doomed' });
  removeSuggestion(sg, 'SUG_001');
  assert.equal(sg.entries[0].status, 'abandoned');
});

// ── getPendingSuggestions ────────────────────────────────────────────────────

test('getPendingSuggestions filters by status', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'Pending one', description: 'A' });
  addSuggestion(sg, { title: 'Pending two', description: 'B' });
  addSuggestion(sg, { title: 'Exploring', description: 'C' });
  updateSuggestion(sg, 'SUG_003', { status: 'exploring' });

  const pending = getPendingSuggestions(sg);
  assert.equal(pending.length, 2);
  assert.ok(pending.every(e => e.status === 'pending'));
});

test('getPendingSuggestions sorts by priority then date', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'Low', description: 'low priority task', priority: 'low', createdAt: '2026-02-01' });
  addSuggestion(sg, { title: 'High', description: 'high priority task', priority: 'high', createdAt: '2026-02-03' });
  addSuggestion(sg, { title: 'Medium', description: 'medium priority task', priority: 'medium', createdAt: '2026-02-02' });

  const pending = getPendingSuggestions(sg);
  assert.equal(pending[0].priority, 'high');
  assert.equal(pending[1].priority, 'medium');
  assert.equal(pending[2].priority, 'low');
});

// ── getSuggestionById ───────────────────────────────────────────────────────

test('getSuggestionById finds entry', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'Find me' });
  const found = getSuggestionById(sg, 'SUG_001');
  assert.equal(found.title, 'Find me');
});

test('getSuggestionById returns null for missing ID', () => {
  const sg = emptySuggestions();
  assert.equal(getSuggestionById(sg, 'SUG_999'), null);
});

// ── searchSuggestions ───────────────────────────────────────────────────────

test('searchSuggestions filters by text query', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'Repo map generator', description: 'Build a map', area: 'ai-coding-tools' });
  addSuggestion(sg, { title: 'Mock agent layer', description: 'Test fixtures', area: 'testing-reliability' });

  const results = searchSuggestions(sg, 'repo map');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Repo map generator');
});

test('searchSuggestions filters by status opt', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'One', description: 'A' });
  addSuggestion(sg, { title: 'Two', description: 'B' });
  updateSuggestion(sg, 'SUG_002', { status: 'completed' });

  const results = searchSuggestions(sg, null, { status: 'pending' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'SUG_001');
});

test('searchSuggestions filters by area opt', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'A', description: 'a', area: 'testing-reliability' });
  addSuggestion(sg, { title: 'B', description: 'b', area: 'ai-coding-tools' });

  const results = searchSuggestions(sg, null, { area: 'testing-reliability' });
  assert.equal(results.length, 1);
  assert.equal(results[0].area, 'testing-reliability');
});

// ── createSuggestionFromRound ───────────────────────────────────────────────

test('createSuggestionFromRound creates suggestion from rejected round', () => {
  const sg = emptySuggestions();
  const roundResult = {
    round: 2,
    area: 'ai-coding-tools',
    verdict: 'reject',
    score: 1,
    investigations: {
      diagnoses: [{ diagnosis: 'transient', explanation: 'codex timed out' }],
    },
  };
  const deliberation = {
    selectedImprovement: 'Implement a lightweight repository map generator that produces token-budgeted codebase summaries',
  };

  const created = createSuggestionFromRound(sg, roundResult, deliberation, {
    sessionId: 'evolve_2026-02-09_abc',
    specPath: 'docs/coordination/evolve/specs/ROUND_2_SPEC.md',
    notes: 'Codex timed out',
  });

  assert.notEqual(created, null);
  assert.equal(created.source, 'auto:rejected-round');
  assert.equal(created.area, 'ai-coding-tools');
  assert.equal(created.priority, 'high'); // transient failures get high priority
  assert.equal(created.specPath, 'docs/coordination/evolve/specs/ROUND_2_SPEC.md');
  assert.ok(created.sourceRef.includes('evolve_2026-02-09_abc'));
});

test('createSuggestionFromRound returns null for empty improvement', () => {
  const sg = emptySuggestions();
  const result = createSuggestionFromRound(sg, { round: 1, area: 'test', verdict: 'reject', score: 0 }, {
    selectedImprovement: 'No improvement selected',
  });
  assert.equal(result, null);
});

test('createSuggestionFromRound returns null for short improvement', () => {
  const sg = emptySuggestions();
  const result = createSuggestionFromRound(sg, { round: 1, area: 'test', verdict: 'reject', score: 0 }, {
    selectedImprovement: 'short',
  });
  assert.equal(result, null);
});

test('createSuggestionFromRound deduplicates', () => {
  const sg = emptySuggestions();
  const delib = { selectedImprovement: 'Implement a lightweight repository map generator that produces token-budgeted summaries' };
  const round = { round: 1, area: 'ai-coding-tools', verdict: 'reject', score: 1 };

  createSuggestionFromRound(sg, round, delib);
  const dupe = createSuggestionFromRound(sg, round, delib);
  assert.equal(dupe, null);
  assert.equal(sg.entries.length, 1);
});

test('createSuggestionFromRound sets deferred source for skipped rounds', () => {
  const sg = emptySuggestions();
  const created = createSuggestionFromRound(sg, {
    round: 1, area: 'testing', verdict: 'skipped', score: 0,
  }, {
    selectedImprovement: 'Build a mock agent layer for deterministic testing of dispatch pipeline',
  }, {
    source: 'auto:deferred',
  });
  assert.equal(created.source, 'auto:deferred');
});

// ── getSuggestionStats ──────────────────────────────────────────────────────

test('getSuggestionStats computes correct counts', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'A', description: 'a' });
  addSuggestion(sg, { title: 'B', description: 'b' });
  addSuggestion(sg, { title: 'C', description: 'c' });
  updateSuggestion(sg, 'SUG_002', { status: 'completed' });
  updateSuggestion(sg, 'SUG_003', { status: 'abandoned' });

  const stats = getSuggestionStats(sg);
  assert.equal(stats.totalPending, 1);
  assert.equal(stats.totalCompleted, 1);
  assert.equal(stats.totalAbandoned, 1);
});

// ── formatSuggestionsForPrompt ──────────────────────────────────────────────

test('formatSuggestionsForPrompt returns summary string', () => {
  const sg = emptySuggestions();
  addSuggestion(sg, { title: 'A', description: 'a' });
  addSuggestion(sg, { title: 'B', description: 'b' });
  updateSuggestion(sg, 'SUG_002', { status: 'rejected' });

  const text = formatSuggestionsForPrompt(sg);
  assert.ok(text.includes('1 pending'));
  assert.ok(text.includes('1 rejected'));
});

// ── Round-trip persistence ──────────────────────────────────────────────────

test('round-trip: save and reload preserves data', () => {
  const dir = tmpDir();
  const sg = emptySuggestions();
  addSuggestion(sg, {
    title: 'Judge quality gate',
    description: 'Add verifier phase to task lifecycle',
    area: 'orchestration-patterns',
    priority: 'high',
    tags: ['orchestration', 'retry'],
  });
  saveSuggestions(dir, sg);

  const loaded = loadSuggestions(dir);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].title, 'Judge quality gate');
  assert.equal(loaded.entries[0].priority, 'high');
  assert.equal(loaded.stats.totalPending, 1);
  fs.rmSync(dir, { recursive: true });
});
