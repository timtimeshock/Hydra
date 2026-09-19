import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COLORS,
  AGENT_ICONS,
  HEALTH_ICONS,
  ACCENT,
  DIM,
  ERROR,
  SUCCESS,
  WARNING,
  stripAnsi,
  formatElapsed,
  compactProgressBar,
  progressBar,
  shortModelName,
  extractTopic,
  phaseNarrative,
  colorAgent,
  agentBadge,
  formatAgentStatus,
  colorStatus,
  formatTaskLine,
  relativeTime,
  box,
  sectionHeader,
  divider,
  label,
} from '../lib/hydra-ui.mjs';

// ── stripAnsi ────────────────────────────────────────────────────────────────

test('stripAnsi removes basic ANSI color codes', () => {
  assert.equal(stripAnsi('\x1b[31mhello\x1b[0m'), 'hello');
  assert.equal(stripAnsi('\x1b[1m\x1b[91mbold red\x1b[0m'), 'bold red');
});

test('stripAnsi removes truecolor sequences', () => {
  assert.equal(stripAnsi('\x1b[38;2;232;134;58morange\x1b[39m'), 'orange');
});

test('stripAnsi passes plain text unchanged', () => {
  assert.equal(stripAnsi('plain text'), 'plain text');
  assert.equal(stripAnsi(''), '');
});

test('stripAnsi handles null/undefined gracefully', () => {
  assert.equal(stripAnsi(null), '');
  assert.equal(stripAnsi(undefined), '');
});

// ── formatElapsed ────────────────────────────────────────────────────────────

test('formatElapsed formats seconds correctly', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(500), '0s');
  assert.equal(formatElapsed(1000), '1s');
  assert.equal(formatElapsed(45000), '45s');
  assert.equal(formatElapsed(59999), '59s');
});

test('formatElapsed formats minutes correctly', () => {
  assert.equal(formatElapsed(60000), '1m');
  assert.equal(formatElapsed(90000), '1m 30s');
  assert.equal(formatElapsed(120000), '2m');
  assert.equal(formatElapsed(3599000), '59m 59s');
});

test('formatElapsed formats hours correctly', () => {
  assert.equal(formatElapsed(3600000), '1h');
  assert.equal(formatElapsed(5400000), '1h 30m');
  assert.equal(formatElapsed(7200000), '2h');
});

test('formatElapsed handles negative and null', () => {
  assert.equal(formatElapsed(-1), '0s');
  assert.equal(formatElapsed(null), '0s');
  assert.equal(formatElapsed(undefined), '0s');
});

// ── shortModelName ───────────────────────────────────────────────────────────

