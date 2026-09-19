#!/usr/bin/env node

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HYDRA_EMBEDDED_ROOT = path.resolve(__dirname, '..');
export const HYDRA_STANDALONE = Boolean(process.pkg);
export const HYDRA_INTERNAL_FLAG = '--hydra-internal';

const INTERNAL_MODULE_LOADERS = {
  'lib/hydra-operator.mjs': () => import('./hydra-operator.mjs'),
  'lib/orchestrator-daemon.mjs': () => import('./orchestrator-daemon.mjs'),
  'lib/orchestrator-client.mjs': () => import('./orchestrator-client.mjs'),
  'lib/hydra-council.mjs': () => import('./hydra-council.mjs'),
  'lib/hydra-dispatch.mjs': () => import('./hydra-dispatch.mjs'),
  'lib/hydra-models-select.mjs': () => import('./hydra-models-select.mjs'),
  'lib/hydra-tasks.mjs': () => import('./hydra-tasks.mjs'),
  'lib/hydra-tasks-review.mjs': () => import('./hydra-tasks-review.mjs'),
  'lib/hydra-nightly.mjs': () => import('./hydra-nightly.mjs'),
  'lib/hydra-nightly-review.mjs': () => import('./hydra-nightly-review.mjs'),
  'lib/hydra-evolve.mjs': () => import('./hydra-evolve.mjs'),
  'lib/hydra-evolve-review.mjs': () => import('./hydra-evolve-review.mjs'),
  'lib/sync.mjs': () => import('./sync.mjs'),
  'lib/hydra-setup.mjs': () => import('./hydra-setup.mjs'),
};

function normalizeModuleId(moduleId) {
  const normalized = String(moduleId || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!normalized) return '';
  if (normalized.includes('..')) return '';
  return normalized;
}

export function toHydraModuleId(scriptPath, hydraRoot = HYDRA_EMBEDDED_ROOT) {
  const absolute = path.resolve(scriptPath);
  const rel = path.relative(hydraRoot, absolute).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) {
    return '';
  }
  return normalizeModuleId(rel);
}

export function rewriteNodeInvocation(command, args = [], hydraRoot = HYDRA_EMBEDDED_ROOT) {
  if (!HYDRA_STANDALONE || command !== 'node' || !Array.isArray(args) || args.length === 0) {
    return { command, args };
  }

  const [scriptPath, ...scriptArgs] = args;
  const moduleId = toHydraModuleId(scriptPath, hydraRoot);
  if (!moduleId) {
    throw new Error(`Standalone Hydra cannot execute external script: ${scriptPath}`);
  }

  return {
    command: process.execPath,
    args: [HYDRA_INTERNAL_FLAG, moduleId, ...scriptArgs],
  };
}

export function spawnHydraNode(scriptPath, scriptArgs = [], options = {}, hydraRoot = HYDRA_EMBEDDED_ROOT) {
  const invocation = rewriteNodeInvocation('node', [scriptPath, ...scriptArgs], hydraRoot);
  return spawn(invocation.command, invocation.args, options);
}

export function spawnHydraNodeSync(scriptPath, scriptArgs = [], options = {}, hydraRoot = HYDRA_EMBEDDED_ROOT) {
  const invocation = rewriteNodeInvocation('node', [scriptPath, ...scriptArgs], hydraRoot);
  return spawnSync(invocation.command, invocation.args, options);
}

export async function runHydraInternalModule(moduleId, moduleArgs = [], hydraRoot = HYDRA_EMBEDDED_ROOT) {
  const normalized = normalizeModuleId(moduleId);
  if (!normalized) {
    throw new Error('Missing or invalid Hydra internal module id.');
  }

  // Standalone executables route through a static import map so bundlers can include modules.
  if (HYDRA_STANDALONE) {
    const loader = INTERNAL_MODULE_LOADERS[normalized];
    if (!loader) {
      throw new Error(`Standalone build does not include internal module: ${normalized}`);
    }
    process.argv = [process.execPath, normalized, ...moduleArgs];
    await loader();
    return;
  }

  const modulePath = path.join(hydraRoot, normalized);
  const moduleUrl = pathToFileURL(modulePath).href;
  process.argv = [process.execPath, modulePath, ...moduleArgs];
  await import(moduleUrl);
}
