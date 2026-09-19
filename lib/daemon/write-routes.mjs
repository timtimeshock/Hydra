#!/usr/bin/env node
/**
 * Mutating daemon routes (POST endpoints).
 */

import crypto from 'crypto';
import path from 'path';
import { createWorktree, removeWorktree, isWorktreeEnabled } from '../hydra-worktree.mjs';
import {
  registerSession as hubRegister,
  deregisterSession as hubDeregister,
  updateSession as hubUpdate,
} from '../hydra-hub.mjs';

export async function handleWriteRoute(ctx) {
  const {
    method,
    route,
    req,
    res,
    readJsonBody,
    sendJson,
    sendError,
    enqueueMutation,
    ensureKnownAgent,
    ensureKnownStatus,
    parseList,
    getCurrentBranch,
    toSessionId,
    nowIso,
    classifyTask,
    nextId,
    detectCycle,
    autoUnblock,
    readState,
    AGENT_NAMES,
    getAgent,
    resolveVerificationPlan,
    projectRoot,
    runVerification,
    archiveState,
    truncateEventsFile,
    writeStatus,
    appendEvent,
    broadcastEvent,
    setIsShuttingDown,
    server,
    createSnapshot,
    cleanOldSnapshots,
    checkIdempotency,
  } = ctx;

  // ── Idempotency Check ──────────────────────────────────────────────────
  if (method === 'POST' && checkIdempotency) {
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey && checkIdempotency(idempotencyKey)) {
      sendJson(res, 409, { ok: false, error: 'Duplicate request (idempotency key already seen)' });
      return true;
    }
  }

  // ── Concierge Event Push ──────────────────────────────────────────────────
  if (method === 'POST' && route === '/events/push') {
    const body = await readJsonBody(req);
    const type = String(body.type || '').trim();
    const payload = body.payload || {};

    const ALLOWED_TYPES = ['concierge:dispatch', 'concierge:summary', 'concierge:error', 'concierge:model_switch'];
    if (!type || !ALLOWED_TYPES.includes(type)) {
      sendError(res, 400, `Invalid event type. Allowed: ${ALLOWED_TYPES.join(', ')}`);
      return true;
    }

    appendEvent(type, payload);
    broadcastEvent({ type, payload, at: new Date().toISOString() });
    sendJson(res, 200, { ok: true, type });
    return true;
  }

  if (method === 'POST' && route === '/session/start') {
    const body = await readJsonBody(req);
    const focus = String(body.focus || '').trim();
    if (!focus) {
      sendError(res, 400, 'Field "focus" is required.');
      return true;
    }

    const owner = String(body.owner || 'human').toLowerCase();
    ensureKnownAgent(owner, false);
    const participants = parseList(body.participants || 'human,gemini,codex,claude');
    const branch = String(body.branch || getCurrentBranch());

    const session = await enqueueMutation(`session:start owner=${owner} focus="${focus}"`, (state) => {
      state.activeSession = {
        id: toSessionId(),
        focus,
        owner,
        branch,
        participants,
        status: 'active',
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };
      return state.activeSession;
    });

    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (method === 'POST' && route === '/session/fork') {
    const body = await readJsonBody(req);
    const reason = String(body.reason || '').trim();

    const result = await enqueueMutation('session:fork', (state) => {
      if (!state.activeSession) {
        throw new Error('No active session to fork.');
      }
      const parent = state.activeSession;
      const forkId = `${parent.id}_FORK_${Date.now().toString(36)}`;

      // Initialize children array on parent if needed
      if (!Array.isArray(parent.children)) {
        parent.children = [];
      }
      parent.children.push(forkId);

      // Create fork session record
      const fork = {
        id: forkId,
        type: 'fork',
        parentId: parent.id,
        children: [],
        focus: parent.focus,
        owner: parent.owner,
        branch: parent.branch,
        participants: [...parent.participants],
        status: 'active',
        reason: reason || 'Forked from parent session',
        contextSnapshot: JSON.stringify({
          tasks: state.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner })),
          decisions: state.decisions.length,
          handoffs: state.handoffs.length,
        }),
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };

      // Store fork sessions in an array on state
      if (!Array.isArray(state.childSessions)) {
        state.childSessions = [];
      }
      state.childSessions.push(fork);

      return fork;
    }, { event: 'session_fork', reason });

    sendJson(res, 200, { ok: true, session: result });
    return true;
  }

  if (method === 'POST' && route === '/session/spawn') {
    const body = await readJsonBody(req);
    const focus = String(body.focus || '').trim();
    if (!focus) {
      sendError(res, 400, 'Field "focus" is required for spawn.');
      return true;
    }
    const owner = String(body.owner || 'human').toLowerCase();

    const result = await enqueueMutation(`session:spawn focus="${focus}"`, (state) => {
      const parentId = state.activeSession?.id || null;
      const spawnId = `${parentId || 'ROOT'}_SPAWN_${Date.now().toString(36)}`;

      // Track on parent if exists
      if (state.activeSession) {
        if (!Array.isArray(state.activeSession.children)) {
          state.activeSession.children = [];
        }
        state.activeSession.children.push(spawnId);
      }

      const child = {
        id: spawnId,
        type: 'spawn',
        parentId,
        children: [],
        focus,
        owner,
        branch: getCurrentBranch(),
        participants: ['human', 'gemini', 'codex', 'claude'],
        status: 'active',
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };

      if (!Array.isArray(state.childSessions)) {
        state.childSessions = [];
      }
      state.childSessions.push(child);

      return child;
    }, { event: 'session_spawn', focus: focus.slice(0, 80) });

    sendJson(res, 200, { ok: true, session: result });
    return true;
  }

  if (method === 'POST' && route === '/session/pause') {
    const body = await readJsonBody(req);
    const reason = String(body.reason || '').trim();

    const session = await enqueueMutation('session:pause', (state) => {
      if (!state.activeSession) {
        throw new Error('No active session to pause.');
      }
      if (state.activeSession.status === 'paused') {
        throw new Error('Session is already paused.');
      }
      state.activeSession.status = 'paused';
      state.activeSession.pauseReason = reason || undefined;
      state.activeSession.pausedAt = nowIso();
      return state.activeSession;
    }, { event: 'session_pause', reason: reason.slice(0, 80) });

    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (method === 'POST' && route === '/session/resume') {
    const body = await readJsonBody(req);

    const session = await enqueueMutation('session:resume', (state) => {
      if (!state.activeSession) {
        throw new Error('No active session to resume.');
      }
      if (state.activeSession.status !== 'paused') {
        throw new Error('Session is not paused.');
      }
      state.activeSession.status = 'active';
      state.activeSession.resumedAt = nowIso();
      delete state.activeSession.pauseReason;
      delete state.activeSession.pausedAt;
      return state.activeSession;
    }, { event: 'session_resume' });

    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (method === 'POST' && route === '/task/add') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
    }

    const owner = String(body.owner || 'unassigned').toLowerCase();
    ensureKnownAgent(owner);

    const status = String(body.status || 'todo');
    ensureKnownStatus(status);

    const files = parseList(body.files || []);
    const notes = String(body.notes || '').trim();
    const blockedBy = parseList(body.blockedBy || []);
    const taskType = String(body.type || '').trim() || classifyTask(title, notes);

    const wantWorktree = Boolean(body.worktree) && isWorktreeEnabled();

    const task = await enqueueMutation(`task:add owner=${owner} status=${status} type=${taskType}`, (state) => {
      const item = {
        id: nextId('T', state.tasks),
        title,
        owner,
        status,
        type: taskType,
        files,
        notes,
        blockedBy,
        updatedAt: nowIso(),
      };
      state.tasks.push(item);
      return item;
    }, { event: 'task_add', owner, title: title.slice(0, 80) });

    // Create worktree after mutation succeeds (uses task.id)
    let worktreeInfo = null;
    if (wantWorktree && task.id) {
      try {
        worktreeInfo = await createWorktree(task.id, projectRoot);
        // Update task record with worktree path via another mutation
        await enqueueMutation(`task:worktree id=${task.id}`, (state) => {
          const t = state.tasks.find((x) => x.id === task.id);
          if (t) {
            t.worktreePath = worktreeInfo.worktreePath;
            t.worktreeBranch = worktreeInfo.branch;
          }
        }, { event: 'worktree_create', taskId: task.id });
      } catch { /* non-critical */ }
    }

    sendJson(res, 200, { ok: true, task, worktree: worktreeInfo });
    return true;
  }

  if (method === 'POST' && route === '/task/claim') {
    const body = await readJsonBody(req);
    const agent = String(body.agent || '').toLowerCase();
    ensureKnownAgent(agent, false);

    const claimTitle = String(body.title || body.taskId || '').trim();
    const task = await enqueueMutation(`task:claim agent=${agent}`, (state) => {
      const taskId = String(body.taskId || '').trim();
      const title = String(body.title || '').trim();
      const files = parseList(body.files);
      const notes = String(body.notes || '').trim();

      if (taskId) {
        const existing = state.tasks.find((item) => item.id === taskId);
        if (!existing) {
          throw new Error(`Task ${taskId} not found.`);
        }
        if (['done', 'cancelled'].includes(existing.status)) {
          throw new Error(`Task ${taskId} is already ${existing.status}.`);
        }
        if (existing.status === 'in_progress' && existing.owner !== agent) {
          throw new Error(`Task ${taskId} is already in progress by ${existing.owner}.`);
        }

        existing.owner = agent;
        existing.status = 'in_progress';
        existing.claimToken = crypto.randomUUID();
        if (files.length > 0) {
          existing.files = files;
        }
        if (notes) {
          existing.notes = existing.notes ? `${existing.notes}\n${notes}` : notes;
        }
        existing.updatedAt = nowIso();
        return existing;
      }

      if (!title) {
        throw new Error('Either taskId or title is required.');
      }

      const claimBlockedBy = parseList(body.blockedBy || []);
      const newTask = {
        id: nextId('T', state.tasks),
        title,
        owner: agent,
        status: 'in_progress',
        claimToken: crypto.randomUUID(),
        files,
        notes,
        blockedBy: claimBlockedBy,
        updatedAt: nowIso(),
      };
      state.tasks.push(newTask);
      return newTask;
    }, { event: 'task_claim', agent, title: claimTitle.slice(0, 80) });

    // Sync to coordination hub (non-critical — must never fail the request)
    try {
      hubRegister({
        id: `daemon_${task.id}`,
        agent: task.owner,
        cwd: projectRoot,
        project: path.basename(projectRoot),
        focus: task.title,
        files: task.files || [],
        taskId: task.id,
        status: 'working',
      });
    } catch { /* hub sync is non-critical */ }

    sendJson(res, 200, { ok: true, task });
    return true;
  }

  if (method === 'POST' && route === '/task/update') {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }

    const updateStatus = body.status !== undefined ? String(body.status) : undefined;
    const updateOwner = body.owner !== undefined ? String(body.owner).toLowerCase() : undefined;
    const task = await enqueueMutation(`task:update id=${taskId}`, (state) => {
      const existing = state.tasks.find((item) => item.id === taskId);
      if (!existing) {
        throw new Error(`Task ${taskId} not found.`);
      }

      // Atomic claim token validation: if caller provides claimToken, it must match
      if (body.claimToken && !body.force) {
        if (existing.claimToken && existing.claimToken !== body.claimToken) {
          throw new Error(`Claim token mismatch for ${taskId}. Task is owned by another claim. Use force=true to override.`);
        }
      }

      if (body.title !== undefined) {
        existing.title = String(body.title);
      }
      if (body.owner !== undefined) {
        const owner = String(body.owner).toLowerCase();
        ensureKnownAgent(owner);
        existing.owner = owner;
      }
      if (body.blockedBy !== undefined) {
        const proposed = parseList(body.blockedBy);
        if (proposed.length > 0 && detectCycle(state.tasks, taskId, proposed)) {
          throw new Error(`Setting blockedBy=[${proposed.join(',')}] on ${taskId} would create a circular dependency.`);
        }
        existing.blockedBy = proposed;
      }
      if (body.status !== undefined) {
        const status = String(body.status);
        ensureKnownStatus(status);
        existing.status = status;
      }
      if (body.files !== undefined) {
        existing.files = parseList(body.files);
      }
      if (body.notes !== undefined) {
        const notes = String(body.notes).trim();
        if (notes) {
          existing.notes = existing.notes ? `${existing.notes}\n${notes}` : notes;
        }
      }
      existing.updatedAt = nowIso();
      if (existing.stale) {
        existing.stale = false;
        delete existing.staleSince;
      }

      if (['done', 'cancelled'].includes(existing.status)) {
        autoUnblock(state, taskId);
      }

      return existing;
    }, { event: 'task_update', taskId, status: updateStatus, owner: updateOwner });

    // Auto-cleanup worktree when task completes
    if (['done', 'cancelled'].includes(task.status) && task.worktreePath && isWorktreeEnabled()) {
      try {
        await removeWorktree(taskId, projectRoot, { deleteBranch: task.status === 'cancelled' });
      } catch { /* non-critical */ }
    }

    // Sync status change to coordination hub
    try {
      const hubSessId = `daemon_${task.id}`;
      if (['done', 'cancelled'].includes(task.status)) {
        hubDeregister(hubSessId);
      } else {
        hubUpdate(hubSessId, {
          status: task.status === 'blocked' ? 'blocked' : 'working',
          files: task.files || [],
          focus: task.title,
        });
      }
    } catch { /* hub sync is non-critical */ }

    const shouldVerify = task.status === 'done' && body.verify !== false;
    const verifyPlan = resolveVerificationPlan(projectRoot);
    const isVerifying = shouldVerify && verifyPlan.enabled;
    if (isVerifying) {
      runVerification(taskId, verifyPlan);
    }
    sendJson(res, 200, {
      ok: true,
      task,
      verifying: isVerifying,
      verification: {
        enabled: verifyPlan.enabled,
        source: verifyPlan.source,
        command: verifyPlan.command || null,
        reason: verifyPlan.reason,
      },
    });
    return true;
  }

  if (method === 'POST' && route === '/task/route') {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '').trim();
    const includeVirtual = body.includeVirtual === true;
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const state = readState();
    const target = state.tasks.find((t) => t.id === taskId);
    if (!target) {
      sendError(res, 404, `Task ${taskId} not found.`);
      return true;
    }
    const taskType = target.type || classifyTask(target.title, target.notes || '');
    const scores = {};
    let recommended = AGENT_NAMES[0];
    let bestScore = 0;
    // Score physical agents
    for (const name of AGENT_NAMES) {
      const cfg = getAgent(name);
      const score = cfg?.taskAffinity?.[taskType] || 0.5;
      scores[name] = score;
      if (score > bestScore) {
        bestScore = score;
        recommended = name;
      }
    }
    // Optionally score virtual agents
    const virtualScores = {};
    let virtualRecommended = null;
    if (includeVirtual && ctx.listAgents) {
      const virtualAgents = ctx.listAgents({ type: 'virtual', enabled: true });
      for (const va of virtualAgents) {
        const score = va.taskAffinity?.[taskType] || 0;
        virtualScores[va.name] = score;
        if (!virtualRecommended || score > (virtualScores[virtualRecommended] || 0)) {
          virtualRecommended = va.name;
        }
      }
    }
    const response = {
      ok: true,
      taskId,
      taskType,
      recommended,
      scores,
      reason: `${taskType} task best suited for ${recommended} (affinity=${bestScore})`,
    };
    if (includeVirtual && Object.keys(virtualScores).length > 0) {
      response.virtualScores = virtualScores;
      response.virtualRecommended = virtualRecommended;
    }
    sendJson(res, 200, response);
    return true;
  }

  if (method === 'POST' && route === '/verify') {
    const body = await readJsonBody(req);
    const verifyTaskId = String(body.taskId || '').trim();
    if (!verifyTaskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const state = readState();
    const target = state.tasks.find((t) => t.id === verifyTaskId);
    if (!target) {
      sendError(res, 404, `Task ${verifyTaskId} not found.`);
      return true;
    }

    const verifyPlan = resolveVerificationPlan(projectRoot);
    if (!verifyPlan.enabled) {
      sendJson(res, 200, {
        ok: true,
        taskId: verifyTaskId,
        message: 'Verification skipped (no command configured).',
        verification: {
          enabled: false,
          source: verifyPlan.source,
          command: null,
          reason: verifyPlan.reason,
        },
      });
      return true;
    }

    runVerification(verifyTaskId, verifyPlan);
    sendJson(res, 200, {
      ok: true,
      taskId: verifyTaskId,
      message: 'Verification started.',
      verification: {
        enabled: true,
        source: verifyPlan.source,
        command: verifyPlan.command,
        reason: verifyPlan.reason,
      },
    });
    return true;
  }

  if (method === 'POST' && route === '/decision') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
    }

    const owner = String(body.owner || 'human').toLowerCase();
    ensureKnownAgent(owner, false);
    const rationale = String(body.rationale || '');
    const impact = String(body.impact || '');

    const decision = await enqueueMutation(`decision:add owner=${owner}`, (state) => {
      const item = {
        id: nextId('D', state.decisions),
        title,
        owner,
        rationale,
        impact,
        createdAt: nowIso(),
      };
      state.decisions.push(item);
      return item;
    }, { event: 'decision', title: title.slice(0, 80) });

    sendJson(res, 200, { ok: true, decision });
    return true;
  }

  if (method === 'POST' && route === '/blocker') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
    }

    const owner = String(body.owner || 'human').toLowerCase();
    ensureKnownAgent(owner, false);
    const nextStep = String(body.nextStep || '');

    const blocker = await enqueueMutation(`blocker:add owner=${owner}`, (state) => {
      const item = {
        id: nextId('B', state.blockers),
        title,
        owner,
        status: 'open',
        nextStep,
        createdAt: nowIso(),
      };
      state.blockers.push(item);
      return item;
    });

    sendJson(res, 200, { ok: true, blocker });
    return true;
  }

  if (method === 'POST' && route === '/handoff') {
    const body = await readJsonBody(req);
    const from = String(body.from || '').toLowerCase();
    const to = String(body.to || '').toLowerCase();
    const summary = String(body.summary || '').trim();
    const nextStep = String(body.nextStep || '');
    const tasks = parseList(body.tasks);

    if (!from || !to || !summary) {
      sendError(res, 400, 'Fields "from", "to", and "summary" are required.');
      return true;
    }

    ensureKnownAgent(from, false);
    ensureKnownAgent(to, false);

    const handoff = await enqueueMutation(`handoff:add ${from}->${to}`, (state) => {
      const item = {
        id: nextId('H', state.handoffs),
        from,
        to,
        summary,
        nextStep,
        tasks,
        createdAt: nowIso(),
      };
      state.handoffs.push(item);
      return item;
    }, { event: 'handoff', from, to, summary: String(summary || '').slice(0, 60) });

    sendJson(res, 200, { ok: true, handoff });
    return true;
  }

  if (method === 'POST' && route === '/handoff/ack') {
    const body = await readJsonBody(req);
    const handoffId = String(body.handoffId || '').trim();
    const agent = String(body.agent || '').toLowerCase();
    if (!handoffId || !agent) {
      sendError(res, 400, 'Fields "handoffId" and "agent" are required.');
      return true;
    }
    ensureKnownAgent(agent, false);

    const handoff = await enqueueMutation(`handoff:ack id=${handoffId} by=${agent}`, (state) => {
      const item = state.handoffs.find((entry) => entry.id === handoffId);
      if (!item) {
        throw new Error(`Handoff ${handoffId} not found.`);
      }
      item.acknowledgedAt = nowIso();
      item.acknowledgedBy = agent;
      return item;
    }, { event: 'handoff_ack', agent, handoffId });

    sendJson(res, 200, { ok: true, handoff });
    return true;
  }

  if (method === 'POST' && route === '/task/result') {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '').trim();
    const agent = String(body.agent || '').toLowerCase();
    if (!taskId || !agent) {
      sendError(res, 400, 'Fields "taskId" and "agent" are required.');
      return true;
    }
    ensureKnownAgent(agent, false);

    const output = String(body.output || '').trim();
    const resultStatus = String(body.status || 'completed'); // completed | needs_followup | aborted
    const durationMs = Number(body.durationMs) || 0;

    const result = await enqueueMutation(`task:result id=${taskId} agent=${agent} status=${resultStatus}`, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found.`);
      }

      // Store the result on the task
      if (!Array.isArray(task.results)) {
        task.results = [];
      }
      const entry = {
        agent,
        status: resultStatus,
        durationMs,
        output: output.slice(0, 8000), // cap stored output
        submittedAt: nowIso(),
      };
      // Attach structured error info from worker (if present)
      if (body.errorInfo) {
        entry.errorInfo = {
          exitCode: body.errorInfo.exitCode ?? null,
          signal: body.errorInfo.signal || null,
          stderr: String(body.errorInfo.stderr || '').slice(0, 1000),
          error: String(body.errorInfo.error || '').slice(0, 500),
          errorCategory: body.errorInfo.errorCategory || null,
          errorDetail: body.errorInfo.errorDetail || null,
          errorContext: String(body.errorInfo.errorContext || '').slice(0, 500),
        };
      }
      task.results.push(entry);
      task.updatedAt = nowIso();

      // Auto-complete / block based on result status
      if (task.status === 'in_progress' && task.owner === agent) {
        if (resultStatus === 'completed' || resultStatus === 'done') {
          task.status = 'done';
          autoUnblock(state, taskId);
        } else if (resultStatus === 'error') {
          // Increment fail count; move to DLQ if exceeded threshold
          task.failCount = (task.failCount || 0) + 1;
          const maxAttempts = 3; // config-driven in future
          if (task.failCount >= maxAttempts) {
            // Move to dead-letter queue
            if (!Array.isArray(state.deadLetter)) state.deadLetter = [];
            task.status = 'cancelled';
            task.deadLetteredAt = nowIso();
            state.deadLetter.push({ ...task });
            state.tasks = state.tasks.filter(t => t.id !== taskId);
          } else {
            task.status = 'blocked';
            task.blockedReason = output.slice(0, 500) || 'Agent reported error';
          }
        }
      }

      // Mark stale reset
      if (task.stale) {
        task.stale = false;
        delete task.staleSince;
      }

      return { task, entry };
    }, { event: 'task_result', taskId, agent, status: resultStatus, category: 'agent' });

    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === 'POST' && route === '/task/checkpoint') {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const name = String(body.name || '').trim();
    if (!name) {
      sendError(res, 400, 'Field "name" is required.');
      return true;
    }
    const context = String(body.context || '').trim();
    const agent = String(body.agent || '').toLowerCase();

    const checkpoint = await enqueueMutation(`task:checkpoint id=${taskId} name=${name}`, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found.`);
      }
      if (!Array.isArray(task.checkpoints)) {
        task.checkpoints = [];
      }
      const cp = {
        name,
        savedAt: nowIso(),
        context,
        agent: agent || task.owner || 'unknown',
      };
      task.checkpoints.push(cp);
      task.updatedAt = nowIso();
      if (task.stale) {
        task.stale = false;
        delete task.staleSince;
      }
      return cp;
    }, { event: 'checkpoint', taskId, name });

    sendJson(res, 200, { ok: true, checkpoint });
    return true;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────
  if (method === 'POST' && route.startsWith('/task/') && route.endsWith('/heartbeat')) {
    const taskId = route.slice('/task/'.length, -'/heartbeat'.length);
    if (!taskId) {
      sendError(res, 400, 'Task ID required in URL.');
      return true;
    }
    const body = await readJsonBody(req);
    const agent = String(body.agent || '').toLowerCase();

    const result = await enqueueMutation(`task:heartbeat id=${taskId}`, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found.`);
      }

      const now = nowIso();
      task.lastHeartbeat = now;
      task.updatedAt = now;
      task.lastHeartbeatDetail = {
        agent: agent || task.owner || 'unknown',
        progress: body.progress || null,
        outputBytes: body.outputBytes || 0,
        phase: body.phase || null,
      };

      // Reset stale flag
      if (task.stale) {
        task.stale = false;
        delete task.staleSince;
      }

      return { taskId, heartbeat: now };
    }, { event: 'task:heartbeat', taskId, agent, category: 'heartbeat' });

    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === 'POST' && route === '/state/archive') {
    const result = await enqueueMutation('state:archive', (state) => {
      const moved = archiveState(state);
      const trimmed = truncateEventsFile(500);
      return { moved, eventsTrimmed: trimmed };
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // ── Dead-Letter Queue ──────────────────────────────────────────────────

  if (method === 'GET' && route === '/dead-letter') {
    const state = readState();
    sendJson(res, 200, { ok: true, items: state.deadLetter || [] });
    return true;
  }

  if (method === 'POST' && route === '/dead-letter/retry') {
    const body = await readJsonBody(req);
    const dlId = String(body.id || '').trim();
    if (!dlId) {
      sendError(res, 400, 'Field "id" is required.');
      return true;
    }

    const task = await enqueueMutation(`dlq:retry id=${dlId}`, (state) => {
      if (!Array.isArray(state.deadLetter)) state.deadLetter = [];
      const idx = state.deadLetter.findIndex(t => t.id === dlId);
      if (idx === -1) throw new Error(`DLQ entry ${dlId} not found.`);
      const item = state.deadLetter.splice(idx, 1)[0];
      item.status = 'todo';
      item.failCount = 0;
      item.retriedAt = nowIso();
      delete item.deadLetteredAt;
      state.tasks.push(item);
      return item;
    }, { event: 'dlq_retry', taskId: dlId });

    sendJson(res, 200, { ok: true, task });
    return true;
  }

  // ── Admin: Snapshot & Compaction ──────────────────────────────────────

  if (method === 'POST' && route === '/admin/compact') {
    const result = ctx.createSnapshot ? ctx.createSnapshot() : { ok: false, error: 'Snapshots not available' };
    if (result.ok && ctx.truncateEventsFile) {
      const trimmed = truncateEventsFile(500);
      result.eventsTrimmed = trimmed;
    }
    if (ctx.cleanOldSnapshots) ctx.cleanOldSnapshots();
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === 'POST' && route === '/shutdown') {
    sendJson(res, 200, { ok: true, message: 'Shutting down orchestrator daemon.' });
    setIsShuttingDown(true);
    writeStatus({ running: false, stoppingAt: nowIso() });
    setTimeout(() => {
      server.close(() => {
        writeStatus({ running: false, stoppedAt: nowIso() });
        process.exit(0);
      });
    }, 100);
    return true;
  }

  return false;
}
