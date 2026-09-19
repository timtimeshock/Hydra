#!/usr/bin/env node
/**
 * Short live probe: one tiny prompt per CLI agent. No Council.
 * Prints ok/fail + duration + a short answer/error. No secrets.
 */
import '../lib/hydra-env.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeAgent, extractAgentAnswer } from '../lib/hydra-shared/agent-executor.mjs';
import { getActiveModel } from '../lib/hydra-agents.mjs';
import { HYDRA_ROOT } from '../lib/hydra-config.mjs';

const PROMPT = 'Odpověz přesně jedním slovem: OK. Žádné nástroje, žádný další text.';
const TIMEOUT_MS = 90_000;

function scrub(s) {
  return String(s || '')
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, 'AIza…')
    .replace(/\bAQ\.[A-Za-z0-9_-]{8,}/g, 'AQ.…')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer …')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'email')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function hasFile(...parts) {
  try {
    return fs.existsSync(path.join(os.homedir(), ...parts));
  } catch {
    return false;
  }
}

async function probe(agent) {
  const model = getActiveModel(agent) || '?';
  const started = Date.now();
  process.stderr.write(`\n--- ${agent} (${model}) ---\n`);
  try {
    const result = await executeAgent(agent, PROMPT, {
      cwd: HYDRA_ROOT,
      timeoutMs: TIMEOUT_MS,
      useStdin: true,
      permissionMode: 'plan',
      progressIntervalMs: 15_000,
      onProgress: (elapsed) => {
        process.stderr.write(`  … ${agent} ${Math.round(elapsed / 1000)}s\n`);
      },
    });
    const answer = scrub(extractAgentAnswer(result.output || result.stdout || ''));
    const err = scrub(result.error || '');
    const readable = Boolean(answer) && !/is_error|invalid_request|Missing or invalid API key|project ID/i.test(answer);
    return {
      agent,
      model,
      ok: Boolean(result.ok) && readable,
      cliOk: Boolean(result.ok),
      timedOut: Boolean(result.timedOut),
      durationMs: result.durationMs ?? (Date.now() - started),
      answer: answer || '',
      error: err,
      exitCode: result.exitCode ?? null,
    };
  } catch (err) {
    return {
      agent,
      model,
      ok: false,
      cliOk: false,
      timedOut: false,
      durationMs: Date.now() - started,
      answer: '',
      error: scrub(err.message),
      exitCode: null,
    };
  }
}

const login = {
  claude_bedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
  gemini_oauth: hasFile('.gemini', 'oauth_creds.json'),
  codex_auth: hasFile('.codex', 'auth.json'),
};

console.log('login', JSON.stringify(login));
const rows = [];
for (const agent of ['claude', 'gemini', 'codex']) {
  rows.push(await probe(agent));
}

for (const row of rows) {
  console.log(JSON.stringify({
    agent: row.agent,
    model: row.model,
    ok: row.ok,
    cliOk: row.cliOk,
    timedOut: row.timedOut,
    sec: Math.round(row.durationMs / 1000),
    answer: row.answer,
    error: row.error,
    exitCode: row.exitCode,
  }));
}

const passed = rows.filter((r) => r.ok).length;
console.log(`VERDICT ${passed}/3`);
process.exit(passed === 3 ? 0 : 1);
