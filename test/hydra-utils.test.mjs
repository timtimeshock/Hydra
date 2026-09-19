import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  parseArgsWithCommand,
  getOption,
  requireOption,
  getPrompt,
  boolFlag,
  parseList,
  short,
  parseJsonLoose,
  sanitizeOwner,
  normalizeTask,
  dedupeTasks,
  classifyPrompt,
  selectTandemPair,
  parseTestOutput,
  nowIso,
  runId,
  runProcess,
} from '../lib/hydra-utils.mjs';

// ── parseArgs ────────────────────────────────────────────────────────────────

test('parseArgs parses key=value pairs', () => {
  const argv = ['node', 'script.mjs', 'prompt=hello world', 'mode=auto'];
  const { options, positionals } = parseArgs(argv);
  assert.equal(options.prompt, 'hello world');
  assert.equal(options.mode, 'auto');
  assert.equal(positionals.length, 0);
});

test('parseArgs handles positional arguments', () => {
  const argv = ['node', 'script.mjs', 'summary'];
  const { options, positionals } = parseArgs(argv);
  assert.equal(positionals.length, 1);
  assert.equal(positionals[0], 'summary');
  assert.equal(Object.keys(options).length, 0);
});

test('parseArgs handles values with equals signs', () => {
  const argv = ['node', 'script.mjs', 'prompt=a=b=c'];
  const { options } = parseArgs(argv);
  assert.equal(options.prompt, 'a=b=c');
});

test('parseArgs handles empty argv', () => {
  const { options, positionals } = parseArgs(['node', 'script.mjs']);
  assert.equal(Object.keys(options).length, 0);
  assert.equal(positionals.length, 0);
});

// ── parseArgsWithCommand ─────────────────────────────────────────────────────

test('parseArgsWithCommand extracts command', () => {
  const argv = ['node', 'script.mjs', 'task:add', 'title=Fix bug', 'owner=claude'];
  const { command, options, positionals } = parseArgsWithCommand(argv);
  assert.equal(command, 'task:add');
  assert.equal(options.title, 'Fix bug');
  assert.equal(options.owner, 'claude');
  assert.equal(positionals.length, 0);
});

test('parseArgsWithCommand defaults to help', () => {
  const { command } = parseArgsWithCommand(['node', 'script.mjs']);
  assert.equal(command, 'help');
});

// ── getOption / requireOption ────────────────────────────────────────────────

test('getOption returns value or fallback', () => {
  assert.equal(getOption({ key: 'value' }, 'key'), 'value');
  assert.equal(getOption({ key: 'value' }, 'missing', 'default'), 'default');
  assert.equal(getOption({}, 'missing', 'fallback'), 'fallback');
});

test('requireOption throws on missing key', () => {
  assert.throws(() => requireOption({}, 'missing'), /missing/i);
});

test('requireOption returns value when present', () => {
  assert.equal(requireOption({ key: 'val' }, 'key'), 'val');
});

// ── getPrompt ────────────────────────────────────────────────────────────────

test('getPrompt prefers options.prompt', () => {
  assert.equal(getPrompt({ prompt: 'from option' }, ['from positional']), 'from option');
});

test('getPrompt falls back to positionals joined', () => {
  assert.equal(getPrompt({}, ['hello', 'world']), 'hello world');
});

test('getPrompt returns empty string when nothing available', () => {
  assert.equal(getPrompt({}, []), '');
});

// ── boolFlag ─────────────────────────────────────────────────────────────────

test('boolFlag recognizes truthy values', () => {
  assert.equal(boolFlag('true'), true);
  assert.equal(boolFlag('1'), true);
  assert.equal(boolFlag('yes'), true);
  assert.equal(boolFlag('y'), true);
  assert.equal(boolFlag('on'), true);
  assert.equal(boolFlag('TRUE'), true);
  assert.equal(boolFlag('Yes'), true);
});

test('boolFlag recognizes falsy values', () => {
  assert.equal(boolFlag('false'), false);
  assert.equal(boolFlag('0'), false);
  assert.equal(boolFlag('no'), false);
  assert.equal(boolFlag('off'), false);
});

