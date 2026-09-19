import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadGoldenCorpus, evaluateRouting, evaluateAgentSelection, generateEvalReport } from '../lib/hydra-eval.mjs';
import { initAgentRegistry, _resetRegistry } from '../lib/hydra-agents.mjs';

describe('hydra-eval', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-eval-'));
    initAgentRegistry();
  });

  afterEach(() => {
    _resetRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadGoldenCorpus', () => {
    it('loads corpus from JSON file', () => {
      const corpusData = {
        corpus: [
          { prompt: 'test prompt', expected: { routeStrategy: 'single', taskType: 'implementation' } },
        ],
      };
      const file = path.join(tmpDir, 'test-corpus.json');
      fs.writeFileSync(file, JSON.stringify(corpusData));

      const result = loadGoldenCorpus([file]);
      assert.equal(result.length, 1);
      assert.equal(result[0].prompt, 'test prompt');
    });

    it('handles missing files gracefully', () => {
      const result = loadGoldenCorpus([path.join(tmpDir, 'nonexistent.json')]);
      assert.equal(result.length, 0);
    });

    it('merges multiple corpus files', () => {
      for (let i = 0; i < 3; i++) {
        const file = path.join(tmpDir, `corpus-${i}.json`);
        fs.writeFileSync(file, JSON.stringify({ corpus: [{ prompt: `prompt ${i}`, expected: { routeStrategy: 'single' } }] }));
      }
      const files = [0, 1, 2].map(i => path.join(tmpDir, `corpus-${i}.json`));
      const result = loadGoldenCorpus(files);
      assert.equal(result.length, 3);
    });
  });

  describe('evaluateRouting', () => {
    it('calculates accuracy for simple corpus', () => {
      const corpus = [
        { prompt: 'Fix the typo', expected: { routeStrategy: 'single', taskType: 'implementation', tier: 'simple' } },
        { prompt: 'Add a test', expected: { routeStrategy: 'single', taskType: 'testing', tier: 'simple' } },
      ];
      const result = evaluateRouting(corpus);
      assert.equal(result.total, 2);
      assert.ok(result.accuracy >= 0 && result.accuracy <= 100);
      assert.ok(result.perStrategy.single.total >= 0);
    });

    it('tracks mismatches', () => {
      const corpus = [
        { prompt: 'Simple fix', expected: { routeStrategy: 'council', taskType: 'implementation', tier: 'complex' } },
      ];
      const result = evaluateRouting(corpus);
      // A simple prompt classified as council should mismatch on route
      if (result.mismatches.length > 0) {
        assert.ok(result.mismatches[0].prompt);
        assert.ok('routeMatch' in result.mismatches[0]);
      }
    });

    it('handles empty corpus', () => {
      const result = evaluateRouting([]);
      assert.equal(result.total, 0);
      assert.equal(result.accuracy, 0);
    });
  });

  describe('evaluateAgentSelection', () => {
    it('skips entries without expected agent', () => {
      const corpus = [
        { prompt: 'Test', expected: { routeStrategy: 'single', taskType: 'testing' } },
      ];
      const result = evaluateAgentSelection(corpus);
      assert.equal(result.total, 0);
    });

    it('evaluates entries with agent labels', () => {
      const corpus = [
        { prompt: 'Fix the bug', expected: { routeStrategy: 'single', taskType: 'implementation', agent: 'codex' } },
      ];
      const result = evaluateAgentSelection(corpus);
      assert.equal(result.total, 1);
      assert.ok(result.accuracy >= 0);
    });
  });

  describe('generateEvalReport', () => {
    it('generates JSON and MD files', () => {
      const routingResults = {
        total: 10,
        correct: 8,
        accuracy: 80,
        perStrategy: {
          single: { correct: 5, total: 5, accuracy: 100 },
          tandem: { correct: 2, total: 3, accuracy: 66.7 },
          council: { correct: 1, total: 2, accuracy: 50 },
        },
        perTaskType: {
          implementation: { correct: 3, total: 3, accuracy: 100 },
        },
        mismatches: [{ prompt: 'test', expectedRoute: 'council', actualRoute: 'single', routeMatch: false, taskTypeMatch: true }],
      };

      const { jsonPath, mdPath } = generateEvalReport(routingResults);
      assert.ok(fs.existsSync(jsonPath), 'JSON report should exist');
      assert.ok(fs.existsSync(mdPath), 'MD report should exist');

      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.equal(json.routing.accuracy, 80);

      const md = fs.readFileSync(mdPath, 'utf8');
      assert.ok(md.includes('80%'));
      assert.ok(md.includes('Routing Classification'));
    });
  });
});
