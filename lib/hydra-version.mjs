/**
 * Hydra Version — derives version string from package.json + git state.
 *
 * Format:  1.2.0-40-g4bdb7b9  (semver-commitCount-gShortHash)
 * Falls back to plain semver if git is unavailable.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');

let _cached = null;

function readGit(cmd) {
  try {
    return execSync(cmd, { cwd: join(__dirname, '..'), encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return null; }
}

export function getVersion() {
  if (_cached) return _cached;

  let semver = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    semver = pkg.version || semver;
  } catch { /* use fallback */ }

  const commitCount = readGit('git rev-list --count HEAD');
  const shortHash = readGit('git rev-parse --short HEAD');
  const dirty = readGit('git status --porcelain');

  let full = semver;
  if (commitCount && shortHash) {
    full = `${semver}-${commitCount}-g${shortHash}`;
  }
  if (dirty) full += '-dirty';

  _cached = { semver, commitCount, shortHash, dirty: !!dirty, full };
  return _cached;
}

export function versionString() {
  return getVersion().full;
}
