/**
 * Hydra Cleanup — Scanners and executors for the :cleanup command.
 *
 * Finds stale/completed items across the system (daemon tasks, branches,
 * suggestions, artifacts) and provides executors to clean them up.
 * All scanners are fault-tolerant (return [] on error).
 */

import fs from 'fs';
import path from 'path';

// ── Scanners ─────────────────────────────────────────────────────────────────

/**
 * Scan for completed/cancelled daemon tasks that can be archived.
 * @param {string} baseUrl
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanArchivableTasks(baseUrl) {
  const items = [];
  try {
    const { request } = await import('./hydra-utils.mjs');
    const status = await request('GET', baseUrl, '/status');
    if (!status?.tasks) return items;

    for (const task of status.tasks) {
      if (task.status === 'done' || task.status === 'cancelled') {
        items.push({
          id: `archive-task-${task.id}`,
          title: `Archive ${task.status} task: ${task.title || task.id}`,
          description: `Status: ${task.status}, completed ${task.completedAt || 'recently'}`,
          category: 'archive',
          severity: 'low',
          source: 'daemon',
          meta: { taskId: task.id, daemonTask: task },
        });
      }
    }
  } catch { /* daemon unavailable */ }
  return items;
}

/**
 * Scan for old acknowledged handoffs.
 * @param {string} baseUrl
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanOldHandoffs(baseUrl) {
  const items = [];
  try {
    const { request } = await import('./hydra-utils.mjs');
    const status = await request('GET', baseUrl, '/status');
    if (!status?.handoffs) return items;

    const cutoffMs = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    for (const handoff of status.handoffs) {
      if (handoff.acknowledged) {
        const age = now - new Date(handoff.ts || handoff.createdAt || 0).getTime();
        if (age > cutoffMs) {
          items.push({
            id: `handoff-${handoff.id}`,
            title: `Old handoff: ${(handoff.summary || handoff.id).slice(0, 60)}`,
            description: `Acknowledged ${Math.round(age / 60000)}min ago`,
            category: 'archive',
            severity: 'low',
            source: 'daemon',
            meta: { handoffId: handoff.id },
          });
        }
      }
    }
  } catch { /* daemon unavailable */ }
  return items;
}

/**
 * Scan for unmerged feature branches (evolve/*, nightly/*, tasks/*).
 * @param {string} projectRoot
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanStaleBranches(projectRoot) {
  const items = [];
  try {
    const { listBranches, branchHasCommits } = await import('./hydra-shared/git-ops.mjs');

    for (const prefix of ['evolve', 'nightly', 'tasks']) {
      const branches = listBranches(projectRoot, prefix);
      for (const branch of branches) {
        const hasCommits = branchHasCommits(projectRoot, branch, 'dev');
        items.push({
          id: `branch-${branch}`,
          title: `${hasCommits ? 'Unmerged' : 'Empty'} branch: ${branch}`,
          description: hasCommits ? 'Has unmerged commits vs dev' : 'No commits beyond dev',
          category: 'delete',
          severity: hasCommits ? 'medium' : 'low',
          source: 'branches',
          meta: { branch, prefix, hasCommits },
        });
      }
    }
  } catch { /* git unavailable */ }
  return items;
}

/**
 * Scan for stale daemon tasks (in_progress but no update for 30+ min).
 * @param {string} baseUrl
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanStaleTasks(baseUrl) {
  const items = [];
  try {
    const { request } = await import('./hydra-utils.mjs');
    const status = await request('GET', baseUrl, '/status');
    if (!status?.tasks) return items;

    const cutoffMs = 30 * 60 * 1000;
    const now = Date.now();

    for (const task of status.tasks) {
      if (task.status === 'in_progress') {
        const lastUpdate = new Date(task.updatedAt || task.claimedAt || task.createdAt || 0).getTime();
        const age = now - lastUpdate;
        if (age > cutoffMs) {
          items.push({
            id: `stale-task-${task.id}`,
            title: `Stale task (${Math.round(age / 60000)}min): ${task.title || task.id}`,
            description: `In progress but no update for ${Math.round(age / 60000)} minutes`,
            category: 'requeue',
            severity: 'medium',
            source: 'daemon',
            meta: { taskId: task.id, daemonTask: task },
          });
        }
      }
    }
  } catch { /* daemon unavailable */ }
  return items;
}

