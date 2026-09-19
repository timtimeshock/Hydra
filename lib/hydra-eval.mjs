#!/usr/bin/env node
/**
 * Hydra Eval Harness — Routing accuracy evaluation against golden corpora.
 *
 * Evaluates classifyPrompt() and bestAgentFor() against labeled test cases.
 * Generates JSON + Markdown reports to docs/coordination/eval/.
 *
 * Usage:
 *   node lib/hydra-eval.mjs                     # Run with default corpus
 *   node lib/hydra-eval.mjs path/to/corpus.json  # Run with custom corpus
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyPrompt } from './hydra-utils.mjs';
import { bestAgentFor, classifyTask, initAgentRegistry } from './hydra-agents.mjs';
import { loadHydraConfig, HYDRA_ROOT } from './hydra-config.mjs';

const EVAL_DIR = path.join(HYDRA_ROOT, 'docs', 'coordination', 'eval');

/**
 * Load a golden corpus from a JSON file.
 * @param {string[]} paths - Paths to corpus JSON files
 * @returns {Array<{prompt: string, expected: object}>}
 */
export function loadGoldenCorpus(paths) {
  const corpus = [];
  for (const p of paths) {
    const resolved = path.isAbsolute(p) ? p : path.join(HYDRA_ROOT, p);
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.corpus)) {
        corpus.push(...data.corpus);
      } else if (Array.isArray(data)) {
        corpus.push(...data);
      }
    } catch (err) {
      console.error(`Failed to load corpus ${p}: ${err.message}`);
    }
  }
  return corpus;
}

/**
 * Evaluate routing classification accuracy.
 * @param {Array<{prompt: string, expected: object}>} corpus
 * @returns {object} Evaluation results
 */
export function evaluateRouting(corpus) {
  let correct = 0;
  const perStrategy = { single: { correct: 0, total: 0 }, tandem: { correct: 0, total: 0 }, council: { correct: 0, total: 0 } };
  const perTaskType = {};
  const mismatches = [];

  for (const entry of corpus) {
    const result = classifyPrompt(entry.prompt);
    const expectedRoute = entry.expected.routeStrategy;
    const expectedTaskType = entry.expected.taskType;

    // Route strategy match
    const routeMatch = result.routeStrategy === expectedRoute;

    // Task type match (use classifyTask as fallback)
    const actualTaskType = result.taskType || classifyTask(entry.prompt);
    const taskTypeMatch = actualTaskType === expectedTaskType;

    if (routeMatch) correct++;

    // Per-strategy tracking
    if (perStrategy[expectedRoute]) {
      perStrategy[expectedRoute].total++;
      if (routeMatch) perStrategy[expectedRoute].correct++;
    }

    // Per-task-type tracking
    if (!perTaskType[expectedTaskType]) perTaskType[expectedTaskType] = { correct: 0, total: 0 };
    perTaskType[expectedTaskType].total++;
    if (taskTypeMatch) perTaskType[expectedTaskType].correct++;

    if (!routeMatch || !taskTypeMatch) {
      mismatches.push({
        prompt: entry.prompt.slice(0, 100),
        expectedRoute,
        actualRoute: result.routeStrategy,
        expectedTaskType,
        actualTaskType,
        routeMatch,
        taskTypeMatch,
        confidence: result.confidence,
        reason: result.reason,
      });
    }
  }

  const total = corpus.length;
  return {
    total,
    correct,
    accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
    perStrategy: Object.fromEntries(
      Object.entries(perStrategy).map(([k, v]) => [
        k,
        { ...v, accuracy: v.total > 0 ? Math.round((v.correct / v.total) * 1000) / 10 : 0 },
      ]),
    ),
    perTaskType: Object.fromEntries(
      Object.entries(perTaskType).map(([k, v]) => [
        k,
        { ...v, accuracy: v.total > 0 ? Math.round((v.correct / v.total) * 1000) / 10 : 0 },
      ]),
    ),
    mismatches,
  };
}

/**
 * Evaluate agent selection accuracy.
 * @param {Array<{prompt: string, expected: object}>} corpus
 * @returns {object}
 */
export function evaluateAgentSelection(corpus) {
  let correct = 0;
  const mismatches = [];

  for (const entry of corpus) {
    if (!entry.expected.agent) continue;
    const taskType = entry.expected.taskType || classifyTask(entry.prompt);
    const actual = bestAgentFor(taskType);
    const match = actual === entry.expected.agent;
    if (match) correct++;
    else {
      mismatches.push({
        prompt: entry.prompt.slice(0, 100),
        expectedAgent: entry.expected.agent,
        actualAgent: actual,
        taskType,
      });
    }
  }

  const withAgent = corpus.filter(e => e.expected.agent).length;
  return {
    total: withAgent,
    correct,
    accuracy: withAgent > 0 ? Math.round((correct / withAgent) * 1000) / 10 : 0,
    mismatches,
  };
}

/**
 * Generate eval reports (JSON + Markdown).
 * @param {object} routingResults
 * @param {object} [agentResults]
 * @returns {{ jsonPath: string, mdPath: string }}
 */
