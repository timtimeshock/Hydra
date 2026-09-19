#!/usr/bin/env node
/**
 * Hydra Self Snapshot — canonical structured "who/what am I right now?" view.
 *
 * Used by:
 * - Daemon: GET /self
 * - MCP:    hydra://self
 * - Operator: :self command
 *
 * Intentionally "best effort": failures (no git, no package.json, etc.) should
 * degrade to nulls rather than throwing.
 */

import fs from 'fs';
import path from 'path';
import { HYDRA_ROOT, HYDRA_RUNTIME_ROOT, loadHydraConfig } from './hydra-config.mjs';
import { getModelSummary, listAgents } from './hydra-agents.mjs';
import { getMetricsSummary } from './hydra-metrics.mjs';
import { spawnSyncCapture } from './hydra-proc.mjs';

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function gitExec(cwd, args) {
  const r = spawnSyncCapture('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) {
    throw new Error(String(r.stderr || r.stdout || r.error?.message || 'git error').trim());
  }
  return String(r.stdout || '').trim();
}

/**
 * Best-effort git info for a directory.
 * Returns null if not a git repo or git is unavailable.
 * @param {string} cwd
 */
export function getGitInfo(cwd) {
  if (!cwd) return null;
  try {
    const branch = gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const commit = gitExec(cwd, ['rev-parse', '--short', 'HEAD']);
    const porcelain = gitExec(cwd, ['status', '--porcelain']);
    const modifiedFiles = porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0;
    return {
      branch,
      commit,
      dirty: modifiedFiles > 0,
      modifiedFiles,
    };
  } catch {
    return null;
  }
}

export function getHydraPackageInfo() {
  const pkg = readJsonSafe(path.join(HYDRA_ROOT, 'package.json')) || {};
  return {
    name: pkg.name || 'hydra',
    version: pkg.version || 'unknown',
    description: pkg.description || '',
  };
}

/**
 * Build a structured self snapshot.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] - Current target project root (daemon/operator context)
 * @param {string} [opts.projectName] - Optional friendly project name
 * @param {boolean} [opts.includeAgents=false]
 * @param {boolean} [opts.includeConfig=true]
 * @param {boolean} [opts.includeMetrics=true]
 * @returns {object}
 */
export function buildSelfSnapshot(opts = {}) {
  const {
    projectRoot = '',
    projectName = '',
    includeAgents = false,
    includeConfig = true,
    includeMetrics = true,
  } = opts;

  const hydraPkg = getHydraPackageInfo();
  const cfg = includeConfig ? safeCall(() => loadHydraConfig(), null) : null;
  const models = safeCall(() => getModelSummary(), null);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    hydra: {
      ...hydraPkg,
      root: HYDRA_ROOT,
      runtimeRoot: HYDRA_RUNTIME_ROOT,
      packaged: Boolean(process.pkg),
      node: process.version,
      platform: process.platform,
      pid: process.pid,
    },
    git: {
      hydra: getGitInfo(HYDRA_ROOT),
      project: projectRoot ? getGitInfo(projectRoot) : null,
    },
    project: {
      name: projectName || (projectRoot ? path.basename(projectRoot) : 'unknown'),
      root: projectRoot || '',
    },
    models,
  };

  if (cfg) {
    snapshot.config = {
      mode: cfg.mode || 'performance',
      concierge: cfg.concierge
        ? {
            enabled: cfg.concierge.enabled !== false,
            model: cfg.concierge.model || null,
            reasoningEffort: cfg.concierge.reasoningEffort || null,
            fallbackChain: Array.isArray(cfg.concierge.fallbackChain) ? cfg.concierge.fallbackChain : [],
          }
        : null,
      verification: cfg.verification
        ? {
            onTaskDone: cfg.verification.onTaskDone !== false,
            command: cfg.verification.command ?? 'auto',
            timeoutMs: cfg.verification.timeoutMs ?? null,
            secretsScan: cfg.verification.secretsScan !== false,
          }
        : null,
      modelRecovery: cfg.modelRecovery ? { enabled: cfg.modelRecovery.enabled !== false } : null,
      workers: cfg.workers ? { enabled: cfg.workers.enabled !== false } : null,
    };
  }

  if (includeMetrics) {
    snapshot.metrics = safeCall(() => getMetricsSummary(), null);
  }

  if (includeAgents) {
    snapshot.agents = safeCall(() => listAgents(), null);
  }

  return snapshot;
}

function truncateLines(text, maxLines) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
}

/**
 * Format a snapshot into a bounded text block for LLM prompt injection.
 * @param {object} snapshot
 * @param {object} [opts]
 * @param {number} [opts.maxLines=80]
 */
export function formatSelfSnapshotForPrompt(snapshot, opts = {}) {
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 80;
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const lines = [];

  lines.push('=== HYDRA SELF SNAPSHOT ===');
  if (s.hydra) {
    lines.push(`Hydra: ${s.hydra.name || 'hydra'} v${s.hydra.version || 'unknown'}`);
    if (s.hydra.root) lines.push(`Hydra root: ${s.hydra.root}`);
    if (s.hydra.node) lines.push(`Node: ${s.hydra.node} (${s.hydra.platform || ''})`);
  }

  const hg = s.git?.hydra;
  if (hg) {
    lines.push(`Hydra git: ${hg.branch}@${hg.commit}${hg.dirty ? ` (+${hg.modifiedFiles} dirty)` : ''}`);
  }

  if (s.project?.root) {
    lines.push(`Project: ${s.project.name || 'unknown'} (${s.project.root})`);
  }

  const pg = s.git?.project;
  if (pg) {
    lines.push(`Project git: ${pg.branch}@${pg.commit}${pg.dirty ? ` (+${pg.modifiedFiles} dirty)` : ''}`);
  }

  const mode = s.config?.mode;
  if (mode) {
    lines.push(`Mode: ${mode}`);
  }

  if (s.models && typeof s.models === 'object') {
    lines.push('Models:');
    for (const [agent, info] of Object.entries(s.models)) {
      if (agent === '_mode') continue;
      if (!info || typeof info !== 'object') continue;
      const active = info.active || 'unknown';
      const src = info.tierSource ? ` (${info.tierSource})` : '';
      lines.push(`- ${agent}: ${active}${src}`);
    }
  }

  lines.push('=== END SNAPSHOT ===');
  return truncateLines(lines.join('\n'), maxLines);
}
