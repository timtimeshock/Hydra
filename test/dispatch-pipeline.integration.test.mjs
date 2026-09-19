import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPrompt, selectTandemPair } from '../lib/hydra-utils.mjs';
import {
  createMockExecuteAgent,
  loadAgentFixture,
  makeFailureResult,
  makeSuccessResult,
} from './helpers/mock-agent.mjs';

const ALL_AGENTS = ['claude', 'gemini', 'codex'];
const EXPECTED_TANDEM_PAIRS = {
  planning: { lead: 'claude', follow: 'codex' },
  architecture: { lead: 'claude', follow: 'gemini' },
  review: { lead: 'gemini', follow: 'claude' },
  refactor: { lead: 'claude', follow: 'codex' },
  implementation: { lead: 'claude', follow: 'codex' },
  analysis: { lead: 'gemini', follow: 'claude' },
  testing: { lead: 'codex', follow: 'gemini' },
  security: { lead: 'gemini', follow: 'claude' },
  research: { lead: 'gemini', follow: 'claude' },
  documentation: { lead: 'claude', follow: 'codex' },
};

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');
const LIB_DIR = path.join(PROJECT_ROOT, 'lib');
const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures', 'agent-responses');
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

const [claudeFixtures, geminiFixtures, codexFixtures] = await Promise.all([
  loadAgentFixture('claude'),
  loadAgentFixture('gemini'),
  loadAgentFixture('codex'),
]);

const mockExecuteAgent = createMockExecuteAgent({
  claude: claudeFixtures,
  gemini: geminiFixtures,
  codex: codexFixtures,
});

function assertExecuteResultShape(result) {
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.output, 'string');
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  assert.ok(result.error === null || typeof result.error === 'string');
  assert.ok(typeof result.exitCode === 'number' || result.exitCode === null);
  assert.equal(result.signal, null);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(result.timedOut, false);
}

async function withNoProcessSpawning(run) {
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  const spawnCalls = [];

  childProcess.spawn = (...args) => {
    spawnCalls.push({ method: 'spawn', args });
    throw new Error('Unexpected child_process.spawn during in-process pipeline test');
  };
  childProcess.spawnSync = (...args) => {
    spawnCalls.push({ method: 'spawnSync', args });
    throw new Error('Unexpected child_process.spawnSync during in-process pipeline test');
  };

  try {
    await run();
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }

  assert.deepEqual(spawnCalls, [], 'simulated mock-agent flows must not spawn child processes');
}

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(entryPath);
    }
    return [entryPath];
  }));
  return files.flat();
}

test('fixture JSON stays static, hand-authored, and compact', async () => {
  const fixtureFiles = ['claude.json', 'gemini.json', 'codex.json'];
  let totalBytes = 0;

  for (const fileName of fixtureFiles) {
    const filePath = path.join(FIXTURE_DIR, fileName);
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    totalBytes += Buffer.byteLength(raw);

    assert.equal(Array.isArray(parsed), true, `${fileName} must export an array`);
    assert.ok(parsed.length >= 3, `${fileName} must contain at least three fixture entries`);
    assert.ok(
      parsed.some((entry) => entry.matchPattern === null),
      `${fileName} must include a null-matchPattern default entry`
    );
    assert.ok(
      parsed.some((entry) => entry.matchPattern && entry.response?.ok === true),
      `${fileName} must include a prompt-matched success entry`
    );
    assert.ok(
      parsed.some((entry) => entry.response?.ok === false),
      `${fileName} must include a failure entry`
    );
  }

  assert.ok(totalBytes < 50 * 1024, 'fixture JSON should stay below 50KB total');
});

