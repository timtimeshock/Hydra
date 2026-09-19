import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildStepPrompt,
  deriveCouncilRecommendation,
  synthesizeCouncilTranscript,
  extractAssumptionAttacks,
  resolveActiveAgents,
  computeAdversarialResumePoint,
  COUNCIL_HANDOFF_AGENTS,
  snapshotProjectFiles,
  changedProjectFiles,
} from '../lib/hydra-council.mjs';

test('buildStepPrompt adds structured convergence instructions', () => {
  const prompt = buildStepPrompt(
    {
      agent: 'opus',
      phase: 'critique',
      promptLabel: 'Review this plan critically. Identify risks, edge cases, missed files, and regressions. Cite specific code.',
    },
    'Redesign the task routing system',
    [],
    1,
    2
  );

  assert.match(prompt, /Decision criteria for convergence:/);
  assert.match(prompt, /Do not use majority vote/i);
  assert.match(prompt, /attack the strongest assumption/i);
  assert.match(prompt, /decision_options/);
  assert.match(prompt, /assumption_attacks/);
});

test('synthesizeCouncilTranscript follows final synthesis over positive council votes', () => {
  const transcript = [
    {
      agent: 'claude',
      phase: 'propose',
      parsed: {
        view: 'Two viable rollout shapes exist.',
        should_open_council: true,
        council_reason: 'Need more critique before converging.',
        decision_options: [
          {
            option: 'feature_flag',
            summary: 'Ship a reversible rollout behind a flag.',
            preferred: true,
            tradeoffs: {
              correctness: 'Safe if guarded by existing checks.',
              complexity: 'Moderate.',
              reversibility: 'High.',
              user_impact: 'Contained blast radius.',
            },
          },
        ],
        assumptions: [
          {
            assumption: 'Existing checks are sufficient for a flagged rollout.',
            status: 'validated',
            evidence: 'Covered by integration tests.',
            owner: 'claude',
          },
        ],
      },
    },
    {
      agent: 'gemini',
      phase: 'critique',
      parsed: {
        critique: 'The leading option is acceptable if rollout remains reversible.',
        should_open_council: true,
        council_reason: 'Pressure-test the implementation details.',
        assumption_attacks: [
          {
            assumption: 'Feature flags are wired everywhere.',
            challenge: 'Audit the API edge before rollout.',
            impact: 'Missed edge could leak behavior.',
            by: 'gemini',
          },
        ],
      },
    },
    {
      agent: 'codex',
      phase: 'implement',
      parsed: {
        consensus: 'Use the feature-flag rollout.',
        should_open_council: true,
        council_reason: 'Earlier phases requested more analysis.',
        decision: {
          summary: 'Use the feature-flag rollout.',
          why: 'It satisfies correctness while keeping rollback trivial.',
          owner: 'codex',
          confidence: 'high',
          next_action: 'handoff',
          reversible_first_step: 'Implement the flag gate and ship dark.',
          tradeoffs: {
            correctness: 'Preserves current behavior until enabled.',
            complexity: 'Adds one controlled branch.',
            reversibility: 'Flag can be disabled immediately.',
            user_impact: 'No visible impact until enabled.',
          },
        },
        assumptions: [
          {
            assumption: 'Feature flags are wired everywhere.',
            status: 'validated',
            evidence: 'Audit complete.',
            owner: 'codex',
          },
        ],
        task_allocations: [
          {
            owner: 'codex',
            title: 'Add feature flag gate to routing path',
            rationale: 'Enable a reversible rollout',
            definition_of_done: 'Flag defaults off and integration tests cover the gate.',
          },
        ],
      },
    },
  ];

  const report = synthesizeCouncilTranscript('Redesign the task routing system', transcript);

  assert.equal(report.recommendedMode, 'handoff');
  assert.equal(report.recommendedNextAction, 'handoff');
  assert.equal(report.finalDecision?.owner, 'codex');
  assert.equal(report.finalDecision?.reversibleFirstStep, 'Implement the flag gate and ship dark.');
  assert.match(report.recommendationRationale, /decision_next_action=handoff/);
  assert.equal(report.councilVotes.filter((item) => item.vote).length, 3);
  assert.equal(report.tasks[0].owner, 'codex');
});

test('synthesizeCouncilTranscript skips default tasks when decision says no further work', () => {
  const transcript = [
    {
      agent: 'codex',
      phase: 'implement',
      parsed: {
        consensus: 'Ověřil jsem strict validaci; publish na opus má projít.',
        should_open_council: false,
        decision: {
          summary: 'Bez dalších změn.',
          why: 'ensureKnownAgent i integrační testy přesně odpovídají specifikaci.',
          owner: 'codex',
          confidence: 'high',
          next_action: 'handoff',
          reversible_first_step: 'Žádná změna není potřebná.',
        },
      },
    },
  ];

  const report = synthesizeCouncilTranscript('# Hydra Council — krátký smoke test', transcript);
  assert.equal(report.tasks.length, 0);
  assert.match(report.consensus, /Bez dalších změn/i);
});