test('boolFlag uses fallback for empty/undefined', () => {
  assert.equal(boolFlag(undefined, false), false);
  assert.equal(boolFlag(undefined, true), true);
  assert.equal(boolFlag('', true), true);
});

// ── parseList ────────────────────────────────────────────────────────────────

test('parseList splits comma-separated values', () => {
  assert.deepEqual(parseList('gemini,codex,claude'), ['gemini', 'codex', 'claude']);
});

test('parseList preserves spaces within values', () => {
  assert.deepEqual(parseList('claude gemini'), ['claude gemini']);
});

test('parseList handles mixed separators and trims', () => {
  assert.deepEqual(parseList('gemini, codex , claude'), ['gemini', 'codex', 'claude']);
});

test('parseList returns empty for null/empty', () => {
  assert.deepEqual(parseList(null), []);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});

test('parseList passes through arrays', () => {
  assert.deepEqual(parseList(['a', 'b']), ['a', 'b']);
});

test('parseList trims whitespace around values', () => {
  assert.deepEqual(parseList('  a , b , c  '), ['a', 'b', 'c']);
});

test('parseList handles single value', () => {
  assert.deepEqual(parseList('single'), ['single']);
});

test('parseList ignores trailing comma', () => {
  assert.deepEqual(parseList('a,b,'), ['a', 'b']);
});

// ── short ────────────────────────────────────────────────────────────────────

test('short truncates long text with ellipsis', () => {
  const result = short('a'.repeat(500), 100);
  assert.equal(result.length, 100);
  assert.ok(result.endsWith('...'));
});

test('short passes short text unchanged', () => {
  assert.equal(short('hello', 100), 'hello');
});

test('short collapses whitespace', () => {
  assert.equal(short('hello   world\n\t  foo'), 'hello world foo');
});

test('short handles null/empty', () => {
  assert.equal(short(null), '');
  assert.equal(short(''), '');
});

// ── parseJsonLoose ───────────────────────────────────────────────────────────

test('parseJsonLoose parses valid JSON', () => {
  const result = parseJsonLoose('{"key": "value"}');
  assert.deepEqual(result, { key: 'value' });
});

test('parseJsonLoose extracts JSON from markdown code block', () => {
  const input = 'Some text\n```json\n{"tasks": [1,2,3]}\n```\nMore text';
  const result = parseJsonLoose(input);
  assert.deepEqual(result, { tasks: [1, 2, 3] });
});

test('parseJsonLoose extracts embedded JSON object', () => {
  const input = 'Here is the result: {"ok": true, "count": 5} end';
  const result = parseJsonLoose(input);
  assert.deepEqual(result, { ok: true, count: 5 });
});

test('parseJsonLoose returns null for non-JSON', () => {
  assert.equal(parseJsonLoose('not json at all'), null);
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose(null), null);
});

// ── sanitizeOwner ────────────────────────────────────────────────────────────

test('sanitizeOwner accepts known owners', () => {
  assert.equal(sanitizeOwner('claude'), 'claude');
  assert.equal(sanitizeOwner('gemini'), 'gemini');
  assert.equal(sanitizeOwner('codex'), 'codex');
  assert.equal(sanitizeOwner('human'), 'human');
});

test('sanitizeOwner lowercases input', () => {
  assert.equal(sanitizeOwner('CLAUDE'), 'claude');
  assert.equal(sanitizeOwner('Gemini'), 'gemini');
});

test('sanitizeOwner defaults unknown to unassigned', () => {
  assert.equal(sanitizeOwner('unknown_agent'), 'unassigned');
  assert.equal(sanitizeOwner(''), 'unassigned');
  assert.equal(sanitizeOwner(null), 'unassigned');
});

// ── normalizeTask ────────────────────────────────────────────────────────────

test('normalizeTask extracts title and owner', () => {
  const task = normalizeTask({ title: 'Fix login', owner: 'claude' });
  assert.equal(task.title, 'Fix login');
  assert.equal(task.owner, 'claude');
});

test('normalizeTask uses "task" field as title fallback', () => {
  const task = normalizeTask({ task: 'Build feature' });
  assert.equal(task.title, 'Build feature');
});