test('loadAgentFixture resolves all static agent fixture sets with validated defaults', () => {
  assert.equal(Array.isArray(claudeFixtures), true);
  assert.equal(Array.isArray(geminiFixtures), true);
  assert.equal(Array.isArray(codexFixtures), true);
  assert.ok(claudeFixtures.length >= 3);
  assert.ok(geminiFixtures.length >= 3);
  assert.ok(codexFixtures.length >= 3);
  assert.equal(claudeFixtures.find((entry) => entry.id === 'default')?.matchPattern, null);
  assert.equal(geminiFixtures.find((entry) => entry.id === 'default')?.matchPattern, null);
  assert.equal(codexFixtures.find((entry) => entry.id === 'default')?.matchPattern, null);
  assert.equal(claudeFixtures.find((entry) => entry.id === 'architecture')?.matchPattern instanceof RegExp, true);
  assert.equal(geminiFixtures.find((entry) => entry.id === 'review')?.matchPattern instanceof RegExp, true);
  assert.equal(codexFixtures.find((entry) => entry.id === 'implementation')?.matchPattern instanceof RegExp, true);
});

test('mock-agent helper exports the expected callable helpers', () => {
  assert.equal(typeof createMockExecuteAgent, 'function');
  assert.equal(createMockExecuteAgent.length, 1);
  assert.equal(typeof loadAgentFixture, 'function');
  assert.equal(loadAgentFixture.length, 1);
  assert.equal(typeof makeSuccessResult, 'function');
  assert.equal(makeSuccessResult.length, 1);
  assert.equal(typeof makeFailureResult, 'function');
  assert.equal(makeFailureResult.length, 1);
});

test('mock agent helper is never imported from production modules', async () => {
  const productionFiles = (await walkFiles(LIB_DIR)).filter((filePath) => filePath.endsWith('.mjs'));

  assert.ok(productionFiles.length > 0, 'expected to scan production .mjs files');

  for (const filePath of productionFiles) {
    const source = await fs.readFile(filePath, 'utf8');
    assert.equal(
      /(?:\.\/|\.\.\/).*mock-agent\.mjs|helpers[\\/]+mock-agent\.mjs|mock-agent\.mjs/.test(source),
      false,
      `production module must not import test helper: ${path.relative(PROJECT_ROOT, filePath)}`
    );
  }
});

