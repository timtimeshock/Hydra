import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCodebaseQuery,
  loadCodebaseContext,
  getTopicContext,
  getBaselineContext,
  searchKnowledgeBase,
  getConfigReference,
} from '../lib/hydra-codebase-context.mjs';

// ── detectCodebaseQuery ─────────────────────────────────────────────────────

test('codebase: detects "how does dispatch work?" -> dispatch topic', () => {
  const r = detectCodebaseQuery('How does dispatch work?');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'dispatch');
});

test('codebase: detects "how does the council work?" -> council topic', () => {
  const r = detectCodebaseQuery('How does the council work?');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'council');
});

test('codebase: detects "what module handles workers?" -> workers topic', () => {
  const r = detectCodebaseQuery('What module handles workers?');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'workers');
});

test('codebase: detects "show me the architecture" -> modules topic', () => {
  const r = detectCodebaseQuery('Show me the architecture');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'modules');
});

test('codebase: detects "what config options exist?" -> config topic', () => {
  const r = detectCodebaseQuery('What config options exist for workers?');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'config');
});

test('codebase: detects "explain the concierge system" -> concierge topic', () => {
  const r = detectCodebaseQuery('Explain the concierge system');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'concierge');
});

test('codebase: detects "where is routing implemented?" -> dispatch topic', () => {
  const r = detectCodebaseQuery('Where is routing implemented?');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'dispatch');
});

test('codebase: detects "tell me about the evolve pipeline" -> evolve topic', () => {
  const r = detectCodebaseQuery('Tell me about the evolve pipeline');
  assert.equal(r.isCodebaseQuery, true);
  assert.equal(r.topic, 'evolve');
});

test('codebase: non-codebase prompts return false', () => {
  assert.equal(detectCodebaseQuery('Fix the auth bug').isCodebaseQuery, false);
  assert.equal(detectCodebaseQuery('Add dark mode').isCodebaseQuery, false);
  assert.equal(detectCodebaseQuery('hello').isCodebaseQuery, false);
});

test('codebase: empty/null input returns false', () => {
  assert.equal(detectCodebaseQuery('').isCodebaseQuery, false);
  assert.equal(detectCodebaseQuery(null).isCodebaseQuery, false);
  assert.equal(detectCodebaseQuery(undefined).isCodebaseQuery, false);
});

test('codebase: short input returns false', () => {
  assert.equal(detectCodebaseQuery('hi').isCodebaseQuery, false);
});

// ── loadCodebaseContext ─────────────────────────────────────────────────────

test('codebase: loadCodebaseContext returns sections and module index', () => {
  const ctx = loadCodebaseContext();
  assert.ok(ctx.sections, 'Should have sections');
  assert.ok(ctx.moduleIndex, 'Should have module index');
  assert.ok(Array.isArray(ctx.moduleIndex));
  assert.ok(ctx.moduleIndex.length > 0, 'Module index should have entries');
  assert.ok(ctx.loadedAt > 0);

  // Should have parsed at least some CLAUDE.md sections
  const keys = Object.keys(ctx.sections);
  assert.ok(keys.length > 0, 'Should have parsed CLAUDE.md sections');
});

test('codebase: module index includes key modules', () => {
  const ctx = loadCodebaseContext();
  const files = ctx.moduleIndex.map((m) => m.file);
  assert.ok(files.some((f) => f.includes('hydra-operator')), 'Should include hydra-operator');
  assert.ok(files.some((f) => f.includes('hydra-agents')), 'Should include hydra-agents');
  assert.ok(files.some((f) => f.includes('hydra-activity')), 'Should include hydra-activity');
});

// ── getTopicContext ─────────────────────────────────────────────────────────

test('codebase: getTopicContext returns content for dispatch', () => {
  const result = getTopicContext('dispatch');
  assert.ok(result.includes('=== CODEBASE CONTEXT: dispatch ==='));
  assert.ok(result.includes('=== END CONTEXT ==='));
  assert.ok(result.length > 100);
});

test('codebase: getTopicContext returns content for modules', () => {
  const result = getTopicContext('modules');
  assert.ok(result.includes('=== CODEBASE CONTEXT: modules ==='));
  assert.ok(result.length > 100);
});

test('codebase: getTopicContext returns general for unknown topic', () => {
  const result = getTopicContext('nonexistent');
  assert.ok(result.includes('general'));
});

test('codebase: getTopicContext enforces size budget', () => {
  const result = getTopicContext('modules');
  assert.ok(result.length <= 5100); // 5000 + small margin
});

// ── getBaselineContext ───────────────────────────────────────────────────────

test('codebase: getBaselineContext returns comprehensive baseline', () => {
  const result = getBaselineContext();
  assert.ok(result.includes('Codebase expertise'));
  assert.ok(result.includes('Architecture'));
  assert.ok(result.includes('Key modules'));
  assert.ok(result.includes('hydra-operator.mjs'));
  assert.ok(result.includes('Config sections'));
});

// ── getConfigReference ──────────────────────────────────────────────────────

test('codebase: getConfigReference returns config for concierge', () => {
  const result = getConfigReference('concierge');
  assert.ok(result, 'Should return config text');
  assert.ok(result.includes('concierge'));
});

test('codebase: getConfigReference returns null for unknown topic', () => {
  const result = getConfigReference('nonexistent');
  assert.equal(result, null);
});

// ── searchKnowledgeBase ─────────────────────────────────────────────────────

test('codebase: searchKnowledgeBase returns string (may be empty if no KB)', () => {
  const result = searchKnowledgeBase('orchestration');
  assert.equal(typeof result, 'string');
  // If KB exists and has orchestration entries, it should have content
  // If KB doesn't exist, should return empty string gracefully
});
