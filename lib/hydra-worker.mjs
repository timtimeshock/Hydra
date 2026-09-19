/**
 * Hydra Agent Worker - Headless background agent process manager.
 *
 * Spawns agent CLIs as non-interactive background processes with scoped
 * auto-permissions. Workers run the claim->execute->report loop autonomously,
 * emitting progress events for status bar integration.
 *
 * Usage:
 *   const worker = new AgentWorker('claude', { baseUrl, projectRoot });
 *   worker.on('task:complete', ({ agent, taskId }) => ...);
 *   worker.start();
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { getAgent, AGENTS, resolvePhysicalAgent, getActiveModel, getModelReasoningCaps, getReasoningEffort } from './hydra-agents.mjs';
import { request, short } from './hydra-utils.mjs';
import { loadHydraConfig } from './hydra-config.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';
import { detectModelError, recoverFromModelError, detectCodexError, detectUsageLimitError, formatResetTime } from './hydra-model-recovery.mjs';
import { executeAgent, extractAgentAnswer } from './hydra-shared/agent-executor.mjs';

// ── Global Concurrency ──────────────────────────────────────────────────────

let activeTaskCount = 0;
let globalMaxInFlight = 3;

/**
 * Get current worker concurrency stats.
 * @returns {{ active: number, maxInFlight: number, utilization: number }}
 */
export function getWorkerConcurrencyStats() {
  return {
    active: activeTaskCount,
    maxInFlight: globalMaxInFlight,
    utilization: globalMaxInFlight > 0 ? activeTaskCount / globalMaxInFlight : 0,
  };
}

// ── Default Configuration ───────────────────────────────────────────────────

const DEFAULTS = {
  permissionMode: 'auto-edit',
  pollIntervalMs: 1500,
  maxOutputBufferKB: 8,
  autoChain: true,
};

function getWorkerConfig() {
  try {
    const cfg = loadHydraConfig();
    return { ...DEFAULTS, ...cfg.workers };
  } catch {
    return { ...DEFAULTS };
  }
}

// ── AgentWorker Class ───────────────────────────────────────────────────────

export class AgentWorker extends EventEmitter {
  /**
   * @param {string} agent - Agent name (gemini, codex, claude)
   * @param {object} opts
   * @param {string} opts.baseUrl - Daemon URL
   * @param {string} opts.projectRoot - Project working directory
   * @param {string} [opts.permissionMode] - 'auto-edit' or 'full-auto'
   * @param {boolean} [opts.autoChain] - Auto-loop to next task on completion
   */
  constructor(agent, { baseUrl, projectRoot, permissionMode, autoChain } = {}) {
    super();
    this.agent = agent.toLowerCase();
    this.baseUrl = baseUrl;
    this.projectRoot = projectRoot;

    const workerCfg = getWorkerConfig();
    this.permissionMode = permissionMode || workerCfg.permissionMode;
    this.autoChain = autoChain !== undefined ? autoChain : workerCfg.autoChain;
    this.basePollIntervalMs = workerCfg.pollIntervalMs;
    this.pollIntervalMs = workerCfg.pollIntervalMs;
    this.maxOutputBytes = (workerCfg.maxOutputBufferKB || 8) * 1024;
    this.adaptivePolling = workerCfg.concurrency?.adaptivePolling !== false;

    // Update global concurrency limit from config
    const maxFromCfg = workerCfg.concurrency?.maxInFlight;
    if (maxFromCfg && maxFromCfg > 0) globalMaxInFlight = maxFromCfg;

    this._status = 'stopped';   // 'idle' | 'working' | 'stopped' | 'error'
    this._currentTask = null;   // { taskId, title, startedAt }
    this._stopped = false;
    this._childProcess = null;
    this._loopPromise = null;
    this._startedAt = null;
    this._failedTasks = new Set(); // taskIds that failed — skip if re-assigned
  }

  get status() { return this._status; }

  get currentTask() { return this._currentTask; }

  get uptime() {
    return this._startedAt ? Date.now() - this._startedAt : 0;
  }