test('deriveCouncilRecommendation keeps council open for human decisions', () => {
  const recommendation = deriveCouncilRecommendation({
    finalDecision: {
      owner: 'codex',
      confidence: 'medium',
      nextAction: 'human_decision',
    },
    assumptions: [],
    questions: [{ to: 'human', question: 'Which product tradeoff matters more?' }],
    risks: [],
    disagreements: [],
    councilVotes: [],
  });

  assert.equal(recommendation.recommendedMode, 'council');
  assert.equal(recommendation.nextAction, 'human_decision');
  assert.match(recommendation.rationale, /human_questions=1/);
});

// ─── Adversarial: ATTACK schema tests ───────────────────────────────────────

test('extractAssumptionAttacks maps attack_vector/target_agent (new schema)', () => {
  const parsed = {
    assumption_attacks: [
      { attack_vector: 'The cache never invalidates under concurrent writes', target_agent: 'claude', impact: 'data loss', by: 'gemini' },
    ],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 1);
  assert.equal(attacks[0].challenge, 'The cache never invalidates under concurrent writes');
  assert.equal(attacks[0].assumption, 'claude');
});

test('extractAssumptionAttacks backward-compat with challenge/target (old schema)', () => {
  const parsed = {
    assumption_attacks: [
      { challenge: 'The lock is not held across retries', target: 'gemini', impact: 'race', by: 'codex' },
    ],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 1);
  assert.equal(attacks[0].challenge, 'The lock is not held across retries');
  assert.equal(attacks[0].assumption, 'gemini');
});

test('extractAssumptionAttacks prefers attack_vector over challenge when both present', () => {
  const parsed = {
    assumption_attacks: [
      { attack_vector: 'primary attack', challenge: 'old field', target_agent: 'codex', target: 'claude' },
    ],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks[0].challenge, 'primary attack');
  assert.equal(attacks[0].assumption, 'codex');
});

// ─── Adversarial: resolveActiveAgents ───────────────────────────────────────

test('resolveActiveAgents returns defaults when no filter given', () => {
  const agents = resolveActiveAgents(null);
  assert.deepEqual(agents, ['claude', 'opus', 'codex']);
});

test('COUNCIL_HANDOFF_AGENTS excludes the unsupported local agent', () => {
  assert.deepEqual(COUNCIL_HANDOFF_AGENTS, ['claude', 'opus', 'codex']);
});

test('implement file snapshot ignores council reports and records real project edits', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-council-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'docs', 'coordination', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'app.mjs'), 'export const version = 1;\n');
    const before = snapshotProjectFiles(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'app.mjs'), 'export const version = 2;\n');
    fs.writeFileSync(path.join(projectRoot, 'docs', 'coordination', 'runs', 'checkpoint.json'), '{}\n');
    const after = snapshotProjectFiles(projectRoot);
    assert.deepEqual(changedProjectFiles(before, after), ['app.mjs']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('resolveActiveAgents filters to single agent preserving order', () => {
  const agents = resolveActiveAgents(['claude']);
  assert.deepEqual(agents, ['claude']);
});

test('resolveActiveAgents filters to subset preserving default order', () => {
  const agents = resolveActiveAgents(['codex', 'claude']); // input order shouldn't matter
  assert.deepEqual(agents, ['claude', 'codex']); // default order preserved
});

test('resolveActiveAgents returns empty array for unknown agents', () => {
  const agents = resolveActiveAgents(['unknown']);
  assert.deepEqual(agents, []);
});

// ─── Adversarial: computeAdversarialResumePoint ──────────────────────────────

test('computeAdversarialResumePoint returns round 1, phase 0 for empty transcript', () => {
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint([]);
  assert.equal(startRound, 1);
  assert.equal(startPhaseIdx, 0);
});

test('computeAdversarialResumePoint advances to next phase within same round', () => {
  const transcript = [
    { round: 1, agent: 'claude', phase: 'diverge' },
  ];
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, 1);
  assert.equal(startPhaseIdx, 1); // next = attack
});

test('computeAdversarialResumePoint advances to next round after synthesize', () => {
  const transcript = [
    { round: 1, agent: 'claude', phase: 'diverge' },
    { round: 1, agent: 'claude', phase: 'attack' },
    { round: 1, agent: 'claude', phase: 'synthesize' },
  ];
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, 2);
  assert.equal(startPhaseIdx, 0); // next = diverge in round 2
});

test('computeAdversarialResumePoint returns Infinity when implement already done', () => {
  const transcript = [
    { round: 1, agent: 'claude', phase: 'synthesize' },
    { round: 1, agent: 'codex', phase: 'implement' },
  ];
  const { startRound } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, Infinity);
});
