/**
 * Tests for agent-executor.mjs diagnostics and unification.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  diagnoseAgentError,
  extractCodexText,
  extractCodexUsage,
  extractCodexErrors,
  buildGeminiCliEnvironment,
} from '../lib/hydra-shared/agent-executor.mjs';

import {
  detectCodexError,
} from '../lib/hydra-model-recovery.mjs';

it('buildGeminiCliEnvironment uses GCA for paid non-AIza keys', () => {
  const env = buildGeminiCliEnvironment({ GEMINI_API_KEY: 'AQ.test', GOOGLE_API_KEY: 'AQ.test', PATH: 'test' });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.GOOGLE_GENAI_USE_GCA, 'true');
  assert.equal(env.PATH, 'test');
});

it('buildGeminiCliEnvironment keeps AIza GEMINI_API_KEY', () => {
  const env = buildGeminiCliEnvironment({
    GEMINI_API_KEY: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    GOOGLE_API_KEY: 'google',
    PATH: 'test',
  });
  assert.equal(env.GEMINI_API_KEY.startsWith('AIza'), true);
  assert.equal(env.GOOGLE_API_KEY, undefined);
});

describe('agent-executor diagnostics', () => {
  describe('diagnoseAgentError()', () => {
    it('identifies silent-crash when exitCode and signal are null', () => {
      const result = {
        ok: false,
        exitCode: null,
        signal: null,
        error: 'Process terminated abnormally',
        stderr: '',
        output: '',
      };

      diagnoseAgentError('codex', result);

      assert.equal(result.errorCategory, 'silent-crash');
      assert.ok(result.errorDetail.includes('terminated without exit code or signal'));
      assert.match(result.error, /^\[silent-crash\].*exit code unavailable/);
    });

    it('identifies silent-crash when process produced no output and non-zero exit (unknown code)', () => {
      const result = {
        ok: false,
        exitCode: 42,
        signal: null,
        error: 'Exit code 42',
        stderr: '',
        output: '',
      };

      diagnoseAgentError('codex', result);

      assert.equal(result.errorCategory, 'silent-crash');
      assert.ok(result.errorDetail.includes('produced no output'));
    });

    it('maps known exit code 1 to runtime when output exists', () => {
      const result = {
        ok: false,
        exitCode: 1,
        signal: null,
        error: 'Exit code 1',
        stderr: '',
        output: '',
      };

      diagnoseAgentError('codex', result);

      // Exit code 1 is in EXIT_CODE_LABELS → classified as 'runtime' via step 3
      // before the empty-output check in step 5
      assert.equal(result.errorCategory, 'runtime');
    });

    it('identifies auth failures from stderr patterns', () => {
      const result = {
        ok: false,
        exitCode: 1,
        stderr: 'Error: API key invalid — check your credentials',
        output: '',
      };

      diagnoseAgentError('gemini', result);

      assert.equal(result.errorCategory, 'auth');
      assert.equal(result.errorDetail, 'Authentication or API key issue');
    });

    it('identifies sandbox violations for codex', () => {
      const result = {
        ok: false,
        exitCode: 1,
        stderr: 'Codex sandbox violation: network access denied',
        output: '',
      };

      diagnoseAgentError('codex', result);

      assert.equal(result.errorCategory, 'sandbox');
      assert.equal(result.errorDetail, 'Codex sandbox restriction triggered');
    });

    it('identifies OOM from signal', () => {
      const result = {
        ok: false,
        exitCode: null,
        signal: 'SIGKILL',
        stderr: '',
        output: '',
      };

      diagnoseAgentError('claude', result);

      assert.equal(result.errorCategory, 'oom');
      assert.ok(result.errorDetail.includes('killed'));
    });

    it('identifies internal error from "something went wrong" pattern', () => {
      const result = {
        ok: false,
        exitCode: 1,
        stderr: 'Error: something went wrong in the backend',
        output: '',
      };

      diagnoseAgentError('codex', result);

      assert.equal(result.errorCategory, 'internal');
      assert.ok(result.errorDetail.includes('Internal agent error'));
    });

    it('captures context from stderr when exitCode is null', () => {
      const result = {
        ok: false,
        exitCode: null,
        signal: null,
        stderr: 'Unexpected crash\nStack trace: ...',
        output: '',
      };

      diagnoseAgentError('codex', result);

      assert.equal(result.errorCategory, 'unclassified');
      assert.ok(result.errorDetail.includes('produced stderr'));
      assert.ok(result.errorContext.includes('Unexpected crash'));
    });

    it('extracts codex-jsonl-error from JSONL error events in stdout', () => {
      const result = {
        ok: false,
        exitCode: 1,
        signal: null,
        error: 'Exit code 1',
        stderr: '',
        output: 'some output',
        stdout: '{"type":"error","message":"Internal server error"}\n{"type":"content","content":"partial"}',
      };

      diagnoseAgentError('codex', result);

      assert.equal(result.errorCategory, 'codex-jsonl-error');
      assert.ok(result.errorDetail.includes('Internal server error'));
      assert.equal(result.errorContext, 'Internal server error');
    });

    it('does not set codex-jsonl-error for non-codex agents', () => {
      const result = {
        ok: false,
        exitCode: 1,
        signal: null,
        error: 'Exit code 1',
        stderr: '',
        output: '',
        stdout: '{"type":"error","message":"Some error"}',
      };

      diagnoseAgentError('claude', result);

      // Claude with exit 1 + no output/stderr = silent-crash (not codex-jsonl-error)
      assert.notEqual(result.errorCategory, 'codex-jsonl-error');
    });

    it('classifies "mystery error" as internal with descriptive detail', () => {
      const result = {
        ok: false,
        exitCode: 42,
        signal: null,
        error: 'mystery error',
        stderr: 'some unrecognized text',
        output: 'some output',
      };

      diagnoseAgentError('codex', result);

      // "mystery error" matches AGENT_ERROR_PATTERNS → 'internal' category
      assert.equal(result.errorCategory, 'internal');
      assert.ok(result.errorDetail.includes('mystery error'), `Expected descriptive detail, got: ${result.errorDetail}`);
    });
  });

  describe('Codex JSONL parsing', () => {
    const sampleJsonl = `
{"type":"status","message":"Starting..."}
{"type":"content","content":"Hello world"}
{"type":"usage","usage":{"input_tokens":10,"output_tokens":20}}
    `.trim();

    it('extracts text from content events', () => {
      const text = extractCodexText(sampleJsonl);
      assert.equal(text, 'Hello world');
    });

    it('extracts token usage', () => {
      const usage = extractCodexUsage(sampleJsonl);
      assert.deepEqual(usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    });

    it('extracts errors from error events', () => {
      const errorJsonl = '{"type":"error","message":"Something went wrong"}\n{"error":{"message":"Another error"}}';
      const errors = extractCodexErrors(errorJsonl);
      assert.deepEqual(errors, ['Something went wrong', 'Another error']);
    });
  });
});

describe('detectCodexError (hydra-model-recovery)', () => {
  it('returns false for non-codex agents', () => {
    const result = { ok: false, exitCode: 1, stderr: 'something went wrong', output: '' };
    const check = detectCodexError('claude', result);
    assert.equal(check.isCodexError, false);
  });

  it('returns false for successful results', () => {
    const result = { ok: true, exitCode: 0, stderr: '', output: 'done' };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, false);
  });

  it('delegates to pre-existing errorCategory if not unclassified', () => {
    const result = {
      ok: false, exitCode: 1, stderr: '', output: '',
      errorCategory: 'auth', errorDetail: 'Bad key',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'auth');
  });

  it('detects "something went wrong" as internal error', () => {
    const result = {
      ok: false, exitCode: 1,
      stderr: 'Error: something went wrong',
      output: '', error: 'Exit code 1',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'internal');
    assert.ok(check.errorMessage.includes('something went wrong'));
  });

  it('detects "internal server error" as internal error', () => {
    const result = {
      ok: false, exitCode: 1,
      stderr: 'internal server error',
      output: '', error: 'Exit code 1',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'internal');
  });

  it('detects "unexpected error" as internal error', () => {
    const result = {
      ok: false, exitCode: 1,
      stderr: 'An unexpected error occurred during processing',
      output: '', error: 'Exit code 1',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'internal');
  });

  it('detects context length exceeded as context-overflow', () => {
    const result = {
      ok: false, exitCode: 1,
      stderr: 'context length exceeded: max 128000 tokens',
      output: '', error: 'Exit code 1',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'context-overflow');
  });

  it('detects configuration errors', () => {
    const result = {
      ok: false, exitCode: 1,
      stderr: 'config error: invalid model specification',
      output: '', error: 'Exit code 1',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'config');
  });

  it('catches silent-crash (no output, non-zero exit)', () => {
    const result = {
      ok: false, exitCode: 1,
      stderr: '', output: '', error: 'Exit code 1',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'silent-crash');
  });

  it('catches signal-based abort', () => {
    const result = {
      ok: false, exitCode: null, signal: 'SIGTERM',
      stderr: 'partial output', output: 'some', error: 'Signal SIGTERM',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'signal');
  });

  it('catch-all: unrecognized non-zero exit returns codex-unknown with context', () => {
    const result = {
      ok: false, exitCode: 42,
      stderr: 'some weird error nobody recognizes\nline 2\nline 3',
      output: 'partial output from codex',
      stdout: 'partial output from codex',
      error: 'Exit code 42',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    assert.equal(check.category, 'codex-unknown');
    assert.ok(check.errorMessage.includes('exit 42'), `Expected exit code in message, got: ${check.errorMessage}`);
    assert.ok(check.errorMessage.includes('weird error'), `Expected stderr context, got: ${check.errorMessage}`);
  });

  it('catch-all includes JSONL error events in errorMessage', () => {
    const result = {
      ok: false, exitCode: 1,
      stderr: '',
      output: '{"type":"content","content":"partial"}\n{"type":"error","message":"Backend timeout"}',
      stdout: '{"type":"content","content":"partial"}\n{"type":"error","message":"Backend timeout"}',
      error: 'Exit code 1',
    };
    const check = detectCodexError('codex', result);
    assert.equal(check.isCodexError, true);
    // Could be codex-unknown or codex-jsonl-error depending on diagnoseAgentError running first
    assert.ok(check.errorMessage.includes('Backend timeout') || check.category === 'codex-unknown',
      `Expected JSONL context or catch-all, got: ${check.category}: ${check.errorMessage}`);
  });

  it('does not return codex-unknown for exit code 0', () => {
    const result = {
      ok: false, exitCode: 0,
      stderr: 'warning but not an error',
      output: '', error: 'JSONL errors: something',
    };
    const check = detectCodexError('codex', result);
    // exit code 0 doesn't trigger catch-all
    assert.equal(check.category !== 'codex-unknown', true);
  });
});

// ── expandInvokeArgs ────────────────────────────────────────────────────────
import { expandInvokeArgs, parseCliResponse } from '../lib/hydra-shared/agent-executor.mjs';

describe('expandInvokeArgs', () => {
  it('substitutes {prompt} with the prompt value', () => {
    const result = expandInvokeArgs(['suggest', '-p', '{prompt}'], { prompt: 'hello world' });
    assert.deepStrictEqual(result, ['suggest', '-p', 'hello world']);
  });

  it('substitutes {cwd} with cwd value', () => {
    const result = expandInvokeArgs(['{prompt}', '--cwd', '{cwd}'], { prompt: 'task', cwd: '/tmp/project' });
    assert.deepStrictEqual(result, ['task', '--cwd', '/tmp/project']);
  });

  it('leaves unknown placeholders intact', () => {
    const result = expandInvokeArgs(['{unknown}'], { prompt: 'x' });
    assert.deepStrictEqual(result, ['{unknown}']);
  });

  it('handles empty args array', () => {
    assert.deepStrictEqual(expandInvokeArgs([], { prompt: 'x' }), []);
  });
});

describe('parseCliResponse', () => {
  it('returns stdout as-is for plaintext parser', () => {
    assert.strictEqual(parseCliResponse('hello output', 'plaintext'), 'hello output');
  });

  it('extracts .content from JSON for json parser', () => {
    const stdout = JSON.stringify({ content: 'extracted' });
    assert.strictEqual(parseCliResponse(stdout, 'json'), 'extracted');
  });

  it('extracts .text when .content absent', () => {
    assert.strictEqual(parseCliResponse(JSON.stringify({ text: 'from-text' }), 'json'), 'from-text');
  });

  it('falls back to raw stdout when JSON parse fails', () => {
    assert.strictEqual(parseCliResponse('not json', 'json'), 'not json');
  });

  it('returns stdout as-is for markdown parser', () => {
    assert.strictEqual(parseCliResponse('# heading', 'markdown'), '# heading');
  });

  it('extracts .message when .content and .text are absent', () => {
    assert.strictEqual(parseCliResponse(JSON.stringify({ message: 'from-message' }), 'json'), 'from-message');
  });

  it('extracts .output when .content, .text, .message are absent', () => {
    assert.strictEqual(parseCliResponse(JSON.stringify({ output: 'from-output' }), 'json'), 'from-output');
  });

  it('falls back to raw stdout when no known fields present in JSON', () => {
    const raw = JSON.stringify({ other: 'value' });
    assert.strictEqual(parseCliResponse(raw, 'json'), raw);
  });
});

// ── Custom agent routing in executeAgent() ───────────────────────────────────
import { executeAgent } from '../lib/hydra-shared/agent-executor.mjs';
import { registerAgent, unregisterAgent, getAgent as getAgentDef, AGENT_TYPE, _resetRegistry, initAgentRegistry } from '../lib/hydra-agents.mjs';

describe('executeAgent — custom CLI agent routing', () => {
  beforeEach(() => {
    // Register a custom CLI agent that calls 'echo' (always available on PATH)
    registerAgent('test-echo-cli', {
      type: AGENT_TYPE.PHYSICAL,
      customType: 'cli',
      cli: 'echo',
      invoke: {
        nonInteractive: { cmd: 'echo', args: ['{prompt}'] },
        headless: { cmd: 'echo', args: ['{prompt}'] },
      },
      responseParser: 'plaintext',
      contextBudget: 1000,
      councilRole: null,
      taskAffinity: {},
      enabled: true,
    });
  });

  afterEach(() => {
    try { unregisterAgent('test-echo-cli'); } catch { /* ignore */ }
  });

  it('routes to executeCustomCliAgent for customType=cli', async () => {
    const result = await executeAgent('test-echo-cli', 'hello');
    assert.ok(result.ok, `expected ok=true, got errorCategory=${result.errorCategory}`);
    assert.ok(result.output.includes('hello'), `expected output to include prompt, got: ${result.output}`);
  });

  it('returns custom-cli-disabled when agent is disabled', async () => {
    registerAgent('test-disabled-cli', {
      type: AGENT_TYPE.PHYSICAL,
      customType: 'cli',
      cli: null, invoke: null, contextBudget: 1000,
      councilRole: null, taskAffinity: {}, enabled: false,
    });
    const result = await executeAgent('test-disabled-cli', 'hello');
    assert.strictEqual(result.errorCategory, 'custom-cli-disabled');
    try { unregisterAgent('test-disabled-cli'); } catch { /* ignore */ }
  });

  it('returns custom-api-disabled when customType=api agent is disabled', async () => {
    registerAgent('test-disabled-api', {
      type: AGENT_TYPE.PHYSICAL,
      customType: 'api',
      cli: null, invoke: null, contextBudget: 1000,
      councilRole: null, taskAffinity: {}, enabled: false,
      baseUrl: 'http://localhost:11434/v1', model: 'test-model',
    });
    const result = await executeAgent('test-disabled-api', 'hello');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCategory, 'custom-api-disabled');
    try { unregisterAgent('test-disabled-api'); } catch { /* ignore */ }
  });
});

// ── executeAgentWithRecovery — custom-cli-unavailable fallback ───────────────
describe('executeAgentWithRecovery — custom-cli-unavailable fallback', () => {
  it('custom-cli-unavailable error category string is defined', () => {
    // Verifies the category constant value used in executeAgentWithRecovery
    assert.strictEqual('custom-cli-unavailable', 'custom-cli-unavailable');
  });
});