/**
 * Scan for abandoned suggestions (old, multiple failed attempts).
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanAbandonedSuggestions() {
  const items = [];
  try {
    const { loadSuggestions, getPendingSuggestions } = await import('./hydra-evolve-suggestions.mjs');
    const sg = loadSuggestions();
    const pending = getPendingSuggestions(sg);

    for (const s of pending) {
      const attempts = s.attempts || 0;
      const maxAttempts = 3;
      if (attempts >= maxAttempts) {
        items.push({
          id: `suggestion-${s.id}`,
          title: `Abandoned suggestion: ${(s.title || s.id).slice(0, 60)}`,
          description: `${attempts} failed attempts, created ${s.createdAt || 'unknown'}`,
          category: 'cleanup',
          severity: 'low',
          source: 'suggestions',
          meta: { suggestionId: s.id, suggestion: s },
        });
      }
    }
  } catch { /* suggestions unavailable */ }
  return items;
}

/**
 * Scan for old council checkpoint files.
 * @param {string} projectRoot
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanOldCheckpoints(projectRoot) {
  const items = [];
  try {
    const coordDir = path.join(projectRoot, 'docs', 'coordination');
    if (!fs.existsSync(coordDir)) return items;

    // Council checkpoints
    const councilDir = path.join(coordDir, 'council');
    if (fs.existsSync(councilDir)) {
      const files = fs.readdirSync(councilDir).filter((f) => f.endsWith('.json'));
      const cutoffMs = 7 * 24 * 60 * 60 * 1000; // 7 days
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(councilDir, file);
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > cutoffMs) {
          items.push({
            id: `checkpoint-${file}`,
            title: `Old checkpoint: ${file}`,
            description: `Last modified ${Math.round(age / (24 * 60 * 60 * 1000))} days ago`,
            category: 'delete',
            severity: 'low',
            source: 'checkpoints',
            meta: { filePath, file },
          });
        }
      }
    }
  } catch { /* fs unavailable */ }
  return items;
}

/**
 * Scan for large/old coordination artifacts (logs, reports).
 * @param {string} projectRoot
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function scanOldArtifacts(projectRoot) {
  const items = [];
  try {
    const coordDir = path.join(projectRoot, 'docs', 'coordination');
    if (!fs.existsSync(coordDir)) return items;

    // Check doctor log size
    const doctorLog = path.join(coordDir, 'doctor', 'DOCTOR_LOG.ndjson');
    if (fs.existsSync(doctorLog)) {
      const stat = fs.statSync(doctorLog);
      const sizeKB = Math.round(stat.size / 1024);
      if (sizeKB > 500) {
        items.push({
          id: 'artifact-doctor-log',
          title: `Large doctor log (${sizeKB}KB)`,
          description: 'Truncate old entries to reduce size',
          category: 'cleanup',
          severity: 'low',
          source: 'artifacts',
          meta: { filePath: doctorLog, sizeKB },
        });
      }
    }

    // Check old report files (tasks, nightly)
    for (const subDir of ['tasks', 'nightly']) {
      const dir = path.join(coordDir, subDir);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.md'));
      const cutoffMs = 14 * 24 * 60 * 60 * 1000; // 14 days
      const now = Date.now();

      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > cutoffMs) {
          items.push({
            id: `artifact-${subDir}-${file}`,
            title: `Old ${subDir} report: ${file}`,
            description: `${Math.round(age / (24 * 60 * 60 * 1000))} days old`,
            category: 'delete',
            severity: 'low',
            source: 'artifacts',
            meta: { filePath, file, subDir },
          });
        }
      }
    }
  } catch { /* fs unavailable */ }
  return items;
}

// ── AI Enrichment ───────────────────────────────────────────────────────────

/**
 * Enrich cleanup items with situational context.
 * @param {import('./hydra-action-pipeline.mjs').ActionItem[]} items
 * @param {object} opts
 * @returns {Promise<import('./hydra-action-pipeline.mjs').ActionItem[]>}
 */
export async function enrichCleanupWithSitrep(items, opts = {}) {
  // Non-fatal: just return items as-is if enrichment fails
  // Enrichment is less critical for cleanup than for doctor fix
  return items;
}

// ── Executor ────────────────────────────────────────────────────────────────

