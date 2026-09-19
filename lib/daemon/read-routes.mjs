#!/usr/bin/env node
/**
 * Read-only daemon routes (GET endpoints and SSE stream).
 */

import { buildSelfSnapshot } from '../hydra-self.mjs';

export async function handleReadRoute(ctx) {
  const {
    method,
    route,
    requestUrl,
    req,
    res,
    sendJson,
    sendError,
    writeStatus,
    readStatus,
    checkUsage,
    getModelSummary,
    readState,
    getSummary,
    projectRoot,
    projectName,
    buildPrompt,
    suggestNext,
    readEvents,
    replayEvents,
    sseClients,
    readArchive,
    getMetricsSummary,
    getEventCount,
  } = ctx;

  if (method === 'GET' && route === '/health') {
    writeStatus();
    const status = readStatus();
    let usageLevel = 'unknown';
    try {
      const usage = checkUsage();
      usageLevel = usage.level;
    } catch {
      // Best effort only.
    }
    let models = {};
    try {
      const summary = getModelSummary();
      models = Object.fromEntries(Object.entries(summary).map(([name, info]) => [name, info.active]));
    } catch {
      // Best effort only.
    }
    sendJson(res, 200, {
      ok: true,
      ...status,
      models,
      usage: { level: usageLevel },
    });
    return true;
  }

  if (method === 'GET' && route === '/self') {
    let status = null;
    try {
      writeStatus();
      status = readStatus();
    } catch {
      status = null;
    }

    const state = readState();
    const summary = getSummary(state);

    let usage = null;
    try {
      usage = checkUsage();
    } catch {
      usage = null;
    }

    let models = null;
    try {
      models = getModelSummary();
    } catch {
      models = null;
    }

    const self = buildSelfSnapshot({
      projectRoot: projectRoot || '',
      projectName: projectName || summary?.project || '',
      includeAgents: false,
      includeConfig: true,
      includeMetrics: true,
    });

    self.daemon = {
      ok: true,
      url: status?.url || null,
      pid: status?.pid || process.pid,
      startedAt: status?.startedAt || null,
      status: status || null,
    };

    self.runtime = {
      updatedAt: state.updatedAt || null,
      activeSession: state.activeSession || null,
      summary: summary || null,
      counts: summary?.counts || null,
      usage: usage ? { level: usage.level || 'unknown' } : null,
      models: models
        ? Object.fromEntries(Object.entries(models).filter(([k]) => k !== '_mode').map(([k, v]) => [k, v?.active || 'unknown']))
        : null,
    };

    sendJson(res, 200, { ok: true, self });
    return true;
  }

  if (method === 'GET' && route === '/state') {
    sendJson(res, 200, { ok: true, state: readState() });
    return true;
  }

  if (method === 'GET' && route === '/summary') {
    sendJson(res, 200, { ok: true, summary: getSummary(readState()) });
    return true;
  }

  if (method === 'GET' && route === '/prompt') {
    const agent = (requestUrl.searchParams.get('agent') || 'generic').toLowerCase();
    sendJson(res, 200, { ok: true, agent, prompt: buildPrompt(agent, readState()) });
    return true;
  }

  if (method === 'GET' && route === '/next') {
    const agent = (requestUrl.searchParams.get('agent') || '').toLowerCase();
    if (!agent) {
      sendError(res, 400, 'Missing query param: agent');
      return true;
    }
    sendJson(res, 200, { ok: true, next: suggestNext(readState(), agent) });
    return true;
  }

  if (method === 'GET' && route.startsWith('/task/') && route.endsWith('/checkpoints')) {
    const taskId = route.slice('/task/'.length, -'/checkpoints'.length);
    const state = readState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      sendError(res, 404, `Task ${taskId} not found.`);
      return true;
    }
    sendJson(res, 200, { ok: true, taskId, checkpoints: task.checkpoints || [] });
    return true;
  }

  if (method === 'GET' && route === '/events') {
    const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '50', 10);
    sendJson(res, 200, { ok: true, events: readEvents(limit) });
    return true;
  }

  if (method === 'GET' && route === '/events/replay') {
    const fromSeq = Number.parseInt(requestUrl.searchParams.get('from') || '0', 10);
    const category = requestUrl.searchParams.get('category') || '';
    let events = replayEvents(fromSeq);
    if (category) {
      events = events.filter((e) => e.category === category);
    }
    sendJson(res, 200, { ok: true, count: events.length, events });
    return true;
  }

  if (method === 'GET' && route === '/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(':keepalive\n\n');
      } catch {
        // Ignore write errors on disconnected clients.
      }
    }, 15_000);
    req.on('close', () => {
      sseClients.delete(res);
      clearInterval(keepalive);
    });
    return true;
  }

  if (method === 'GET' && route === '/activity') {
    const state = readState();
    const events = readEvents(50);
    const agents = {};
    for (const name of ['claude', 'gemini', 'codex']) {
      const nextAction = suggestNext(state, name);
      const currentTask = state.tasks.find((t) => t.owner === name && t.status === 'in_progress') || null;
      const pendingHandoffs = state.handoffs
        .filter((h) => h.to === name && !h.acknowledgedAt)
        .map((h) => ({ id: h.id, from: h.from, summary: (h.summary || '').slice(0, 200), createdAt: h.createdAt }));
      agents[name] = {
        currentTask: currentTask ? { id: currentTask.id, title: currentTask.title, status: currentTask.status, type: currentTask.type, updatedAt: currentTask.updatedAt } : null,
        pendingHandoffs,
        suggestedAction: nextAction?.action || 'idle',
      };
    }

    const completedIds = new Set(state.tasks.filter((t) => ['done', 'cancelled'].includes(t.status)).map((t) => t.id));
    const inProgress = state.tasks.filter((t) => t.status === 'in_progress').map((t) => ({ id: t.id, title: t.title, owner: t.owner, type: t.type, updatedAt: t.updatedAt }));
    const todo = state.tasks.filter((t) => t.status === 'todo').map((t) => ({ id: t.id, title: t.title, owner: t.owner, type: t.type }));
    const blocked = state.tasks.filter((t) => t.status === 'blocked' || (Array.isArray(t.blockedBy) && t.blockedBy.some((dep) => !completedIds.has(dep)))).map((t) => ({ id: t.id, title: t.title, owner: t.owner, blockedBy: t.blockedBy }));
    const recentlyCompleted = state.tasks.filter((t) => t.status === 'done').slice(-5).map((t) => ({ id: t.id, title: t.title, owner: t.owner, updatedAt: t.updatedAt }));

    const pendingHandoffs = state.handoffs.filter((h) => !h.acknowledgedAt).slice(-5).map((h) => ({ id: h.id, from: h.from, to: h.to, summary: (h.summary || '').slice(0, 200), nextStep: (h.nextStep || '').slice(0, 200), tasks: h.tasks, createdAt: h.createdAt }));
    const recentHandoffs = state.handoffs.filter((h) => h.acknowledgedAt).slice(-5).map((h) => ({ id: h.id, from: h.from, to: h.to, summary: (h.summary || '').slice(0, 200), acknowledgedAt: h.acknowledgedAt, acknowledgedBy: h.acknowledgedBy, createdAt: h.createdAt }));
    const recentDecisions = state.decisions.slice(-3).map((d) => ({ id: d.id, title: d.title, owner: d.owner, rationale: (d.rationale || '').slice(0, 200), createdAt: d.createdAt }));

    const recentEvents = events.slice(-20).map((e) => ({ seq: e.seq, at: e.at, type: e.type, category: e.category, payload: e.payload }));

    sendJson(res, 200, {
      ok: true,
      activity: {
        generatedAt: new Date().toISOString(),
        session: state.activeSession ? { id: state.activeSession.id, focus: state.activeSession.focus, status: state.activeSession.status, startedAt: state.activeSession.startedAt, updatedAt: state.activeSession.updatedAt } : null,
        agents,
        tasks: { inProgress, todo, blocked, recentlyCompleted },
        handoffs: { pending: pendingHandoffs, recent: recentHandoffs },
        decisions: { recent: recentDecisions },
        recentEvents,
        counts: {
          tasksOpen: inProgress.length + todo.length,
          tasksInProgress: inProgress.length,
          tasksTodo: todo.length,
          tasksBlocked: blocked.length,
          tasksDone: state.tasks.filter((t) => t.status === 'done').length,
          handoffsPending: pendingHandoffs.length,
          handoffsTotal: state.handoffs.length,
          blockersOpen: state.blockers.filter((b) => b.status !== 'resolved').length,
          decisions: state.decisions.length,
        },
      },
    });
    return true;
  }

  if (method === 'GET' && route === '/state/archive') {
    const archive = readArchive();
    sendJson(res, 200, {
      ok: true,
      counts: {
        tasks: archive.tasks.length,
        handoffs: archive.handoffs.length,
        blockers: archive.blockers.length,
      },
      archivedAt: archive.archivedAt,
    });
    return true;
  }

  if (method === 'GET' && route === '/sessions') {
    const state = readState();
    const active = state.activeSession || null;
    const children = state.childSessions || [];
    sendJson(res, 200, {
      ok: true,
      activeSession: active ? {
        id: active.id,
        type: active.type || 'root',
        focus: active.focus,
        status: active.status,
        children: active.children || [],
      } : null,
      childSessions: children.map((s) => ({
        id: s.id,
        type: s.type,
        parentId: s.parentId,
        focus: s.focus,
        status: s.status,
        children: s.children || [],
      })),
    });
    return true;
  }

  if (method === 'GET' && route === '/worktrees') {
    try {
      const { listWorktrees, isWorktreeEnabled } = await import('../hydra-worktree.mjs');
      const enabled = isWorktreeEnabled();
      const state = readState();
      const tasksWithWorktrees = state.tasks.filter((t) => t.worktreePath);
      sendJson(res, 200, {
        ok: true,
        enabled,
        worktrees: tasksWithWorktrees.map((t) => ({
          taskId: t.id,
          path: t.worktreePath,
          branch: t.worktreeBranch,
          status: t.status,
        })),
      });
    } catch (err) {
      sendJson(res, 200, { ok: true, enabled: false, worktrees: [], error: err.message });
    }
    return true;
  }

  if (method === 'GET' && route === '/session/status') {
    const state = readState();
    const now = Date.now();
    const STALE_THRESHOLD_MS = 30 * 60 * 1000;

    const inProgressTasks = state.tasks.filter((t) => t.status === 'in_progress');
    const staleTasks = inProgressTasks.filter((t) => {
      const lastUpdate = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
      return (now - lastUpdate) > STALE_THRESHOLD_MS;
    }).map((t) => ({
      id: t.id,
      title: t.title,
      owner: t.owner,
      status: t.status,
      updatedAt: t.updatedAt,
      staleSince: new Date(new Date(t.updatedAt).getTime() + STALE_THRESHOLD_MS).toISOString(),
    }));

    const pendingHandoffs = state.handoffs
      .filter((h) => !h.acknowledgedAt)
      .map((h) => ({ id: h.id, from: h.from, to: h.to, summary: h.summary, createdAt: h.createdAt }));

    const agentSuggestions = {};
    for (const agent of ['gemini', 'codex', 'claude']) {
      try {
        agentSuggestions[agent] = suggestNext(state, agent);
      } catch { agentSuggestions[agent] = { action: 'unknown' }; }
    }

    // Count events since last active session update
    const lastActiveAt = state.activeSession?.updatedAt || state.updatedAt;
    const lastActiveMs = lastActiveAt ? new Date(lastActiveAt).getTime() : 0;
    let eventsSinceLastActive = 0;
    try {
      const events = readEvents(500);
      eventsSinceLastActive = events.filter((e) => new Date(e.at).getTime() > lastActiveMs).length;
    } catch { /* skip */ }

    sendJson(res, 200, {
      ok: true,
      activeSession: state.activeSession ? {
        id: state.activeSession.id,
        focus: state.activeSession.focus,
        status: state.activeSession.status,
        startedAt: state.activeSession.startedAt,
        updatedAt: state.activeSession.updatedAt,
        pauseReason: state.activeSession.pauseReason || undefined,
        pausedAt: state.activeSession.pausedAt || undefined,
      } : null,
      staleTasks,
      inProgressTasks: inProgressTasks.map((t) => ({
        id: t.id,
        title: t.title,
        owner: t.owner,
        updatedAt: t.updatedAt,
        lastCheckpoint: (t.checkpoints || []).at(-1) || null,
      })),
      pendingHandoffs,
      agentSuggestions,
      lastEventAt: lastActiveAt,
      eventsSinceLastActive,
    });
    return true;
  }

  if (method === 'GET' && route === '/tasks/stale') {
    const state = readState();
    const staleTasks = state.tasks
      .filter((t) => t.stale === true)
      .map((t) => ({
        id: t.id,
        title: t.title,
        owner: t.owner,
        updatedAt: t.updatedAt,
        staleSince: t.staleSince || t.updatedAt,
      }));
    sendJson(res, 200, { ok: true, tasks: staleTasks });
    return true;
  }

  if (method === 'GET' && route === '/stats') {
    const metrics = getMetricsSummary();
    const usage = checkUsage();
    sendJson(res, 200, {
      ok: true,
      metrics,
      usage: {
        level: usage.level,
        percent: usage.percent,
        todayTokens: usage.todayTokens,
        message: usage.message,
        confidence: usage.confidence,
        model: usage.model,
        budget: usage.budget,
        used: usage.used,
        remaining: usage.remaining,
        resetAt: usage.resetAt,
        resetInMs: usage.resetInMs,
        agents: usage.agents,
      },
      daemon: { uptimeSec: Math.floor(process.uptime()), eventsRecorded: getEventCount() },
    });
    return true;
  }

  return false;
}