test('normalizeTask returns null for empty title', () => {
  assert.equal(normalizeTask({ title: '' }), null);
  assert.equal(normalizeTask({ title: '   ' }), null);
});

test('normalizeTask returns null for non-object input', () => {
  assert.equal(normalizeTask(null), null);
  assert.equal(normalizeTask('string'), null);
  assert.equal(normalizeTask(42), null);
});

test('normalizeTask extracts definition_of_done and rationale', () => {
  const task = normalizeTask({
    title: 'Test',
    definition_of_done: 'All tests pass',
    rationale: 'Improves reliability',
  });
  assert.equal(task.done, 'All tests pass');
  assert.equal(task.rationale, 'Improves reliability');
});

test('normalizeTask uses fallback owner', () => {
  const task = normalizeTask({ title: 'Task' }, 'codex');
  assert.equal(task.owner, 'codex');
});

// ── dedupeTasks ──────────────────────────────────────────────────────────────

test('dedupeTasks removes duplicates by owner+title', () => {
  const tasks = [
    { owner: 'claude', title: 'Fix bug' },
    { owner: 'claude', title: 'Fix bug' },
    { owner: 'gemini', title: 'Fix bug' },
  ];
  const result = dedupeTasks(tasks);
  assert.equal(result.length, 2);
});

test('dedupeTasks is case-insensitive for titles', () => {
  const tasks = [
    { owner: 'claude', title: 'Fix Bug' },
    { owner: 'claude', title: 'fix bug' },
  ];
  const result = dedupeTasks(tasks);
  assert.equal(result.length, 1);
});

test('dedupeTasks skips null entries', () => {
  const tasks = [null, { owner: 'claude', title: 'Task' }, null];
  const result = dedupeTasks(tasks);
  assert.equal(result.length, 1);
});

test('dedupeTasks preserves order (keeps first)', () => {
  const tasks = [
    { owner: 'claude', title: 'A' },
    { owner: 'gemini', title: 'B' },
    { owner: 'claude', title: 'a' },
  ];
  const result = dedupeTasks(tasks);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'A');
  assert.equal(result[1].title, 'B');
});

// ── classifyPrompt ───────────────────────────────────────────────────────────

test('classifyPrompt returns required fields', () => {
  const result = classifyPrompt('fix the login bug');
  assert.ok(['simple', 'moderate', 'complex'].includes(result.tier));
  assert.ok(result.taskType);
  assert.ok(result.suggestedAgent);
  assert.ok(typeof result.confidence === 'number');
  assert.ok(typeof result.reason === 'string');
});

test('classifyPrompt rates short imperative prompts as simple', () => {
  const result = classifyPrompt('fix the login bug in auth.js');
  assert.equal(result.tier, 'simple');
});

test('classifyPrompt rates complex deliberation prompts as complex', () => {
  const result = classifyPrompt(
    'Should we redesign the entire authentication system? We need to compare OAuth vs JWT approaches, ' +
    'evaluate the trade-offs of each, and decide which strategy to use going forward. ' +
    'Also investigate whether we should migrate the existing sessions.'
  );
  assert.equal(result.tier, 'complex');
});

test('classifyPrompt rates moderate prompts correctly', () => {
  const result = classifyPrompt('update the user profile page with better validation');
  assert.ok(['simple', 'moderate'].includes(result.tier));
});

test('classifyPrompt handles empty prompt', () => {
  const result = classifyPrompt('');
  assert.equal(result.tier, 'moderate');
  assert.ok(result.confidence <= 0.5);
});

test('classifyPrompt detects agent mentions', () => {
  const result = classifyPrompt('claude should review the auth module');
  assert.equal(result.suggestedAgent, 'claude');
});

test('classifyPrompt detects file paths as simple signal', () => {
  const result = classifyPrompt('update lib/hydra-config.mjs with new defaults');
  assert.equal(result.tier, 'simple');
  assert.ok(result.reason.includes('file paths'));
});