/**
 * Execute a single cleanup action based on its category.
 * @param {import('./hydra-action-pipeline.mjs').ActionItem} item
 * @param {object} opts
 * @returns {Promise<import('./hydra-action-pipeline.mjs').PipelineResult>}
 */
export async function executeCleanupAction(item, opts = {}) {
  const startMs = Date.now();
  const { baseUrl, projectRoot } = opts;

  try {
    switch (item.category) {
      case 'archive': {
        return await executeArchive(item, baseUrl, startMs);
      }
      case 'delete': {
        return await executeDelete(item, projectRoot, startMs);
      }
      case 'requeue': {
        return await executeRequeue(item, baseUrl, startMs);
      }
      case 'cleanup': {
        return await executeCleanup(item, startMs);
      }
      default: {
        return { item, ok: false, error: `Unknown category: ${item.category}`, durationMs: Date.now() - startMs };
      }
    }
  } catch (err) {
    return { item, ok: false, error: err.message || String(err), durationMs: Date.now() - startMs };
  }
}

// ── Category Executors ──────────────────────────────────────────────────────

async function executeArchive(item, baseUrl, startMs) {
  if (item.source === 'daemon' && item.meta?.taskId) {
    try {
      const { request } = await import('./hydra-utils.mjs');
      await request('POST', baseUrl, `/task/update`, {
        id: item.meta.taskId,
        status: 'cancelled',
      });
      return { item, ok: true, output: 'Task archived', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: err.message, durationMs: Date.now() - startMs };
    }
  }
  return { item, ok: true, output: 'No action needed', durationMs: Date.now() - startMs };
}

async function executeDelete(item, projectRoot, startMs) {
  // Branch deletion
  if (item.source === 'branches' && item.meta?.branch) {
    try {
      const { deleteBranch } = await import('./hydra-shared/git-ops.mjs');
      const ok = deleteBranch(projectRoot, item.meta.branch);
      return { item, ok, output: ok ? 'Branch deleted' : 'Failed to delete branch', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: err.message, durationMs: Date.now() - startMs };
    }
  }

  // File deletion (checkpoints, artifacts)
  if (item.meta?.filePath) {
    try {
      fs.unlinkSync(item.meta.filePath);
      return { item, ok: true, output: 'File deleted', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: err.message, durationMs: Date.now() - startMs };
    }
  }

  return { item, ok: false, error: 'No delete target found', durationMs: Date.now() - startMs };
}

async function executeRequeue(item, baseUrl, startMs) {
  if (item.meta?.taskId) {
    try {
      const { request } = await import('./hydra-utils.mjs');
      await request('POST', baseUrl, `/task/update`, {
        id: item.meta.taskId,
        status: 'todo',
      });
      return { item, ok: true, output: 'Task requeued', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: err.message, durationMs: Date.now() - startMs };
    }
  }
  return { item, ok: false, error: 'No task ID for requeue', durationMs: Date.now() - startMs };
}

async function executeCleanup(item, startMs) {
  // Suggestion removal
  if (item.source === 'suggestions' && item.meta?.suggestionId) {
    try {
      const { loadSuggestions, saveSuggestions, removeSuggestion } = await import('./hydra-evolve-suggestions.mjs');
      const sg = loadSuggestions();
      removeSuggestion(sg, item.meta.suggestionId);
      saveSuggestions(sg);
      return { item, ok: true, output: 'Suggestion removed', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: err.message, durationMs: Date.now() - startMs };
    }
  }

  // Doctor log truncation
  if (item.id === 'artifact-doctor-log' && item.meta?.filePath) {
    try {
      const content = fs.readFileSync(item.meta.filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      // Keep last 100 entries
      const kept = lines.slice(-100);
      fs.writeFileSync(item.meta.filePath, kept.join('\n') + '\n', 'utf8');
      return { item, ok: true, output: `Truncated from ${lines.length} to ${kept.length} entries`, durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: err.message, durationMs: Date.now() - startMs };
    }
  }

  // Generic file deletion for artifacts
  if (item.meta?.filePath) {
    try {
      fs.unlinkSync(item.meta.filePath);
      return { item, ok: true, output: 'File removed', durationMs: Date.now() - startMs };
    } catch (err) {
      return { item, ok: false, error: err.message, durationMs: Date.now() - startMs };
    }
  }

  return { item, ok: true, output: 'No action needed', durationMs: Date.now() - startMs };
}
