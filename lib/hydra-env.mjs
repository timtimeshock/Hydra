/**
 * Hydra Env — Minimal .env file loader (no dependencies).
 *
 * Parses HYDRA_ROOT/.env: strips comments (#), blank lines, splits on first =,
 * trims whitespace, handles quoted values. Only sets process.env[key] if not
 * already set (real env vars take priority). Silent no-op if .env doesn't exist.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HYDRA_ROOT = path.resolve(__dirname, '..');

let _loaded = false;

export function loadEnvFile(filePath) {
  if (_loaded) return;
  _loaded = true;

  const envPath = filePath || path.join(HYDRA_ROOT, '.env');
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env — silent no-op
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip matching surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Only set if not already defined (real env vars take priority)
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Check whether a .env file exists at the Hydra root. */
export function envFileExists() {
  return fs.existsSync(path.join(HYDRA_ROOT, '.env'));
}

// Auto-load on import
loadEnvFile();
