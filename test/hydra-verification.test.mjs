import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAutoVerificationCommand, resolveVerificationPlan } from '../lib/hydra-verification.mjs';

test('chooseAutoVerificationCommand prefers package typecheck script', () => {
  const selected = chooseAutoVerificationCommand({
    npmScripts: { typecheck: 'tsc --noEmit', verify: 'npm run lint' },
    hasTypeScriptConfig: true,
  });

  assert.deepEqual(selected, {
    command: 'npm run typecheck',
    reason: 'Detected package.json script: typecheck',
  });
});

test('chooseAutoVerificationCommand falls back to language defaults', () => {
  const rustSelected = chooseAutoVerificationCommand({
    npmScripts: {},
    hasCargoToml: true,
  });
  assert.deepEqual(rustSelected, {
    command: 'cargo check',
    reason: 'Detected Cargo.toml',
  });

  const goSelected = chooseAutoVerificationCommand({
    npmScripts: {},
    hasGoMod: true,
  });
  assert.deepEqual(goSelected, {
    command: 'go test ./...',
    reason: 'Detected go.mod',
  });
});

test('chooseAutoVerificationCommand uses npm test when test script exists', () => {
  const selected = chooseAutoVerificationCommand({
    npmScripts: { test: 'node --test' },
  });

  assert.deepEqual(selected, {
    command: 'npm test',
    reason: 'Detected package.json script: test',
  });
});

test('chooseAutoVerificationCommand skips npm-init placeholder test script', () => {
  const selected = chooseAutoVerificationCommand({
    npmScripts: { test: 'echo \"Error: no test specified\" && exit 1' },
  });

  assert.equal(selected, null);
});

test('resolveVerificationPlan uses explicit config command', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'npm run verify', timeoutMs: 45000 } },
    {}
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.command, 'npm run verify');
  assert.equal(plan.source, 'config');
  assert.equal(plan.timeoutMs, 45000);
});

test('resolveVerificationPlan disables when onTaskDone is false', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: false, command: 'auto', timeoutMs: 60000 } },
    { npmScripts: { typecheck: 'tsc --noEmit' } }
  );

  assert.equal(plan.enabled, false);
  assert.match(plan.reason, /onTaskDone/i);
});

test('resolveVerificationPlan supports disabled command aliases', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'off', timeoutMs: 60000 } },
    { npmScripts: { typecheck: 'tsc --noEmit' } }
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.command, '');
  assert.equal(plan.source, 'config');
});

test('resolveVerificationPlan returns disabled auto plan when no signal matches', () => {
  const plan = resolveVerificationPlan(
    'unused',
    { verification: { onTaskDone: true, command: 'auto', timeoutMs: 60000 } },
    { npmScripts: {} }
  );

  assert.equal(plan.enabled, false);
  assert.equal(plan.command, '');
  assert.equal(plan.source, 'auto');
  assert.match(plan.reason, /No project-specific verification command/i);
});
