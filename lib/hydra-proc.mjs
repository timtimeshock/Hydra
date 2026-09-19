#!/usr/bin/env node
/**
 * Hydra process helpers.
 *
 * Some sandboxed environments (including certain CI / agent sandboxes) forbid
 * creating stdio pipes for child processes, returning EPERM when `stdio: 'pipe'`
 * is used (the default for spawnSync/exec). Hydra uses sync process execution
 * for git/gh and other tooling, so we provide a best-effort fallback that
 * captures stdout/stderr via temporary files (no pipes).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 * 8;

function safeRm(dirPath) {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function readFileTruncated(filePath, maxBytes, encoding) {
  try {
    const st = fs.statSync(filePath);
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_OUTPUT_BYTES;
    if (st.size <= limit) {
      return fs.readFileSync(filePath, { encoding });
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(limit);
      const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
      const suffix = `\n... (truncated, showing first ${bytesRead} bytes)`;
      return buf.slice(0, bytesRead).toString(encoding) + suffix;
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return '';
  }
}

/**
 * Detect if this environment supports spawning child processes with piped stdio.
 * @returns {boolean}
 */
export function supportsPipedStdio() {
  try {
    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 5_000,
    });
    if (r.error && String(r.error?.code || '') === 'EPERM') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn synchronously and capture stdout/stderr. Falls back to file-backed
 * stdio capture when pipes are forbidden (EPERM).
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {object} [opts.env]
 * @param {number} [opts.timeout]
 * @param {string} [opts.encoding='utf8']
 * @param {boolean} [opts.windowsHide=true]
 * @param {boolean} [opts.shell=false]
 * @param {string|Buffer} [opts.input] - stdin data (no pipes fallback uses temp file)
 * @param {number} [opts.maxOutputBytes=8MiB] - per stream cap when using file capture
 * @param {boolean} [opts.noPipes=false] - force file-backed capture
 * @returns {{ status: number|null, stdout: string, stderr: string, error: Error|null, signal: string|null }}
 */
export function spawnSyncCapture(command, args = [], opts = {}) {
  const encoding = opts.encoding || 'utf8';
  const maxOutputBytes = Number.isFinite(opts.maxOutputBytes) ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const forceNoPipes = Boolean(opts.noPipes || process.env.HYDRA_NO_PIPES);

  if (!forceNoPipes) {
    const r = spawnSync(command, Array.isArray(args) ? args : [], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      encoding,
      windowsHide: opts.windowsHide !== false,
      shell: Boolean(opts.shell),
      input: opts.input,
      maxBuffer: maxOutputBytes,
    });

    const stdout = typeof r.stdout === 'string'
      ? r.stdout
      : r.stdout
        ? Buffer.from(r.stdout).toString(encoding)
        : '';
    const stderr = typeof r.stderr === 'string'
      ? r.stderr
      : r.stderr
        ? Buffer.from(r.stderr).toString(encoding)
        : '';

    if (!(r.error && String(r.error?.code || '') === 'EPERM')) {
      return {
        status: r.status ?? null,
        stdout,
        stderr,
        error: r.error || null,
        signal: r.signal || null,
      };
    }
  }

  // Fallback: no pipes. Use temp files for stdio.
  let tmpDir = '';
  let stdinFd = 'ignore';
  let stdoutFd = null;
  let stderrFd = null;

  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-proc-'));
    const _stdoutPath = path.join(tmpDir, 'stdout.txt');
    const _stderrPath = path.join(tmpDir, 'stderr.txt');
    const _stdinPath = path.join(tmpDir, 'stdin.txt');

    stdoutFd = fs.openSync(_stdoutPath, 'w');
    stderrFd = fs.openSync(_stderrPath, 'w');

    if (opts.input !== undefined) {
      const buf = Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(String(opts.input), encoding);
      fs.writeFileSync(_stdinPath, buf);
      stdinFd = fs.openSync(_stdinPath, 'r');
    }

    const r = spawnSync(command, Array.isArray(args) ? args : [], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      windowsHide: opts.windowsHide !== false,
      shell: Boolean(opts.shell),
      stdio: [stdinFd, stdoutFd, stderrFd],
    });

    // Close fds before reading.
    if (typeof stdinFd === 'number') {
      try { fs.closeSync(stdinFd); } catch { /* ignore */ }
    }
    if (typeof stdoutFd === 'number') {
      try { fs.closeSync(stdoutFd); } catch { /* ignore */ }
    }
    if (typeof stderrFd === 'number') {
      try { fs.closeSync(stderrFd); } catch { /* ignore */ }
    }

    const stdout = readFileTruncated(_stdoutPath, maxOutputBytes, encoding);
    const stderr = readFileTruncated(_stderrPath, maxOutputBytes, encoding);

    return {
      status: r.status ?? null,
      stdout,
      stderr,
      error: r.error || null,
      signal: r.signal || null,
    };
  } finally {
    // In case of early exceptions, close what we can.
    if (typeof stdinFd === 'number') {
      try { fs.closeSync(stdinFd); } catch { /* ignore */ }
    }
    if (typeof stdoutFd === 'number') {
      try { fs.closeSync(stdoutFd); } catch { /* ignore */ }
    }
    if (typeof stderrFd === 'number') {
      try { fs.closeSync(stderrFd); } catch { /* ignore */ }
    }
    safeRm(tmpDir);
  }
}
