#!/usr/bin/env node
/**
 * HYDRA.md sync — parses a single HYDRA.md and generates per-agent instruction files.
 *
 * HYDRA.md format:
 *   - All content before the first `## @agent` heading is shared (goes to every agent).
 *   - `## @claude`, `## @gemini`, `## @codex` route content to that agent only.
 *   - Any other `## Heading` (no `@` prefix) is also shared.
 *
 * Generated files carry an auto-generated header and should not be hand-edited.
 */

import fs from 'fs';
import path from 'path';

/** Maps agent name → the filename that agent's CLI reads. */
export const AGENT_FILES = {
  claude: 'CLAUDE.md',
  gemini: 'GEMINI.md',
  codex:  'AGENTS.md',
};

const GENERATED_HEADER = '<!-- Auto-generated from HYDRA.md \u2014 do not edit directly. -->\n\n';
const AGENT_HEADING_RE = /^## @(claude|gemini|codex)\s*$/;

/**
 * Parse HYDRA.md content into shared + per-agent sections.
 *
 * @param {string} content  Raw HYDRA.md text
 * @returns {{ shared: string, agents: { claude: string, gemini: string, codex: string } }}
 */
export function parseHydraMd(content) {
  const lines = content.split(/\r?\n/);
  const shared = [];
  const agents = { claude: [], gemini: [], codex: [] };
  let currentTarget = 'shared'; // 'shared' | 'claude' | 'gemini' | 'codex'

  for (const line of lines) {
    // Check for ## @agent heading
    const agentMatch = line.match(AGENT_HEADING_RE);
    if (agentMatch) {
      currentTarget = agentMatch[1];
      continue;
    }

    // Any other ## heading (not @agent) switches back to shared
    if (/^## /.test(line) && currentTarget !== 'shared') {
      currentTarget = 'shared';
    }

    if (currentTarget === 'shared') {
      shared.push(line);
    } else {
      agents[currentTarget].push(line);
    }
  }

  return {
    shared: shared.join('\n').trim(),
    agents: {
      claude: agents.claude.join('\n').trim(),
      gemini: agents.gemini.join('\n').trim(),
      codex:  agents.codex.join('\n').trim(),
    },
  };
}

/**
 * Assemble the full output file content for one agent.
 *
 * @param {'claude'|'gemini'|'codex'} agent
 * @param {{ shared: string, agents: { claude: string, gemini: string, codex: string } }} parsed
 * @returns {string}
 */
export function buildAgentFile(agent, parsed) {
  const parts = [GENERATED_HEADER];
  if (parsed.shared) parts.push(parsed.shared);
  if (parsed.agents[agent]) {
    if (parsed.shared) parts.push('');
    parts.push(parsed.agents[agent]);
  }
  return parts.join('\n').trimEnd() + '\n';
}

/**
 * Check whether HYDRA.md exists in the given project root.
 */
export function hasHydraMd(projectRoot) {
  return fs.existsSync(path.join(projectRoot, 'HYDRA.md'));
}

/**
 * Return the instruction filename that `agent` should read in `projectRoot`.
 * If HYDRA.md exists, returns the agent-specific generated file; otherwise falls back to CLAUDE.md.
 */
export function getAgentInstructionFile(agent, projectRoot) {
  if (hasHydraMd(projectRoot)) {
    return AGENT_FILES[agent] || 'CLAUDE.md';
  }
  return 'CLAUDE.md';
}

/**
 * Parse HYDRA.md and write all three agent instruction files.
 * Idempotent: skips writes when HYDRA.md is not newer than the generated files.
 *
 * @param {string} projectRoot
 * @returns {{ synced: string[], skipped: boolean }}
 */
export function syncHydraMd(projectRoot) {
  const hydraMdPath = path.join(projectRoot, 'HYDRA.md');

  if (!fs.existsSync(hydraMdPath)) {
    return { synced: [], skipped: true };
  }

  // Mtime check — skip if all agent files are newer than HYDRA.md
  let hydraMtime;
  try {
    hydraMtime = fs.statSync(hydraMdPath).mtimeMs;
  } catch {
    return { synced: [], skipped: true };
  }

  const allFresh = Object.values(AGENT_FILES).every((file) => {
    try {
      return fs.statSync(path.join(projectRoot, file)).mtimeMs >= hydraMtime;
    } catch {
      return false; // file doesn't exist yet → need to generate
    }
  });

  if (allFresh) {
    return { synced: [], skipped: false };
  }

  const content = fs.readFileSync(hydraMdPath, 'utf8');
  const parsed = parseHydraMd(content);
  const synced = [];

  for (const [agent, filename] of Object.entries(AGENT_FILES)) {
    const outPath = path.join(projectRoot, filename);
    const generated = buildAgentFile(agent, parsed);

    // Only write if content actually differs
    let existing = '';
    try { existing = fs.readFileSync(outPath, 'utf8'); } catch { /* doesn't exist */ }

    // Skip hand-maintained files (those without the auto-generated header)
    if (existing && !existing.startsWith('<!-- Auto-generated from HYDRA.md')) {
      continue;
    }

    if (existing !== generated) {
      fs.writeFileSync(outPath, generated, 'utf8');
      synced.push(filename);
    }
  }

  return { synced, skipped: false };
}
