import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  AGENT_FILES,
  parseHydraMd,
  buildAgentFile,
  syncHydraMd,
  hasHydraMd,
  getAgentInstructionFile,
} from '../lib/hydra-sync-md.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sync-test-'));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── parseHydraMd ─────────────────────────────────────────────────────────────

describe('parseHydraMd', () => {
  it('splits shared vs agent-specific sections', () => {
    const content = `# HYDRA.md
Shared preamble.

## Architecture
Shared architecture section.

## @claude
Claude-only stuff.

## @gemini
Gemini-only stuff.

## @codex
Codex-only stuff.
`;
    const result = parseHydraMd(content);

    assert.ok(result.shared.includes('Shared preamble.'));
    assert.ok(result.shared.includes('## Architecture'));
    assert.ok(result.shared.includes('Shared architecture section.'));

    assert.ok(result.agents.claude.includes('Claude-only stuff.'));
    assert.ok(result.agents.gemini.includes('Gemini-only stuff.'));
    assert.ok(result.agents.codex.includes('Codex-only stuff.'));

    // Agent sections should NOT appear in shared
    assert.ok(!result.shared.includes('Claude-only'));
    assert.ok(!result.shared.includes('Gemini-only'));
    assert.ok(!result.shared.includes('Codex-only'));
  });

  it('treats all content as shared when no @agent headings exist', () => {
    const content = `# Project\n\n## Rules\nDo stuff.\n`;
    const result = parseHydraMd(content);

    assert.ok(result.shared.includes('Do stuff.'));
    assert.equal(result.agents.claude, '');
    assert.equal(result.agents.gemini, '');
    assert.equal(result.agents.codex, '');
  });

  it('switches back to shared on a non-agent ## heading after @agent', () => {
    const content = `## @claude
Claude stuff.

## Shared Again
This is shared.
`;
    const result = parseHydraMd(content);

    assert.ok(result.agents.claude.includes('Claude stuff.'));
    assert.ok(result.shared.includes('## Shared Again'));
    assert.ok(result.shared.includes('This is shared.'));
  });
});

// ── buildAgentFile ───────────────────────────────────────────────────────────

describe('buildAgentFile', () => {
  it('includes auto-generated header', () => {
    const parsed = parseHydraMd('# HYDRA.md\nShared.');
    const output = buildAgentFile('claude', parsed);

    assert.ok(output.startsWith('<!-- Auto-generated from HYDRA.md'));
  });

  it('includes shared + agent-specific content', () => {
    const content = `# HYDRA.md
Shared content.

## @claude
Claude specific.

## @gemini
Gemini specific.
`;
    const parsed = parseHydraMd(content);

    const claudeOut = buildAgentFile('claude', parsed);
    assert.ok(claudeOut.includes('Shared content.'));
    assert.ok(claudeOut.includes('Claude specific.'));
    assert.ok(!claudeOut.includes('Gemini specific.'));

    const geminiOut = buildAgentFile('gemini', parsed);
    assert.ok(geminiOut.includes('Shared content.'));
    assert.ok(geminiOut.includes('Gemini specific.'));
    assert.ok(!geminiOut.includes('Claude specific.'));
  });

  it('works when agent has no specific section', () => {
    const parsed = parseHydraMd('# HYDRA.md\nShared only.');
    const output = buildAgentFile('codex', parsed);

    assert.ok(output.includes('Shared only.'));
  });
});

// ── syncHydraMd ──────────────────────────────────────────────────────────────

describe('syncHydraMd', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  it('returns skipped when no HYDRA.md exists', () => {
    const result = syncHydraMd(tmpDir);
    assert.deepEqual(result, { synced: [], skipped: true });
  });

  it('creates all three agent files when HYDRA.md exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'HYDRA.md'), '# Test\nShared.\n\n## @claude\nFor Claude.\n', 'utf8');

    const result = syncHydraMd(tmpDir);

    assert.equal(result.skipped, false);
    assert.equal(result.synced.length, 3);
    assert.ok(result.synced.includes('CLAUDE.md'));
    assert.ok(result.synced.includes('GEMINI.md'));
    assert.ok(result.synced.includes('AGENTS.md'));

    // Verify file contents
    const claudeContent = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeContent.includes('Auto-generated from HYDRA.md'));
    assert.ok(claudeContent.includes('Shared.'));
    assert.ok(claudeContent.includes('For Claude.'));

    const geminiContent = fs.readFileSync(path.join(tmpDir, 'GEMINI.md'), 'utf8');
    assert.ok(geminiContent.includes('Shared.'));
    assert.ok(!geminiContent.includes('For Claude.'));
  });

  it('is idempotent — second sync writes nothing', () => {
    fs.writeFileSync(path.join(tmpDir, 'HYDRA.md'), '# Test\nContent.\n', 'utf8');

    const first = syncHydraMd(tmpDir);
    assert.ok(first.synced.length > 0);

    const second = syncHydraMd(tmpDir);
    assert.deepEqual(second.synced, []);
    assert.equal(second.skipped, false);
  });
});

// ── hasHydraMd ───────────────────────────────────────────────────────────────

describe('hasHydraMd', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  it('returns false when HYDRA.md does not exist', () => {
    assert.equal(hasHydraMd(tmpDir), false);
  });

  it('returns true when HYDRA.md exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'HYDRA.md'), '# Test\n', 'utf8');
    assert.equal(hasHydraMd(tmpDir), true);
  });
});

// ── getAgentInstructionFile ──────────────────────────────────────────────────

describe('getAgentInstructionFile', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  it('returns CLAUDE.md fallback when no HYDRA.md', () => {
    assert.equal(getAgentInstructionFile('claude', tmpDir), 'CLAUDE.md');
    assert.equal(getAgentInstructionFile('gemini', tmpDir), 'CLAUDE.md');
    assert.equal(getAgentInstructionFile('codex', tmpDir), 'CLAUDE.md');
  });

  it('returns agent-specific file when HYDRA.md exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'HYDRA.md'), '# Test\n', 'utf8');

    assert.equal(getAgentInstructionFile('claude', tmpDir), 'CLAUDE.md');
    assert.equal(getAgentInstructionFile('gemini', tmpDir), 'GEMINI.md');
    assert.equal(getAgentInstructionFile('codex', tmpDir), 'AGENTS.md');
  });
});

// ── AGENT_FILES constant ─────────────────────────────────────────────────────

describe('AGENT_FILES', () => {
  it('maps all three agents', () => {
    assert.equal(AGENT_FILES.claude, 'CLAUDE.md');
    assert.equal(AGENT_FILES.gemini, 'GEMINI.md');
    assert.equal(AGENT_FILES.codex, 'AGENTS.md');
  });
});
