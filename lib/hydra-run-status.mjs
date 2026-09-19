/**
 * Visible run/hang status for the Hydra GUI banner.
 * Pure helpers — no process IO.
 * Hang (VISÍ) = long silence AND the agent's CLI process is gone.
 * Long silence with a live CLI = PŘEMÝŠLÍ (still running).
 */

export const HANG_SILENCE_MS = 180_000; // 3 min — Opus/Claude often think quietly >90s

export function formatDurationCs(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function parseCouncilPhaseEvents(text) {
  const events = [];
  for (const raw of String(text || '').split(/\n/)) {
    const line = raw.replace(/^\[[^\]]+\]\s*/, '');
    const start = line.indexOf('{"type":"council_phase"');
    if (start < 0) continue;
    try {
      const obj = JSON.parse(line.slice(start));
      if (obj && obj.type === 'council_phase') events.push(obj);
    } catch {
      /* truncated JSON */
    }
  }
  return events;
}

export function currentPhaseFromEvents(events) {
  if (!Array.isArray(events) || !events.length) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.action === 'start' && e.agent) {
      return { agent: String(e.agent).toLowerCase(), phase: e.phase || '', round: e.round || null };
    }
  }
  const last = events[events.length - 1];
  if (last?.agent) {
    return { agent: String(last.agent).toLowerCase(), phase: last.phase || '', round: last.round || null, done: last.action === 'complete' };
  }
  return null;
}

function titleCase(name) {
  const s = String(name || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

export function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

export function isHeartbeatChunk(text) {
  return /"type"\s*:\s*"council_heartbeat"/.test(String(text || ''));
}

export function formatHeartbeatLine(evt = {}) {
  const who = titleCase(evt.agent || '');
  const phase = evt.phase ? ` ${evt.phase}` : '';
  const kb = Number(evt.outputKB) || 0;
  const silent = kb <= 0 ? ' — CLI nic nevypisuje' : ` · ${kb} KB`;
  return `… ${who || 'Agent'}${phase} pořád běží (${formatDurationCs(evt.elapsedMs)})${silent}`;
}

export function formatExitCode(code) {
  if (code == null || code === '') return '?';
  const n = Number(code);
  if (!Number.isFinite(n)) return String(code);
  if (n === -1 || n === 4294967295 || (n >>> 0) === 4294967295) return 'zabit';
  return String(n);
}

export function isForcedExit(code) {
  if (code == null || code === '') return false;
  const n = Number(code);
  return n === -1 || n === 4294967295 || (Number.isFinite(n) && (n >>> 0) === 4294967295);
}

export function parseHeartbeatEvent(text) {
  const line = stripAnsi(String(text || ''));
  const start = line.indexOf('{"type":"council_heartbeat"');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(line.slice(start));
    return obj && obj.type === 'council_heartbeat' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {boolean} opts.daemon
 * @param {null|{kind?:string,startedAt:number,lastOutputAt?:number,currentAgent?:string,currentPhase?:string,currentRound?:number}} opts.job
 * @param {string[]} [opts.liveClis] agent names whose CLI process is alive
 * @param {number} [opts.now]
 * @param {number} [opts.hangSilenceMs]
 */
export function buildRunStatus(opts = {}) {
  const now = Number(opts.now) || Date.now();
  const hangSilenceMs = Number(opts.hangSilenceMs) || HANG_SILENCE_MS;
  const liveClis = Array.isArray(opts.liveClis) ? opts.liveClis.map((n) => String(n).toLowerCase()) : [];

  if (!opts.daemon) {
    return {
      level: 'down',
      code: 'down',
      title: 'DAEMON VYPNUTÝ',
      detail: 'Orchestrátor neběží. GUI je prázdné, dokud se daemon nespustí.',
      kind: '',
      agent: null,
      phase: '',
      round: null,
      elapsedMs: 0,
      silentMs: 0,
    };
  }

  const job = opts.job;
  if (!job) {
    return {
      level: 'idle',
      code: 'idle',
      title: 'KLID',
      detail: 'Žádná úloha. Můžeš psát chat, odeslat agentům, nebo spustit Council.',
      kind: '',
      agent: null,
      phase: '',
      round: null,
      elapsedMs: 0,
      silentMs: 0,
    };
  }

  const elapsedMs = Math.max(0, now - Number(job.startedAt || now));
  const silentMs = Math.max(0, now - Number(job.lastOutputAt || job.startedAt || now));
  const agent = String(job.currentAgent || '').toLowerCase() || null;
  const phase = job.currentPhase || '';
  const round = job.currentRound || null;
  const kind = job.kind || '';
  const who = titleCase(agent);
  const bits = [kind || 'úloha', who, phase].filter(Boolean);
  if (round) bits.push(`kolo ${round}`);
  const where = bits.join(' · ');

  if (job.stopped) {
    return {
      level: 'hanging',
      code: 'stopping',
      title: 'ZASTAVUJI',
      detail: `${where} — ukončuji úlohu.`.trim(),
      kind,
      agent,
      phase,
      round,
      elapsedMs,
      silentMs,
    };
  }

  // Long silence with a live CLI is normal (Opus/Claude thinking). Only mark
  // VISÍ when there is no live process for the current agent.
  const silentLong = silentMs >= hangSilenceMs;
  const cliAlive = Boolean(agent && liveClis.includes(agent));

  if (silentLong && !cliAlive) {
    return {
      level: 'hanging',
      code: 'hanging',
      title: 'VISÍ',
      detail: `${where} — bez výstupu ${formatDurationCs(silentMs)} (úloha ${formatDurationCs(elapsedMs)}). ${who || 'Agent'} mlčí a CLI neběží — proces možná visí.`.trim(),
      kind,
      agent,
      phase,
      round,
      elapsedMs,
      silentMs,
    };
  }

  if (silentLong && cliAlive) {
    return {
      level: 'running',
      code: 'thinking',
      title: 'PŘEMÝŠLÍ',
      detail: `${where} · ${formatDurationCs(elapsedMs)} · bez výstupu ${formatDurationCs(silentMs)} — ${who} CLI žije, čekám na odpověď.`,
      kind,
      agent,
      phase,
      round,
      elapsedMs,
      silentMs,
    };
  }

  return {
    level: 'running',
    code: 'running',
    title: 'BĚŽÍ',
    detail: `${where} · ${formatDurationCs(elapsedMs)} · poslední výstup před ${formatDurationCs(silentMs)}`,
    kind,
    agent,
    phase,
    round,
    elapsedMs,
    silentMs,
  };
}