test('classifyPrompt confidence is between 0 and 1', () => {
  const prompts = [
    'fix bug',
    'design the new microservices architecture and evaluate trade-offs between gRPC and REST',
    'add a button',
  ];
  for (const p of prompts) {
    const result = classifyPrompt(p);
    assert.ok(result.confidence >= 0 && result.confidence <= 1, `confidence ${result.confidence} out of range for "${p}"`);
  }
});

// ── classifyPrompt route strategy ────────────────────────────────────────────

test('classifyPrompt returns routeStrategy field', () => {
  const result = classifyPrompt('fix the login bug');
  assert.ok(['single', 'tandem', 'council'].includes(result.routeStrategy));
  assert.ok('tandemPair' in result);
});

test('classifyPrompt routes simple prompts as single', () => {
  const result = classifyPrompt('fix the typo in auth.js');
  assert.equal(result.routeStrategy, 'single');
  assert.equal(result.tandemPair, null);
});

test('classifyPrompt routes moderate prompts as tandem', () => {
  const result = classifyPrompt('update the user profile page with better validation');
  if (result.tier === 'moderate' || (result.tier === 'simple' && result.routeStrategy === 'tandem')) {
    assert.equal(result.routeStrategy, 'tandem');
    assert.ok(result.tandemPair);
    assert.ok(result.tandemPair.lead);
    assert.ok(result.tandemPair.follow);
  }
});

test('classifyPrompt routes high-complexity prompts as council', () => {
  const result = classifyPrompt(
    'Should we redesign the entire authentication system? We need to compare OAuth vs JWT approaches, ' +
    'evaluate the trade-offs of each, and decide which strategy to use going forward. ' +
    'Also investigate whether we should migrate the existing sessions.'
  );
  assert.equal(result.routeStrategy, 'council');
});

test('classifyPrompt detects tandem indicators (two-phase language)', () => {
  const result = classifyPrompt('first analyze the code then implement the fix');
  assert.equal(result.routeStrategy, 'tandem');
  assert.ok(result.reason.includes('two-phase language'));
});

test('classifyPrompt detects review and fix as tandem indicator', () => {
  const result = classifyPrompt('review and fix the auth module');
  assert.equal(result.routeStrategy, 'tandem');
});

// ── selectTandemPair ─────────────────────────────────────────────────────────

test('selectTandemPair returns correct pair for each task type', () => {
  const pairs = {
    planning: { lead: 'claude', follow: 'codex' },
    architecture: { lead: 'claude', follow: 'gemini' },
    review: { lead: 'gemini', follow: 'claude' },
    testing: { lead: 'codex', follow: 'gemini' },
    security: { lead: 'gemini', follow: 'claude' },
  };
  for (const [taskType, expected] of Object.entries(pairs)) {
    const result = selectTandemPair(taskType, 'claude');
    assert.deepEqual(result, expected, `wrong pair for ${taskType}`);
  }
});

test('selectTandemPair respects agent filter', () => {
  const result = selectTandemPair('planning', 'claude', ['claude', 'gemini']);
  // planning lead=claude, follow=codex, but codex not available → swap follow
  assert.equal(result.lead, 'claude');
  assert.equal(result.follow, 'gemini');
});

test('selectTandemPair degrades to null when only 1 agent available', () => {
  const result = selectTandemPair('planning', 'claude', ['claude']);
  assert.equal(result, null);
});

test('selectTandemPair returns pair with no filter', () => {
  const result = selectTandemPair('implementation', 'claude');
  assert.deepEqual(result, { lead: 'claude', follow: 'codex' });
});

// ── nowIso / runId ───────────────────────────────────────────────────────────

test('nowIso returns ISO 8601 string', () => {
  const iso = nowIso();
  assert.ok(iso.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/));
});

test('runId returns prefixed timestamp string', () => {
  const id = runId('TEST');
  assert.ok(id.startsWith('TEST_'));
  assert.ok(id.match(/^TEST_\d{8}_\d{6}$/));
});

test('runId defaults to HYDRA prefix', () => {
  const id = runId();
  assert.ok(id.startsWith('HYDRA_'));
});

// ── parseTestOutput ─────────────────────────────────────────────────────────

