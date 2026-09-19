#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { build } from 'esbuild';

const args = process.argv.slice(2);
const isCi = args.includes('--ci');
const targetArg = args.find((arg) => arg.startsWith('--target='));
const outputArg = args.find((arg) => arg.startsWith('--output='));

const target = targetArg ? targetArg.slice('--target='.length) : (process.env.HYDRA_EXE_TARGET || 'node20-win-x64');
const output = outputArg ? outputArg.slice('--output='.length) : 'dist/hydra.exe';

const projectRoot = process.cwd();
const outputPath = path.resolve(projectRoot, output);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const bundleDir = path.join(projectRoot, '.build-exe');
const bundlePath = path.join(bundleDir, 'hydra-cli.bundle.cjs');
fs.mkdirSync(bundleDir, { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, 'bin', 'hydra-cli.mjs')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  legalComments: 'none',
  sourcemap: false,
  define: {
    'import.meta.url': '"file:///C:/snapshot/.build-exe/hydra-cli.bundle.cjs"',
  },
});

const pkgArgs = [
  '@yao-pkg/pkg',
  bundlePath,
  '--targets',
  target,
  '--output',
  outputPath,
  '--public-packages',
  '*',
  '--public',
  '--no-bytecode',
];

const result = spawnSync('npx', pkgArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PKG_CACHE_PATH: process.env.PKG_CACHE_PATH || path.join(projectRoot, '.pkg-cache'),
  },
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

if (!isCi) {
  process.stdout.write(`\nBuilt standalone executable: ${outputPath}\n`);
}