export function generateEvalReport(routingResults, agentResults) {
  if (!fs.existsSync(EVAL_DIR)) fs.mkdirSync(EVAL_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const data = {
    timestamp: new Date().toISOString(),
    routing: routingResults,
    agentSelection: agentResults || null,
  };

  const jsonPath = path.join(EVAL_DIR, `eval_${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');

  // Markdown report
  const lines = [
    `# Eval Report — ${new Date().toISOString().slice(0, 16)}`,
    '',
    '## Routing Classification',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total prompts | ${routingResults.total} |`,
    `| Correct routes | ${routingResults.correct} |`,
    `| **Accuracy** | **${routingResults.accuracy}%** |`,
    '',
    '### Per Strategy',
    '',
    `| Strategy | Correct | Total | Accuracy |`,
    `|----------|---------|-------|----------|`,
  ];
  for (const [strategy, stats] of Object.entries(routingResults.perStrategy)) {
    lines.push(`| ${strategy} | ${stats.correct} | ${stats.total} | ${stats.accuracy}% |`);
  }

  if (Object.keys(routingResults.perTaskType).length > 0) {
    lines.push('', '### Per Task Type', '', '| Type | Correct | Total | Accuracy |', '|------|---------|-------|----------|');
    for (const [type, stats] of Object.entries(routingResults.perTaskType)) {
      lines.push(`| ${type} | ${stats.correct} | ${stats.total} | ${stats.accuracy}% |`);
    }
  }

  if (routingResults.mismatches.length > 0) {
    lines.push('', '### Mismatches', '');
    for (const m of routingResults.mismatches.slice(0, 15)) {
      const routeIcon = m.routeMatch ? '' : ` route: ${m.expectedRoute}!=${m.actualRoute}`;
      const typeIcon = m.taskTypeMatch ? '' : ` type: ${m.expectedTaskType}!=${m.actualTaskType}`;
      lines.push(`- "${m.prompt}"${routeIcon}${typeIcon}`);
    }
    if (routingResults.mismatches.length > 15) {
      lines.push(`- ... and ${routingResults.mismatches.length - 15} more`);
    }
  }

  if (agentResults && agentResults.total > 0) {
    lines.push('', '## Agent Selection', '', `Accuracy: ${agentResults.accuracy}% (${agentResults.correct}/${agentResults.total})`);
    if (agentResults.mismatches.length > 0) {
      lines.push('', '### Mismatches', '');
      for (const m of agentResults.mismatches.slice(0, 10)) {
        lines.push(`- "${m.prompt}" — expected ${m.expectedAgent}, got ${m.actualAgent} (${m.taskType})`);
      }
    }
  }

  lines.push('');
  const mdPath = path.join(EVAL_DIR, `eval_${timestamp}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'));

  return { jsonPath, mdPath };
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  (async () => {
    // Initialize agent registry
    initAgentRegistry();

    const cfg = loadHydraConfig();
    const corpusPaths = process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : (cfg.eval?.corpusPaths || ['test/golden/routing-corpus.json']);

    console.log(`Loading corpus from: ${corpusPaths.join(', ')}`);
    const corpus = loadGoldenCorpus(corpusPaths);
    console.log(`Loaded ${corpus.length} test cases`);

    if (corpus.length === 0) {
      console.error('No test cases found.');
      process.exit(1);
    }

    console.log('\nEvaluating routing classification...');
    const routingResults = evaluateRouting(corpus);
    console.log(`  Route accuracy: ${routingResults.accuracy}% (${routingResults.correct}/${routingResults.total})`);
    for (const [strategy, stats] of Object.entries(routingResults.perStrategy)) {
      if (stats.total > 0) {
        console.log(`    ${strategy}: ${stats.accuracy}% (${stats.correct}/${stats.total})`);
      }
    }

    console.log('\nEvaluating agent selection...');
    const agentResults = evaluateAgentSelection(corpus);
    if (agentResults.total > 0) {
      console.log(`  Agent accuracy: ${agentResults.accuracy}% (${agentResults.correct}/${agentResults.total})`);
    } else {
      console.log('  (no agent labels in corpus — skipped)');
    }

    if (routingResults.mismatches.length > 0) {
      console.log(`\nMismatches (${routingResults.mismatches.length}):`);
      for (const m of routingResults.mismatches.slice(0, 10)) {
        const parts = [];
        if (!m.routeMatch) parts.push(`route: ${m.expectedRoute}→${m.actualRoute}`);
        if (!m.taskTypeMatch) parts.push(`type: ${m.expectedTaskType}→${m.actualTaskType}`);
        console.log(`  "${m.prompt.slice(0, 60)}" — ${parts.join(', ')}`);
      }
    }

    const { jsonPath, mdPath } = generateEvalReport(routingResults, agentResults);
    console.log(`\nReports saved:`);
    console.log(`  JSON: ${path.relative(HYDRA_ROOT, jsonPath)}`);
    console.log(`  MD:   ${path.relative(HYDRA_ROOT, mdPath)}`);
  })();
}