test('parseTestOutput extracts TAP summary counters', () => {
  const stdout = `
TAP version 13
ok 1 - adds numbers
ok 2 - subtracts numbers
not ok 3 - divides by zero
  Error: expected 0 to equal Infinity
# tests 3
# pass 2
# fail 1
# duration_ms 142.5
`;
  const result = parseTestOutput(stdout, '');
  assert.equal(result.total, 3);
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.durationMs, 142.5);
});

test('parseTestOutput extracts failed test names from not ok lines', () => {
  const stdout = `
not ok 1 - widget > renders correctly
  expected 5 to equal 6
not ok 2 - api > handles timeout
  fetch is not defined
# tests 5
# pass 3
# fail 2
`;
  const result = parseTestOutput(stdout, '');
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures[0].name, 'widget > renders correctly');
  assert.equal(result.failures[0].error, 'expected 5 to equal 6');
  assert.equal(result.failures[1].name, 'api > handles timeout');
  assert.equal(result.failures[1].error, 'fetch is not defined');
});

test('parseTestOutput handles spec reporter markers', () => {
  const stdout = `
  ✗ config > validates schema
    AssertionError: expected false to be true
  ✗ auth > rejects invalid token
    TokenError: invalid signature
`;
  const result = parseTestOutput(stdout, '');
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures[0].name, 'config > validates schema');
  assert.equal(result.failures[1].name, 'auth > rejects invalid token');
});

test('parseTestOutput returns zeros on empty input', () => {
  const result = parseTestOutput('', '');
  assert.equal(result.total, 0);
  assert.equal(result.passed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.durationMs, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(result.summary, '');
});

test('parseTestOutput returns zeros on unparseable input', () => {
  const result = parseTestOutput('random garbage output\nno tests here', 'some stderr');
  assert.equal(result.total, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.summary, '');
});

test('parseTestOutput builds readable summary string', () => {
  const stdout = `
not ok 1 - widget > renders
not ok 2 - api > timeout
not ok 3 - config > schema
# tests 15
# pass 12
# fail 3
`;
  const result = parseTestOutput(stdout, '');
  assert.ok(result.summary.includes('3/15 failed'));
  assert.ok(result.summary.includes('widget > renders'));
  assert.ok(result.summary.includes('api > timeout'));
});

test('parseTestOutput builds pass summary when all pass', () => {
  const stdout = `
# tests 10
# pass 10
# fail 0
# duration_ms 500
`;
  const result = parseTestOutput(stdout, '');
  assert.equal(result.summary, '10/10 passed');
});

test('parseTestOutput handles combined stdout+stderr input', () => {
  const stdout = `
ok 1 - test a
# tests 2
# pass 1
# fail 1
`;
  const stderr = `
not ok 2 - test b fails
  AssertionError: boom
`;
  const result = parseTestOutput(stdout, stderr);
  assert.equal(result.total, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, 'test b fails');
});

// ── runProcess ──────────────────────────────────────────────────────────────

test('runProcess returns ok:true for successful command', () => {
  const result = runProcess('node', ['-e', "console.log('hello')"]);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('hello'));
  assert.equal(result.error, '');
  assert.equal(result.timedOut, false);
});

test('runProcess returns ok:false for non-zero exit', () => {
  const result = runProcess('node', ['-e', 'process.exit(42)']);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 42);
});

test('runProcess captures stderr', () => {
  const result = runProcess('node', ['-e', "console.error('oops')"]);
  assert.ok(result.stderr.includes('oops'));
});

test('runProcess handles timeout', () => {
  const result = runProcess('node', ['-e', 'setTimeout(()=>{},10000)'], 500);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('runProcess returns ok:false for unknown command', () => {
  const result = runProcess('nonexistent_cmd_xyz_12345', []);
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test('runProcess respects cwd option', () => {
  const result = runProcess('node', ['-e', "console.log(process.cwd())"], undefined, { cwd: process.cwd() });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.trim().length > 0);
});

test('runProcess pipes stdin input', () => {
  const result = runProcess('node', ['-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d))"], undefined, { input: 'piped-data' });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.includes('piped-data'));
});
