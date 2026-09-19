import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANG_SILENCE_MS,
  formatDurationCs,
  parseCouncilPhaseEvents,
  currentPhaseFromEvents,
  buildRunStatus,
  stripAnsi,
  isHeartbeatChunk,
  parseHeartbeatEvent,
  formatHeartbeatLine,
  formatExitCode,
  isForcedExit,
} from '../lib/hydra-run-status.mjs';

test('formatDurationCs covers seconds minutes hours', () => {
  assert.equal(formatDurationCs(0), '0 s');
  assert.equal(formatDurationCs(45000), '45 s');
  assert.equal(formatDurationCs(90000), '1 min 30 s');
  assert.equal(formatDurationCs(120000), '2 min');
  assert.equal(formatDurationCs(3600000), '1 h');
});

test('parseCouncilPhaseEvents reads start/complete lines', () => {
  const text = [
    '[19:17:01] {"type":"council_phase","action":"start","agent":"claude","phase":"propose","round":1}',
    '[19:17:24] {"type":"council_phase","action":"complete","agent":"claude","phase":"propose","round":1}',
    '[19:17:24] {"type":"council_phase","action":"start","agent":"gemini","phase":"critique","round":1}',
  ].join('\n');
  const events = parseCouncilPhaseEvents(text);
  assert.equal(events.length, 3);
  assert.deepEqual(currentPhaseFromEvents(events), { agent: 'gemini', phase: 'critique', round: 1 });
});

test('buildRunStatus idle when daemon up and no job', () => {
  const s = buildRunStatus({ daemon: true, job: null });
  assert.equal(s.level, 'idle');
  assert.equal(s.code, 'idle');
  assert.equal(s.title, 'KLID');
});

test('buildRunStatus down when daemon missing', () => {
  const s = buildRunStatus({ daemon: false, job: { startedAt: 1 } });
  assert.equal(s.level, 'down');
  assert.equal(s.code, 'down');
  assert.match(s.title, /DAEMON/);
});

test('buildRunStatus running while output is fresh', () => {
  const now = 1_000_000;
  const s = buildRunStatus({
    daemon: true,
    now,
    job: {
      kind: 'council',
      startedAt: now - 40_000,
      lastOutputAt: now - 5_000,
      currentAgent: 'gemini',
      currentPhase: 'critique',
      currentRound: 1,
    },
  });
  assert.equal(s.level, 'running');
  assert.equal(s.code, 'running');
  assert.equal(s.title, 'BĚŽÍ');
  assert.match(s.detail, /Gemini/);
  assert.match(s.detail, /critique/);
});

test('buildRunStatus hanging after silence when CLI is gone', () => {
  const now = 1_000_000;
  const s = buildRunStatus({
    daemon: true,
    now,
    liveClis: [],
    job: {
      kind: 'council',
      startedAt: now - 10 * 60_000,
      lastOutputAt: now - (HANG_SILENCE_MS + 1_000),
      currentAgent: 'gemini',
      currentPhase: 'critique',
      currentRound: 1,
    },
  });
  assert.equal(s.level, 'hanging');
  assert.equal(s.code, 'hanging');
  assert.equal(s.title, 'VISÍ');
  assert.match(s.detail, /bez výstupu/);
  assert.match(s.detail, /CLI neběží/);
});

test('buildRunStatus thinking when silent but CLI still alive', () => {
  const now = 1_000_000;
  const s = buildRunStatus({
    daemon: true,
    now,
    liveClis: ['opus', 'claude'],
    job: {
      kind: 'council',
      startedAt: now - 10 * 60_000,
      lastOutputAt: now - (HANG_SILENCE_MS + 1_000),
      currentAgent: 'opus',
      currentPhase: 'critique',
      currentRound: 1,
    },
  });
  assert.equal(s.level, 'running');
  assert.equal(s.code, 'thinking');
  assert.equal(s.title, 'PŘEMÝŠLÍ');
  assert.match(s.detail, /CLI žije/);
  assert.doesNotMatch(s.detail, /VISÍ|visí/);
});

test('heartbeat helpers keep hang detection independent of ticks', () => {
  const raw = '{"type":"council_heartbeat","agent":"gemini","elapsedMs":120000,"outputKB":0}';
  assert.equal(isHeartbeatChunk(raw), true);
  assert.equal(isHeartbeatChunk('{"type":"council_phase","action":"start"}'), false);
  const line = formatHeartbeatLine(parseHeartbeatEvent(raw));
  assert.match(line, /Gemini/);
  assert.match(line, /CLI nic nevypisuje/);
  assert.equal(stripAnsi('  \u001b[38;2;232;134;58mclaude\u001b[39m propose'), '  claude propose');
});

test('forced Windows exit codes are zabit, not unsigned junk', () => {
  assert.equal(formatExitCode(4294967295), 'zabit');
  assert.equal(formatExitCode(-1), 'zabit');
  assert.equal(formatExitCode(0), '0');
  assert.equal(isForcedExit(4294967295), true);
  assert.equal(isForcedExit(0), false);
});

test('buildRunStatus stopping job says ZASTAVUJI', () => {
  const s = buildRunStatus({
    daemon: true,
    job: {
      kind: 'council',
      startedAt: 1,
      lastOutputAt: 1,
      currentAgent: 'gemini',
      currentPhase: 'critique',
      stopped: true,
    },
  });
  assert.equal(s.code, 'stopping');
  assert.equal(s.title, 'ZASTAVUJI');
});
