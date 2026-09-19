/**
 * Tests for hydra-prompt-choice.mjs — multi-select parsing and confirmActionPlan.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseMultiSelectInput } from '../lib/hydra-prompt-choice.mjs';

describe('parseMultiSelectInput', () => {
  it('returns "all" for "a" input', () => {
    assert.equal(parseMultiSelectInput('a', 5), 'all');
    assert.equal(parseMultiSelectInput('all', 5), 'all');
    assert.equal(parseMultiSelectInput('ALL', 5), 'all');
  });

  it('parses single numbers', () => {
    assert.deepEqual(parseMultiSelectInput('3', 5), [2]);
    assert.deepEqual(parseMultiSelectInput('1', 5), [0]);
  });

  it('parses comma-separated numbers', () => {
    assert.deepEqual(parseMultiSelectInput('1,3,5', 5), [0, 2, 4]);
    assert.deepEqual(parseMultiSelectInput('2, 4', 5), [1, 3]);
  });

  it('parses ranges', () => {
    assert.deepEqual(parseMultiSelectInput('1-3', 5), [0, 1, 2]);
    assert.deepEqual(parseMultiSelectInput('2-4', 5), [1, 2, 3]);
  });

  it('parses mixed numbers and ranges', () => {
    assert.deepEqual(parseMultiSelectInput('1,3-5', 5), [0, 2, 3, 4]);
  });

  it('deduplicates overlapping selections', () => {
    assert.deepEqual(parseMultiSelectInput('1,1,2', 5), [0, 1]);
    assert.deepEqual(parseMultiSelectInput('1-3,2', 5), [0, 1, 2]);
  });

  it('returns null for empty input', () => {
    assert.equal(parseMultiSelectInput('', 5), null);
    assert.equal(parseMultiSelectInput('  ', 5), null);
  });

  it('returns null for out-of-range numbers', () => {
    assert.equal(parseMultiSelectInput('0', 5), null);
    assert.equal(parseMultiSelectInput('6', 5), null);
    assert.equal(parseMultiSelectInput('1,10', 5), null);
  });

  it('returns null for invalid ranges', () => {
    assert.equal(parseMultiSelectInput('3-1', 5), null);   // reversed
    assert.equal(parseMultiSelectInput('0-3', 5), null);   // below 1
    assert.equal(parseMultiSelectInput('3-10', 5), null);  // above max
  });

  it('returns null for non-numeric input', () => {
    assert.equal(parseMultiSelectInput('abc', 5), null);
    assert.equal(parseMultiSelectInput('x', 5), null);
  });

  it('handles space-separated numbers', () => {
    assert.deepEqual(parseMultiSelectInput('1 3 5', 5), [0, 2, 4]);
  });

  it('returns sorted indices', () => {
    assert.deepEqual(parseMultiSelectInput('5,1,3', 5), [0, 2, 4]);
  });
});
