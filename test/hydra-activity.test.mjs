import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordActivity, entryFromSavedRun, entryFromDecision, renderActivity } from '../lib/hydra-activity.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-activity-'));
  return path.join(dir, 'activity.json');
}

test('same job updates one line and a finished run replaces the draft', () => {
  const filePath = tempFile();
  const now = '2026-10-03T09:00:00.000Z';
  recordActivity({
    id: 'cp-abc',
    at: '2026-10-02T08:00:00.000Z',
    task: 'Oprav explorer',
    outcome: 'claude propose',
    state: 'rozpracováno',
  }, { filePath, now });
  const entries = recordActivity({
    id: 'HYDRA_COUNCIL_1',
    replacesId: 'cp-abc',
    at: '2026-10-02T09:00:00.000Z',
    task: 'Oprav explorer',
    outcome: 'Oprava zapsaná',
    state: 'hotovo',
  }, { filePath, now });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'hotovo');
  const md = fs.readFileSync(filePath.replace(/\.json$/, '.md'), 'utf8');
  assert.match(md, /Oprav explorer/);
  assert.match(md, /hotovo/);
  assert.doesNotMatch(md, /rozpracováno/);
});

test('a line older than a month deletes itself', () => {
  const filePath = tempFile();
  recordActivity({
    id: 'old',
    at: '2026-08-01T10:00:00.000Z',
    task: 'Stará práce',
    state: 'hotovo',
  }, { filePath, now: '2026-08-02T10:00:00.000Z' });
  const entries = recordActivity({
    id: 'new',
    at: '2026-10-02T10:00:00.000Z',
    task: 'Nová práce',
    state: 'hotovo',
  }, { filePath, now: '2026-10-03T10:00:00.000Z' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'new');
  assert.doesNotMatch(renderActivity(entries), /Stará práce/);
});

test('a finished job keeps the task and the result', () => {
  const entry = entryFromDecision({
    id: 'D038',
    createdAt: '2026-10-02T07:15:01.993Z',
    title: 'Hydra Council: oprav rozbity windows explorer',
    rationale: 'Link je, adresa nepřišla. Úprava je vratná a má se ověřit.',
    impact: 'Flow=Claude→Opus→Claude→Codex; next=human_decision',
  });
  assert.equal(entry.task, 'oprav rozbity windows explorer');
  assert.match(entry.outcome, /adresa nepřišla/);
  assert.match(entry.outcome, /Claude, Opus, Claude, Codex/);
  assert.match(renderActivity([entry]), /Úkol:/);
  assert.match(renderActivity([entry]), /Výsledek:/);
});

test('checkpoint file becomes an unfinished line', () => {
  const entry = entryFromSavedRun({
    promptHash: 'abc',
    prompt: 'oprav síť',
    updatedAt: '2026-10-02T08:04:00.979Z',
    transcript: [{ agent: 'claude', phase: 'propose', ok: true }],
  }, 'COUNCIL_CHECKPOINT_abc.json');
  assert.equal(entry.id, 'cp-abc');
  assert.equal(entry.state, 'rozpracováno');
  assert.equal(entry.outcome, 'claude propose');
});
