import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCouncilAnswer } from '../lib/hydra-gui.mjs';

test('council answer is a finished decision, not a truncated JSON dump', () => {
  const report = {
    ok: true,
    report: {
      consensus: 'Každý agent se představil. Nic se nemění.',
      finalDecision: { summary: 'Smoke test je hotový. Žádný zápis.' },
      transcript: [
        { agent: 'claude', phase: 'propose', ok: true, parsed: { view: 'Jsem Claude. Běžím.' } },
        { agent: 'opus', phase: 'critique', ok: true, parsed: { critique: 'Jsem Grok. Běžím.' } },
        { agent: 'claude', phase: 'refine', ok: true, parsed: { view: 'Plán platí.' } },
        { agent: 'codex', phase: 'implement', ok: true, parsed: { consensus: 'Jsem Codex. Běžím.', changed_paths: [] } },
      ],
    },
  };
  const raw = `UPOZORNĚNÍ: Council běžel nad složkou Hydry.\n${JSON.stringify(report, null, 2)}\n`;
  const answer = extractCouncilAnswer(raw);
  assert.match(answer, /^Hotovo\./);
  assert.match(answer, /Grok · critique: Jsem Grok\. Běžím\./);
  assert.match(answer, /Rozhodnutí: Smoke test je hotový/);
  assert.doesNotMatch(answer, /"transcript"/);
  assert.ok(answer.trim().endsWith('Smoke test je hotový. Žádný zápis.'));
});

test('unparsed council JSON is not shown as the decision', () => {
  const raw = `${'{"ok":true,"report":'.repeat(20)} Jsem Claude. Běžím.`;
  assert.equal(extractCouncilAnswer(raw), '');
});
