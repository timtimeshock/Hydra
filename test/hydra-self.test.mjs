import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelfSnapshot, getGitInfo, formatSelfSnapshotForPrompt } from '../lib/hydra-self.mjs';
import { buildSelfIndex, formatSelfIndexForPrompt } from '../lib/hydra-self-index.mjs';
import { HYDRA_ROOT } from '../lib/hydra-config.mjs';

test('self: getGitInfo returns null for non-repo dirs', () => {
  const info = getGitInfo('Z:/definitely/not/a/real/path');
  assert.equal(info, null);
});

test('self: buildSelfSnapshot includes hydra version + models', () => {
  const s = buildSelfSnapshot({ projectRoot: HYDRA_ROOT });
  assert.ok(s.generatedAt);
  assert.ok(s.hydra);
  assert.ok(s.hydra.version);
  assert.ok(s.models);
  assert.equal(s.project.root, HYDRA_ROOT);
});

test('self: formatSelfSnapshotForPrompt returns bounded block', () => {
  const s = buildSelfSnapshot({ projectRoot: HYDRA_ROOT });
  const text = formatSelfSnapshotForPrompt(s, { maxLines: 30 });
  assert.ok(text.includes('=== HYDRA SELF SNAPSHOT ==='));
  assert.ok(text.includes('=== END SNAPSHOT ==='));
  assert.ok(text.split('\n').length <= 32);
});

test('self: buildSelfIndex includes daemon routes and mcp tools/resources', () => {
  const idx = buildSelfIndex(HYDRA_ROOT);
  assert.ok(idx.generatedAt);
  assert.ok(Array.isArray(idx.daemonRoutes));
  assert.ok(idx.mcp);
  assert.ok(Array.isArray(idx.mcp.tools));
  assert.ok(Array.isArray(idx.mcp.resources));
  // Should include at least the standard MCP resources
  assert.ok(idx.mcp.resources.some((r) => r === 'hydra://config'));
});

test('self: formatSelfIndexForPrompt returns bounded block', () => {
  const idx = buildSelfIndex(HYDRA_ROOT);
  const text = formatSelfIndexForPrompt(idx, { maxChars: 1200 });
  assert.ok(text.includes('=== HYDRA SELF INDEX ==='));
  assert.ok(text.includes('=== END INDEX ==='));
  assert.ok(text.length <= 1215);
});

