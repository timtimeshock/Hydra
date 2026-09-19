import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HELPERS_DIR, '../fixtures/agent-responses');

function deepClone(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function makeSuccessResult(output, opts = {}) {
  const text = String(output ?? '');
  return {
    ok: true,
    output: text,
    stdout: text,
    stderr: '',
    error: null,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    ...deepClone(opts),
  };
}

export function makeFailureResult(error, opts = {}) {
  const text = String(error ?? 'Mock execution failed');
  return {
    ok: false,
    output: '',
    stdout: '',
    stderr: text,
    error: text,
    exitCode: 1,
    signal: null,
    durationMs: 1,
    timedOut: false,
    ...deepClone(opts),
  };
}

function normalizeFixtureEntry(agent, entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Fixture entry ${index} for ${agent} must be an object`);
  }

  const id = String(entry.id || `entry-${index}`);
  const { matchPattern } = entry;

  if (matchPattern !== null && typeof matchPattern !== 'string' && !(matchPattern instanceof RegExp)) {
    throw new Error(`Fixture entry "${id}" for ${agent} must use a string, RegExp, or null matchPattern`);
  }

  if (!entry.response || typeof entry.response !== 'object') {
    throw new Error(`Fixture entry "${id}" for ${agent} must include a response object`);
  }

  return {
    ...entry,
    id,
    response: deepClone(entry.response),
    matchPattern: matchPattern === null
      ? null
      : matchPattern instanceof RegExp
        ? matchPattern
        : new RegExp(matchPattern, 'i'),
  };
}

function validateFixtures(agent, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Fixture list for ${agent} must be a non-empty array`);
  }

  const normalized = entries.map((entry, index) => normalizeFixtureEntry(agent, entry, index));
  const defaultEntry = normalized.find((entry) => entry.id === 'default');
  const nullMatchEntries = normalized.filter((entry) => entry.matchPattern === null);

  if (!defaultEntry || defaultEntry.matchPattern !== null) {
    throw new Error(`Fixture list for ${agent} must include a default entry with matchPattern null (id "default")`);
  }

  if (nullMatchEntries.length !== 1) {
    throw new Error(`Fixture list for ${agent} must contain exactly one default entry with matchPattern null`);
  }

  return normalized;
}

function cloneResult(result) {
  const cloned = deepClone(result);
  if (cloned.error === undefined) {
    cloned.error = cloned.ok ? null : cloned.stderr || 'Mock execution failed';
  }
  return cloned;
}

function normalizeResponse(response) {
  const output = String(response.output ?? '');
  const error = response.error ?? response.stderr ?? 'Mock execution failed';

  return cloneResult(
    response.ok
      ? makeSuccessResult(output, response)
      : makeFailureResult(String(error), response)
  );
}

export async function loadAgentFixture(agent) {
  const fixturePath = path.join(FIXTURES_DIR, `${agent}.json`);
  try {
    const raw = await fs.readFile(fixturePath, 'utf8');
    const parsed = JSON.parse(raw);
    return validateFixtures(agent, parsed);
  } catch (error) {
    throw new Error(`Unable to load mock fixture for ${agent} from ${fixturePath}: ${error.message}`, {
      cause: error,
    });
  }
}

export function createMockExecuteAgent(fixtureMap) {
  if (!fixtureMap || typeof fixtureMap !== 'object') {
    throw new Error('createMockExecuteAgent requires a fixture map object');
  }

  const validatedMap = Object.fromEntries(
    Object.entries(fixtureMap).map(([agent, entries]) => [agent, validateFixtures(agent, entries)])
  );

  return async function mockExecuteAgent(agent, prompt, opts = {}) {
    void opts;

    const fixtures = validatedMap[agent];
    if (!fixtures) {
      throw new Error(`Unknown mock agent "${agent}"`);
    }

    const promptText = String(prompt ?? '');
    const matched = fixtures.find((entry) => entry.matchPattern instanceof RegExp && entry.matchPattern.test(promptText));
    const fallback = fixtures.find((entry) => entry.id === 'default');
    const selected = matched || fallback;

    if (!selected) {
      throw new Error(`No default fixture available for ${agent}`);
    }

    return normalizeResponse(selected.response);
  };
}