  /**
   * Start the work loop. Polls daemon for tasks, executes, reports, repeats.
   */
  start() {
    if (this._status === 'working' || this._status === 'idle') return;

    this._stopped = false;
    this._status = 'idle';
    this._startedAt = Date.now();
    this.emit('worker:start', { agent: this.agent });

    this._loopPromise = this._workLoop().catch((err) => {
      this._status = 'error';
      this.emit('worker:stop', { agent: this.agent, reason: err.message });
    });
  }

  /**
   * Graceful shutdown: finish current task, then exit loop.
   */
  stop() {
    this._stopped = true;
    if (this._status === 'idle') {
      this._status = 'stopped';
      this.emit('worker:stop', { agent: this.agent, reason: 'stopped' });
    }
    // If working, the loop will finish current task then exit
  }

  /**
   * Immediate kill: abort current process and exit.
   */
  kill() {
    this._stopped = true;
    if (this._childProcess) {
      try { this._childProcess.kill('SIGTERM'); } catch { /* ignore */ }
      this._childProcess = null;
    }
    this._status = 'stopped';
    this._currentTask = null;
    this.emit('worker:stop', { agent: this.agent, reason: 'killed' });
  }

  /**
   * Update the permission mode at runtime.
   */
  setPermissionMode(mode) {
    this.permissionMode = mode;
  }

  // ── Internal Work Loop ──────────────────────────────────────────────────