test('shortModelName extracts Claude model names', () => {
  assert.equal(shortModelName('claude-opus-4-6'), 'opus');
  assert.equal(shortModelName('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
  assert.equal(shortModelName('claude-haiku-4-5-20251001'), 'haiku');
});

test('shortModelName extracts Gemini model names', () => {
  assert.equal(shortModelName('gemini-2.5-flash'), '2.5-flash');
  assert.equal(shortModelName('gemini-2.5-pro'), '2.5-pro');
  assert.equal(shortModelName('gemini-3-pro-preview'), 'pro');
  assert.equal(shortModelName('gemini-3-flash-preview'), 'flash');
});

test('shortModelName extracts OpenAI/Codex model names', () => {
  assert.equal(shortModelName('o4-mini'), 'o4-mini');
  assert.equal(shortModelName('codex-5.2'), 'gpt-5.2c');
  assert.equal(shortModelName('gpt-5.2-codex'), 'gpt-5.2c');
  assert.equal(shortModelName('gpt-5.2'), 'gpt-5.2');
  assert.equal(shortModelName('gpt-5.6-terra'), 'terra');
  assert.equal(shortModelName('gpt-5'), 'gpt-5');
  assert.equal(shortModelName('gpt-4'), 'gpt-4');
});

test('shortModelName handles null/empty', () => {
  assert.equal(shortModelName(''), '');
  assert.equal(shortModelName(null), '');
  assert.equal(shortModelName(undefined), '');
});

test('shortModelName strips common prefixes for unknown models', () => {
  const result = shortModelName('claude-future-model-20260101');
  assert.ok(!result.startsWith('claude-'), 'Should strip claude- prefix');
});

// ── extractTopic ─────────────────────────────────────────────────────────────

test('extractTopic strips leading filler words', () => {
  const topic = extractTopic('please fix the auth bug');
  assert.ok(!topic.toLowerCase().startsWith('please'));
  assert.ok(topic.includes('auth bug'));
});

test('extractTopic strips action verbs', () => {
  const topic = extractTopic('fix the login form');
  assert.ok(!topic.toLowerCase().startsWith('fix'));
  assert.ok(topic.includes('login form'));
});

test('extractTopic truncates long prompts at word boundary', () => {
  const longPrompt = 'the authentication system needs to be completely redesigned from scratch with new token handling';
  const topic = extractTopic(longPrompt, 30);
  assert.ok(topic.length <= 31); // +1 for ellipsis char
  assert.ok(topic.endsWith('\u2026') || topic.length <= 30);
});

test('extractTopic takes first clause on semicolons', () => {
  const topic = extractTopic('update the header; also fix the footer');
  assert.ok(!topic.includes('footer'));
});

test('extractTopic returns empty for null/empty', () => {
  assert.equal(extractTopic(''), '');
  assert.equal(extractTopic(null), '');
  assert.equal(extractTopic(undefined), '');
});

// ── phaseNarrative ───────────────────────────────────────────────────────────

test('phaseNarrative returns correct narratives for known phases', () => {
  assert.match(phaseNarrative('propose', 'claude', 'auth fix'), /Analyzing/i);
  assert.match(phaseNarrative('critique', 'gemini', 'auth fix'), /Reviewing/i);
  assert.match(phaseNarrative('refine', 'claude', ''), /Incorporating/i);
  assert.match(phaseNarrative('implement', 'codex', 'new feature'), /Evaluating/i);
  assert.match(phaseNarrative('vote', 'claude', ''), /Casting/i);
  assert.match(phaseNarrative('summarize', 'claude', ''), /Summarizing/i);
});

test('phaseNarrative falls back for unknown phases', () => {
  const result = phaseNarrative('unknown_phase', 'claude', 'topic');
  assert.ok(result.includes('topic') || result.includes('unknown_phase'));
});

// ── AGENT_COLORS ─────────────────────────────────────────────────────────────

test('AGENT_COLORS has entries for all three agents', () => {
  assert.ok(typeof AGENT_COLORS.claude === 'function');
  assert.ok(typeof AGENT_COLORS.gemini === 'function');
  assert.ok(typeof AGENT_COLORS.codex === 'function');
  assert.ok(typeof AGENT_COLORS.human === 'function');
  assert.ok(typeof AGENT_COLORS.system === 'function');
});

test('AGENT_COLORS.claude uses truecolor orange (#E8863A)', () => {
  const colored = AGENT_COLORS.claude('test');
  // Should contain the truecolor escape for 232;134;58
  assert.ok(colored.includes('38;2;232;134;58'), `Expected truecolor orange, got: ${JSON.stringify(colored)}`);
  assert.ok(colored.includes('test'));
});

test('AGENT_COLORS produce strings containing the input text', () => {
  for (const [name, fn] of Object.entries(AGENT_COLORS)) {
    const result = fn('hello');
    assert.ok(result.includes('hello'), `${name} color function should wrap text`);
  }
});

// ── AGENT_ICONS ──────────────────────────────────────────────────────────────

test('AGENT_ICONS has correct symbols', () => {
  assert.equal(AGENT_ICONS.claude, '\u274B');    // ❋
  assert.equal(AGENT_ICONS.gemini, '\u2726');    // ✦
  assert.equal(AGENT_ICONS.codex, '\u058E');     // ֎
  assert.equal(AGENT_ICONS.human, '\u{1F16F}');  // 🅯
  assert.equal(AGENT_ICONS.system, '\u{1F5B3}'); // 🖳
});

// ── HEALTH_ICONS ─────────────────────────────────────────────────────────────

test('HEALTH_ICONS has all four states', () => {
  assert.ok(HEALTH_ICONS.idle);
  assert.ok(HEALTH_ICONS.working);
  assert.ok(HEALTH_ICONS.error);
  assert.ok(HEALTH_ICONS.inactive);
  // All should contain the filled circle character
  for (const icon of Object.values(HEALTH_ICONS)) {
    assert.ok(stripAnsi(icon).includes('\u25CF'));
  }
});

// ── colorAgent ───────────────────────────────────────────────────────────────

test('colorAgent wraps known agents with their color', () => {
  const result = colorAgent('claude');
  const stripped = stripAnsi(result);
  assert.equal(stripped, 'claude');
  // Should have ANSI codes
  assert.ok(result.length > stripped.length);
});

test('colorAgent defaults to white for unknown agents', () => {
  const result = colorAgent('unknown_agent');
  assert.ok(result.includes('unknown_agent'));
});

test('colorAgent handles null/empty', () => {
  // colorAgent uses String(name), so null becomes "null"
  const result = colorAgent(null);
  assert.equal(stripAnsi(result), 'null');
  const empty = colorAgent('');
  assert.equal(stripAnsi(empty), '');
});

// ── agentBadge ───────────────────────────────────────────────────────────────

test('agentBadge includes icon and uppercased name', () => {
  const badge = agentBadge('claude');
  const stripped = stripAnsi(badge);
  assert.ok(stripped.includes('\u274B'), 'Should contain star icon');
  assert.ok(stripped.includes('CLAUDE'), 'Should contain uppercased name');
});

test('agentBadge works for all agents', () => {
  for (const name of ['gemini', 'codex', 'claude']) {
    const badge = agentBadge(name);
    const stripped = stripAnsi(badge);
    assert.ok(stripped.includes(name.toUpperCase()));
  }
});

// ── formatAgentStatus ────────────────────────────────────────────────────────

test('formatAgentStatus includes health icon, agent icon, and action text', () => {
  const result = formatAgentStatus('claude', 'working', 'Calling sonnet...');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('CLAUDE'));
  assert.ok(stripped.includes('Calling sonnet...'));
});

test('formatAgentStatus truncates action text at maxWidth', () => {
  const result = formatAgentStatus('gemini', 'idle', 'A very long action description here', 15);
  const stripped = stripAnsi(result);
  // The name + action portion should be truncated
  assert.ok(stripped.includes('\u2026') || stripped.length <= 30);
});

// ── progressBar / compactProgressBar ─────────────────────────────────────────

test('progressBar renders filled and empty segments', () => {
  const bar = progressBar(50, 10);
  const stripped = stripAnsi(bar);
  assert.ok(stripped.includes('50.0%'));
});

test('progressBar clamps to 0-100', () => {
  const low = progressBar(-10, 10);
  assert.ok(stripAnsi(low).includes('0.0%'));
  const high = progressBar(200, 10);
  assert.ok(stripAnsi(high).includes('100.0%'));
});

test('compactProgressBar renders percentage', () => {
  const bar = compactProgressBar(75, 10);
  assert.ok(stripAnsi(bar).includes('75.0%'));
});

test('compactProgressBar handles zero', () => {
  const bar = compactProgressBar(0, 10);
  assert.ok(stripAnsi(bar).includes('0.0%'));
});

// ── box ──────────────────────────────────────────────────────────────────────

test('box creates bordered output with title', () => {
  const result = box('Test', ['line 1', 'line 2'], 30);
  assert.ok(result.includes('Test'));
  assert.ok(result.includes('line 1'));
  assert.ok(result.includes('line 2'));
  assert.ok(result.includes('\u250C')); // top-left corner
  assert.ok(result.includes('\u2514')); // bottom-left corner
});

test('box handles empty lines array', () => {
  const result = box('Empty', [], 20);
  assert.ok(result.includes('Empty'));
  assert.ok(result.includes('\u250C'));
  assert.ok(result.includes('\u2514'));
});

// ── sectionHeader ────────────────────────────────────────────────────────────

test('sectionHeader includes title text', () => {
  const result = sectionHeader('Agents');
  assert.ok(stripAnsi(result).includes('Agents'));
});

// ── divider ──────────────────────────────────────────────────────────────────

test('divider returns horizontal line', () => {
  const result = divider();
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('─'));
  assert.ok(stripped.length >= 50);
});