describe('mock result factories', () => {
  it('builds the full executeAgent-compatible success shape', () => {
    const result = makeSuccessResult('successful output', {
      tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });

    assertExecuteResultShape(result);
    assert.deepEqual(result, {
      ok: true,
      output: 'successful output',
      stdout: 'successful output',
      stderr: '',
      error: null,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  it('builds the full executeAgent-compatible failure shape', () => {
    const result = makeFailureResult('synthetic failure', {
      errorCategory: 'permission',
      exitCode: 9,
    });

    assertExecuteResultShape(result);
    assert.deepEqual(result, {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'synthetic failure',
      error: 'synthetic failure',
      exitCode: 9,
      signal: null,
      durationMs: 1,
      timedOut: false,
      errorCategory: 'permission',
    });
  });
});

describe('classifyPrompt route strategy', () => {
  it('routes a short action prompt through the single-agent path', () => {
    const result = classifyPrompt('fix the typo in README.md');

    assert.equal(result.routeStrategy, 'single');
    assert.equal(result.tandemPair, null);
    assert.equal(result.taskType, 'documentation');
  });

  it('routes a two-phase prompt through the tandem path', () => {
    const result = classifyPrompt('first analyze the auth module then fix the security issues');

    assert.equal(result.routeStrategy, 'tandem');
    assert.deepEqual(result.tandemPair, { lead: 'gemini', follow: 'claude' });
  });

  it('routes a strategic multi-objective prompt through the council path', () => {
    const prompt = [
      'Should we redesign the dispatch pipeline?',
      'Compare single, tandem, and council routing trade-offs.',
      'Decide which strategy is best for reliability.',
      'Make sure we optimize for developer productivity and failure recovery.',
    ].join(' ');

    const result = classifyPrompt(prompt);

    assert.equal(result.routeStrategy, 'council');
    assert.equal(result.tandemPair, null);
    assert.equal(result.tier, 'complex');
  });

  it('is deterministic for identical input', () => {
    const prompt = 'first analyze the auth module then fix the security issues';

    assert.deepEqual(classifyPrompt(prompt), classifyPrompt(prompt));
  });

  it('handles a prompt on the simple/moderate boundary without throwing', () => {
    const prompt = 'fix auth bug in lib/hydra-utils.mjs before release with focused regression tests today';

    assert.doesNotThrow(() => classifyPrompt(prompt));
    const result = classifyPrompt(prompt);

    assert.ok(['simple', 'moderate', 'complex'].includes(result.tier));
    assert.ok(['single', 'tandem', 'council'].includes(result.routeStrategy));
  });

  it('returns a valid classification object for an empty prompt', () => {
    const result = classifyPrompt('');

    assert.equal(result.tier, 'moderate');
    assert.equal(result.taskType, 'implementation');
    assert.equal(result.suggestedAgent, 'claude');
    assert.equal(typeof result.reason, 'string');
  });
});

describe('selectTandemPair agent pair resolution', () => {
  for (const [taskType, expectedPair] of Object.entries(EXPECTED_TANDEM_PAIRS)) {
    it(`returns ${expectedPair.lead}/${expectedPair.follow} for ${taskType}`, () => {
      assert.deepEqual(
        selectTandemPair(taskType, expectedPair.lead, ALL_AGENTS),
        expectedPair
      );
    });
  }
});

describe('mock agent invocation', () => {
  it('returns the default fixture for an unknown prompt', async () => {
    const result = await mockExecuteAgent('claude', 'unknown random prompt', {});

    assertExecuteResultShape(result);
    assert.equal(result.ok, true);
    assert.match(result.output, /default summary/i);
  });

  it('returns the prompt-matched fixture when the prompt hits a regex', async () => {
    const result = await mockExecuteAgent('claude', 'design the system architecture', {});

    assertExecuteResultShape(result);
    assert.equal(result.ok, true);
    assert.match(result.output, /architecture review/i);
  });

  it('propagates failure fixtures with the full executeAgent result shape', async () => {
    const result = await mockExecuteAgent('gemini', 'trigger_rate_limit', {});

    assertExecuteResultShape(result);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorCategory, 'rate-limit');
    assert.equal(result.error, 'Error: 429 Too Many Requests');
    assert.match(result.stderr, /429/i);
  });

  it('returns codex token usage when the selected fixture includes it', async () => {
    const result = await mockExecuteAgent('codex', 'implement the feature', {});

    assertExecuteResultShape(result);
    assert.equal(result.ok, true);
    assert.deepEqual(result.tokenUsage, {
      inputTokens: 220,
      outputTokens: 140,
      totalTokens: 360,
    });
  });

  it('accepts execution options without using them internally', async () => {
    const result = await mockExecuteAgent('codex', 'write the implementation', {
      cwd: process.cwd(),
      permissionMode: 'read-only',
      timeoutMs: 25_000,
    });

    assertExecuteResultShape(result);
    assert.equal(result.ok, true);
  });

  it('returns a deep-cloned result object on every call', async () => {
    const first = await mockExecuteAgent('codex', 'implement the feature', {});
    const second = await mockExecuteAgent('codex', 'implement the feature', {});

    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.tokenUsage, second.tokenUsage);

    first.output = 'mutated';
    first.tokenUsage.totalTokens = 999;

    const third = await mockExecuteAgent('codex', 'implement the feature', {});
    assert.equal(second.output, 'Implementation result: added the requested behavior, covered the main edge cases, and kept the changes scoped to the documented entry points.');
    assert.equal(second.tokenUsage.totalTokens, 360);
    assert.equal(third.output, 'Implementation result: added the requested behavior, covered the main edge cases, and kept the changes scoped to the documented entry points.');
    assert.equal(third.tokenUsage.totalTokens, 360);
  });

  it('throws for unknown agents instead of returning undefined', async () => {
    await assert.rejects(
      mockExecuteAgent('wizard', 'cast a spell', {}),
      /Unknown mock agent "wizard"/
    );
  });

  it('throws immediately when a fixture map is missing a default entry', () => {
    assert.throws(
      () => createMockExecuteAgent({
        claude: [
          {
            id: 'only',
            matchPattern: 'implement',
            response: makeSuccessResult('No default fixture here'),
          },
        ],
      }),
      /default entry with matchPattern null/i
    );
  });

  it('uses first-match-wins when multiple regex fixtures match the same prompt', async () => {
    const customExec = createMockExecuteAgent({
      claude: [
        {
          id: 'default',
          matchPattern: null,
          response: makeSuccessResult('fallback'),
        },
        {
          id: 'broad',
          matchPattern: 'implement',
          response: makeSuccessResult('broad match wins'),
        },
        {
          id: 'specific',
          matchPattern: 'implement the feature',
          response: makeSuccessResult('specific match loses because it is later'),
        },
      ],
    });

    const result = await customExec('claude', 'implement the feature', {});

    assert.equal(result.output, 'broad match wins');
  });

  it('supports failure factories for ad hoc fixture maps', async () => {
    const customExec = createMockExecuteAgent({
      codex: [
        {
          id: 'default',
          matchPattern: null,
          response: makeFailureResult('synthetic failure', { errorCategory: 'runtime' }),
        },
      ],
    });

    const result = await customExec('codex', 'anything', {});

    assertExecuteResultShape(result);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'runtime');
  });
});

describe('dispatch pipeline integration', () => {
  it('simulates a full single-route pipeline in process', async () => {
    await withNoProcessSpawning(async () => {
      const prompt = 'fix the typo in README.md';
      const classification = classifyPrompt(prompt);

      assert.equal(classification.routeStrategy, 'single');
      assert.equal(classification.tandemPair, null);

      const result = await mockExecuteAgent(classification.suggestedAgent, prompt, {});
      const report = {
        routeStrategy: classification.routeStrategy,
        taskType: classification.taskType,
        tandemPair: classification.tandemPair,
        invocation: {
          agent: classification.suggestedAgent,
          ok: result.ok,
          exitCode: result.exitCode,
        },
      };

      assertExecuteResultShape(result);
      assert.deepEqual(report, {
        routeStrategy: 'single',
        taskType: 'documentation',
        tandemPair: null,
        invocation: {
          agent: 'claude',
          ok: true,
          exitCode: 0,
        },
      });
    });
  });

  it('simulates a full tandem pipeline with a threaded lead result', async () => {
    await withNoProcessSpawning(async () => {
      const prompt = 'first analyze the auth module then fix the security issues';
      const classification = classifyPrompt(prompt);
      const tandemPair = selectTandemPair(classification.taskType, classification.suggestedAgent, ALL_AGENTS);

      assert.equal(classification.routeStrategy, 'tandem');
      assert.deepEqual(tandemPair, { lead: 'gemini', follow: 'claude' });

      const leadResult = await mockExecuteAgent(tandemPair.lead, prompt, {});
      const followPrompt = `${leadResult.output}\n\n[follow]\n${prompt}`;
      const followResult = await mockExecuteAgent(tandemPair.follow, followPrompt, {});
      const report = {
        routeStrategy: classification.routeStrategy,
        taskType: classification.taskType,
        stages: [
          { agent: tandemPair.lead, ok: leadResult.ok, exitCode: leadResult.exitCode },
          {
            agent: tandemPair.follow,
            ok: followResult.ok,
            exitCode: followResult.exitCode,
            receivedLeadOutput: followPrompt.includes(leadResult.output),
          },
        ],
      };

      assertExecuteResultShape(leadResult);
      assertExecuteResultShape(followResult);
      assert.deepEqual(report, {
        routeStrategy: 'tandem',
        taskType: 'security',
        stages: [
          { agent: 'gemini', ok: true, exitCode: 0 },
          { agent: 'claude', ok: true, exitCode: 0, receivedLeadOutput: true },
        ],
      });
    });
  });

  it('classifies a council prompt without a tandem pair or any mock invocation', async () => {
    await withNoProcessSpawning(async () => {
      const prompt = [
        'Should we redesign the dispatch pipeline?',
        'Compare single, tandem, and council routing trade-offs.',
        'Decide which strategy is best for reliability.',
        'Make sure we optimize for developer productivity and failure recovery.',
      ].join(' ');

      const result = classifyPrompt(prompt);

      assert.equal(result.routeStrategy, 'council');
      assert.equal(result.tandemPair, null);
    });
  });
});