  async _workLoop() {
    while (!this._stopped) {
      try {
        // Concurrency gate: wait if too many tasks running globally
        while (activeTaskCount >= globalMaxInFlight && !this._stopped) {
          await this._sleep(500);
        }
        if (this._stopped) break;

        const next = await this._pollNext();

        if (!next || next.action === 'idle') {
          this._status = 'idle';
          this._currentTask = null;
          this.emit('worker:idle', { agent: this.agent });

          // Adaptive polling: slow down when mostly utilized, speed up when idle
          if (this.adaptivePolling) {
            const utilization = globalMaxInFlight > 0 ? activeTaskCount / globalMaxInFlight : 0;
            if (utilization > 0.8) {
              this.pollIntervalMs = Math.min(this.basePollIntervalMs * 3, this.pollIntervalMs * 1.5);
            } else if (utilization < 0.3) {
              this.pollIntervalMs = Math.max(this.basePollIntervalMs * 0.5, this.pollIntervalMs * 0.8);
            }
          }

          await this._sleep(this.pollIntervalMs);
          continue;
        }

        // We have work to do
        let prompt, taskId, title;

        if (next.action === 'pickup_handoff') {
          // Acknowledge the handoff
          try {
            await request('POST', this.baseUrl, '/handoff/ack', {
              handoffId: next.handoff?.id,
              agent: this.agent,
            });
          } catch { /* non-critical */ }

          prompt = next.handoff?.summary || next.handoff?.nextStep || 'Continue assigned work.';
          taskId = next.handoff?.tasks?.[0] || next.handoff?.id || 'unknown';
          title = short(prompt, 80);
        } else if (next.action === 'claim_owned_task' || next.action === 'claim_unassigned_task' || next.action === 'continue_task') {
          const task = next.task;
          taskId = task?.id || 'unknown';
          title = task?.title || 'Untitled task';

          // Claim the task
          try {
            await request('POST', this.baseUrl, '/task/claim', {
              taskId,
              agent: this.agent,
            });
          } catch { /* may already be claimed */ }

          prompt = this._buildTaskPrompt(task);
        } else {
          // Unknown action — sleep and retry
          await this._sleep(this.pollIntervalMs);
          continue;
        }

        // Skip tasks that already failed on this worker (prevent infinite retry)
        if (this._failedTasks.has(taskId)) {
          try {
            await request('POST', this.baseUrl, '/task/update', {
              taskId,
              status: 'blocked',
              notes: `Worker ${this.agent}: task previously failed, marking blocked to prevent retry loop.`,
            });
          } catch { /* daemon may be down */ }
          await this._sleep(this.pollIntervalMs);
          continue;
        }

        // Execute
        this._currentTask = { taskId, title, startedAt: Date.now() };
        this._status = 'working';
        activeTaskCount++;
        this.emit('task:start', { agent: this.agent, taskId, title });

        // Heartbeat interval: send periodic pings to daemon during execution
        const workerCfg = getWorkerConfig();
        const hbIntervalMs = workerCfg.heartbeatIntervalMs || 30_000;
        let hbInterval = null;

        let result;
        try {
          hbInterval = setInterval(() => {
            fetch(`${this.baseUrl}/task/${taskId}/heartbeat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agent: this.agent,
                outputBytes: this._outputBuffer?.length || 0,
                phase: 'executing',
              }),
              signal: AbortSignal.timeout(5000),
            }).catch(() => {}); // fire-and-forget
          }, hbIntervalMs);

          result = await this._executeAgent(prompt);
        } finally {
          if (hbInterval) {
            clearInterval(hbInterval);
            hbInterval = null;
          }
        }

        // ── Error recovery (headless auto-fallback) ─────────────────
        if (!result.ok) {
          // 1. Check for account-level usage limits FIRST — no retry possible
          const usageCheck = detectUsageLimitError(this.agent, result);
          if (usageCheck.isUsageLimit) {
            const resetMsg = usageCheck.resetInSeconds
              ? ` (resets in ${formatResetTime(usageCheck.resetInSeconds)})`
              : '';
            this.emit('task:progress', {
              agent: this.agent,
              taskId,
              output: `[usage-limit] ${usageCheck.errorMessage}${resetMsg}`,
            });
            // Annotate result so the error report is informative
            result.errorCategory = 'usage-limit';
            result.errorDetail = usageCheck.errorMessage;
          // 2. Check for Codex-specific errors (auth/sandbox/invocation)
          // — these should NOT be retried with a different model
          } else {
            const codexCheck = detectCodexError(this.agent, result);
            if (codexCheck.isCodexError) {
              this.emit('task:progress', {
                agent: this.agent,
                taskId,
                output: `[${codexCheck.category}] ${codexCheck.errorMessage}`,
              });
              // Don't attempt model fallback — this is an env/config issue
            } else {
              // Model error → try fallback model
              const modelCheck = detectModelError(this.agent, result);
              if (modelCheck.isModelError) {
                const recovery = await recoverFromModelError(this.agent, modelCheck.failedModel);
                if (recovery.recovered) {
                  this.emit('task:progress', {
                    agent: this.agent,
                    taskId,
                    output: `Model recovery: ${modelCheck.failedModel} → ${recovery.newModel}`,
                  });
                  result = await this._executeAgent(prompt);
                  result.recovered = true;
                  result.originalModel = modelCheck.failedModel;
                  result.newModel = recovery.newModel;
                }
              }
            }
          }
        }

        const durationMs = Date.now() - this._currentTask.startedAt;
        const outputSummary = short(result.output, 200);

        // Report result to daemon (include structured error info for telemetry)
        const errorInfo = result.ok ? undefined : {
          exitCode: result.exitCode,
          signal: result.signal || null,
          stderr: short(result.stderr || '', 500),
          error: result.error,
          errorCategory: result.errorCategory || null,
          errorDetail: result.errorDetail || null,
          errorContext: result.errorContext || null,
        };
        try {
          await request('POST', this.baseUrl, '/task/result', {
            taskId,
            agent: this.agent,
            status: result.ok ? 'done' : 'error',
            output: (extractAgentAnswer(result.output) || String(result.output || '')).slice(0, 8000),
            durationMs,
            ...(errorInfo && { errorInfo }),
          });
        } catch {
          // Fallback: try task/update if /task/result doesn't exist
          try {
            await request('POST', this.baseUrl, '/task/update', {
              taskId,
              status: result.ok ? 'done' : 'blocked',
              notes: result.ok ? `Worker output: ${outputSummary}` : `Worker error: ${result.error || outputSummary}`,
            });
          } catch { /* daemon may be down */ }
        }

        activeTaskCount = Math.max(0, activeTaskCount - 1);
        this._currentTask = null;
        this._status = 'idle';
        this.emit('task:complete', {
          agent: this.agent,
          taskId,
          title,
          status: result.ok ? 'done' : 'error',
          durationMs,
          outputSummary,
        });

        if (result.error) {
          this._failedTasks.add(taskId);
          this.emit('task:error', {
            agent: this.agent,
            taskId,
            title,
            error: result.errorCategory
              ? `[${result.errorCategory}] ${result.errorDetail || result.error}`
              : result.error,
            exitCode: result.exitCode,
            signal: result.signal || null,
            errorCategory: result.errorCategory || null,
            errorDetail: result.errorDetail || null,
            errorContext: result.errorContext || null,
            stderr: short(result.stderr || '', 300),
          });

          // If this is a usage limit (e.g. ChatGPT Codex quota exhausted),
          // stop the worker — no point processing more tasks until it resets.
          const usageCheck = detectUsageLimitError(this.agent, result);
          if (usageCheck.isUsageLimit) {
            const resetLabel = usageCheck.resetInSeconds
              ? ` (resets in ${formatResetTime(usageCheck.resetInSeconds)})`
              : '';
            this.emit('task:progress', {
              agent: this.agent,
              taskId,
              output: `${this.agent} usage limit hit${resetLabel} — stopping worker`,
            });
            this.stop();
            break;
          }

          // Backoff after task failure before polling for next work
          await this._sleep(Math.min(this.pollIntervalMs * 3, 8_000));
        }

        // Auto-chain: immediately loop for next task (no delay)
        if (!this.autoChain) {
          // If not auto-chaining, wait for explicit restart
          this._stopped = true;
        }

      } catch (err) {
        // ALWAYS decrement activeTaskCount on exception, regardless of status
        if (this._currentTask) {
          activeTaskCount = Math.max(0, activeTaskCount - 1);
        }
        this._status = 'error';
        this.emit('task:error', {
          agent: this.agent,
          taskId: this._currentTask?.taskId || 'unknown',
          title: this._currentTask?.title || '',
          error: err.message,
        });
        this._currentTask = null;

        // Backoff on errors
        await this._sleep(Math.min(this.pollIntervalMs * 4, 10_000));
        this._status = 'idle';
      }
    }

    this._status = 'stopped';
    this._currentTask = null;
  }

  /**
   * Poll daemon for next available work.
   */
  async _pollNext() {
    try {
      const data = await request('GET', this.baseUrl, `/next?agent=${encodeURIComponent(this.agent)}`);
      return data?.next || null;
    } catch {
      return null;
    }
  }

  /**
   * Build a prompt string from a task object.
   * If the task has a preferredAgent that's a virtual agent, use its rolePrompt.
   */
  _buildTaskPrompt(task) {
    if (!task) return 'Continue assigned work.';

    // Use virtual agent's rolePrompt if task specifies one
    let rolePrompt = '';
    if (task.preferredAgent) {
      const preferred = getAgent(task.preferredAgent);
      if (preferred?.rolePrompt) {
        rolePrompt = preferred.rolePrompt;
      }
    }
    if (!rolePrompt) {
      const agentConfig = getAgent(this.agent);
      rolePrompt = agentConfig?.rolePrompt || '';
    }

    const parts = [
      `Task: ${task.title || 'Untitled'}`,
    ];
    if (task.notes) parts.push(`Notes: ${task.notes}`);
    if (task.done) parts.push(`Definition of Done: ${task.done}`);
    if (rolePrompt) parts.push('', rolePrompt);
    parts.push('', 'Execute this task. Report exactly what you changed.');

    return parts.join('\n');
  }

  /**
   * Execute the agent CLI as a headless subprocess.
   * Resolves virtual agents to their physical CLI backend.
   * Returns { ok, output, error, tokenUsage }.
   */
  async _executeAgent(prompt) {
    const result = await executeAgent(this.agent, prompt, {
      cwd: this.projectRoot,
      permissionMode: this.permissionMode,
      maxOutputBytes: this.maxOutputBytes,
      onProgress: (elapsed, outputKB, status) => {
        this.emit('task:progress', {
          agent: this.agent,
          taskId: this._currentTask?.taskId,
          output: status || `${outputKB}KB received`,
        });
      },
    });

    return result;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      // Don't block process exit
      if (id.unref) id.unref();
    });
  }
}