// ── label ────────────────────────────────────────────────────────────────────

test('label formats key-value pair', () => {
  const result = label('Mode', 'auto');
  const stripped = stripAnsi(result);
  assert.ok(stripped.includes('Mode:'));
  assert.ok(stripped.includes('auto'));
});

// ── colorStatus ──────────────────────────────────────────────────────────────

test('colorStatus includes status icon and text', () => {
  const done = colorStatus('done');
  assert.ok(stripAnsi(done).includes('\u2713'));
  assert.ok(stripAnsi(done).includes('done'));

  const blocked = colorStatus('blocked');
  assert.ok(stripAnsi(blocked).includes('\u2717'));
});

// ── formatTaskLine ───────────────────────────────────────────────────────────

test('formatTaskLine renders task with id, status, owner', () => {
  const line = formatTaskLine({ id: 'T-1', status: 'todo', owner: 'claude', title: 'Fix auth' });
  const stripped = stripAnsi(line);
  assert.ok(stripped.includes('T-1'));
  assert.ok(stripped.includes('claude'));
});

test('formatTaskLine handles null task', () => {
  assert.equal(formatTaskLine(null), '');
});

// ── relativeTime ─────────────────────────────────────────────────────────────

test('relativeTime shows "just now" for recent timestamps', () => {
  const result = relativeTime(new Date().toISOString());
  assert.ok(stripAnsi(result).includes('just now'));
});

test('relativeTime shows minutes for older timestamps', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const result = relativeTime(fiveMinAgo);
  assert.ok(stripAnsi(result).includes('5m ago'));
});

test('relativeTime shows "never" for null', () => {
  assert.ok(stripAnsi(relativeTime(null)).includes('never'));
});

// ── Semantic color exports ───────────────────────────────────────────────────

test('semantic color exports are functions', () => {
  assert.ok(typeof ACCENT === 'function');
  assert.ok(typeof DIM === 'function');
  assert.ok(typeof ERROR === 'function');
  assert.ok(typeof SUCCESS === 'function');
  assert.ok(typeof WARNING === 'function');
});
