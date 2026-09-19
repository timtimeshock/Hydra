/**
 * hydra-updater.mjs — Non-blocking update check against remote master
 *
 * Fetches the remote package.json from GitHub once per 24h (cached).
 * Returns update info or null. Never throws — fails silently when offline.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HYDRA_ROOT } from './hydra-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_PATH   = join(HYDRA_ROOT, 'docs/coordination/.update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

// Derive remote URL from package.json repository field
const LOCAL_PKG = JSON.parse(readFileSync(join(HYDRA_ROOT, 'package.json'), 'utf8'));
const LOCAL_VERSION = LOCAL_PKG.version;

// Extract owner/repo from git URL: "git+https://github.com/Owner/Repo.git"
function parseRepoUrl(url = '') {
  const m = url.match(/github\.com[/:]([\w-]+)\/([\w-]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

const repoInfo = parseRepoUrl(LOCAL_PKG?.repository?.url || '');
const REMOTE_PKG_URL = repoInfo
  ? `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/master/package.json`
  : null;

// ── Cache helpers ────────────────────────────────────────────────────────────

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ ...data, checkedAt: Date.now() }, null, 2), 'utf8');
  } catch { /* non-critical */ }
  return data;
}

// ── Semver comparison ────────────────────────────────────────────────────────

function semverGt(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether a newer version of Hydra is available on the remote master branch.
 * Reads from a 24h disk cache; only makes a network call when stale.
 *
 * @returns {Promise<{ hasUpdate: boolean, remoteVersion: string, localVersion: string } | null>}
 *   Returns null on network error or when no repo URL is configured.
 */
export async function checkForUpdates() {
  if (!REMOTE_PKG_URL) return null;

  // Serve from cache if fresh
  const cache = loadCache();
  if (cache && typeof cache.checkedAt === 'number' && (Date.now() - cache.checkedAt) < CACHE_TTL_MS) {
    return cache.hasUpdate ? cache : null;
  }

  try {
    const res = await fetch(REMOTE_PKG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': `hydra-updater/${LOCAL_VERSION}` },
    });
    if (!res.ok) return saveCache({ hasUpdate: false, localVersion: LOCAL_VERSION });

    const pkg = await res.json();
    const remoteVersion = pkg?.version;
    if (!remoteVersion) return null;

    const hasUpdate = semverGt(remoteVersion, LOCAL_VERSION);
    return saveCache({ hasUpdate, remoteVersion, localVersion: LOCAL_VERSION });
  } catch {
    // Offline, timeout, or parse error — don't save cache so we retry next startup
    return null;
  }
}

/**
 * Invalidate the cached update check (force re-check on next call).
 */
export function invalidateUpdateCache() {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ checkedAt: 0, hasUpdate: false }), 'utf8');
  } catch { /* non-critical */ }
}
