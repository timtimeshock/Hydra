#!/usr/bin/env node
/**
 * Hydra MCP Client
 *
 * JSON-RPC over stdio transport for communicating with MCP servers
 * (primarily Codex MCP). Enables multi-turn context, structured tool calls,
 * and event streaming.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { loadHydraConfig } from './hydra-config.mjs';

let requestIdCounter = 0;

/**
 * MCPClient manages a long-lived child process communicating via JSON-RPC over stdin/stdout.
 */
export class MCPClient extends EventEmitter {
  constructor(command, args = [], opts = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = opts.cwd || process.cwd();
    this.sessionTimeout = opts.sessionTimeout || 300_000;
    this.child = null;
    this.pending = new Map(); // requestId -> { resolve, reject, timer }
    this.buffer = '';
    this.startedAt = null;
    this.lastActivityAt = null;
    this.idleTimer = null;
  }

  /**
   * Spawn the MCP server process and initialize JSON-RPC.
   */
  async start() {
    if (this.child) return;

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (data) => this._onData(data));
    this.child.stderr.on('data', (data) => this.emit('stderr', data));

    this.child.on('error', (err) => {
      this.emit('error', err);
      this._rejectAll(err);
    });

    this.child.on('close', (code) => {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      this.emit('close', code);
      this._rejectAll(new Error(`MCP process exited with code ${code}`));
      this.child = null;
    });

    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();
    this._resetIdleTimer();

    // Send initialize request
    const initResult = await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hydra', version: '1.0.0' },
    });

    // Send initialized notification
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    return initResult;
  }

  /**
   * Send a JSON-RPC request and await the response.
   */
  call(method, params = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('MCP client not started'));
        return;
      }

      const id = ++requestIdCounter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.lastActivityAt = Date.now();
      this._resetIdleTimer();

      this._send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  /**
   * Call an MCP tool.
   */
  async callTool(toolName, args = {}, timeoutMs = 60_000) {
    return this.call('tools/call', { name: toolName, arguments: args }, timeoutMs);
  }

  /**
   * List available tools.
   */
  async listTools() {
    return this.call('tools/list', {});
  }

  /**
   * Graceful shutdown.
   */
  async close() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.child) return;

    this._rejectAll(new Error('MCP client closing'));

    try {
      this.child.stdin.end();
    } catch { /* ignore */ }

    // Give process time to exit gracefully
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.child) {
          this.child.kill();
        }
        resolve();
      }, 3_000);

      if (this.child) {
        this.child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    });

    this.child = null;
  }

  /**
   * Check if the MCP server is alive.
   */
  isAlive() {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * Get uptime in milliseconds.
   */
  uptimeMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _send(obj) {
    if (!this.child?.stdin?.writable) return;
    const json = JSON.stringify(obj);
    try {
      this.child.stdin.write(json + '\n');
    } catch { /* ignore write errors */ }
  }

  _onData(data) {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch { /* skip non-JSON lines */ }
    }
  }

  _handleMessage(msg) {
    // Response to a request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);

      if (msg.error) {
        reject(new Error(msg.error.message || 'MCP error'));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Notification (no id)
    if (msg.method) {
      this.emit('notification', msg);
      return;
    }
  }

  _rejectAll(err) {
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.emit('idle');
      this.close();
    }, this.sessionTimeout);
    this.idleTimer.unref(); // Don't prevent process exit when idle
  }
}

// ── High-Level Codex MCP Helper ───────────────────────────────────────────────

let codexClient = null;

/**
 * Get or create a Codex MCP client.
 */
export function getCodexMCPClient(opts = {}) {
  const cfg = loadHydraConfig();
  const mcpConfig = cfg.mcp?.codex;

  if (!mcpConfig?.enabled) return null;
  if (codexClient?.isAlive()) return codexClient;

  codexClient = new MCPClient(
    mcpConfig.command || 'codex',
    mcpConfig.args || ['mcp-server'],
    {
      cwd: opts.cwd || process.cwd(),
      sessionTimeout: mcpConfig.sessionTimeout || 300_000,
    }
  );

  return codexClient;
}

/**
 * Call Codex via MCP with optional multi-turn context.
 * Falls back gracefully if MCP is not available.
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} [opts.threadId] - Thread ID for multi-turn context
 * @param {string} [opts.cwd]
 * @returns {{ ok: boolean, result: string, threadId?: string, viaMCP: boolean }}
 */
export async function codexMCP(prompt, opts = {}) {
  const client = getCodexMCPClient({ cwd: opts.cwd });
  if (!client) {
    return { ok: false, result: '', viaMCP: false, error: 'MCP not enabled' };
  }

  try {
    if (!client.isAlive()) {
      await client.start();
    }

    // Use codex-reply if we have a threadId for multi-turn context
    const toolName = opts.threadId ? 'codex-reply' : 'codex';
    const args = opts.threadId
      ? { thread_id: opts.threadId, prompt }
      : { prompt };

    const result = await client.callTool(toolName, args, 120_000);
    const text = Array.isArray(result?.content)
      ? result.content.map((c) => c.text || '').join('\n')
      : String(result?.content || result || '');

    // Extract threadId from response if available (for subsequent calls)
    const threadId = result?.conversationId || result?.threadId || opts.threadId;

    return {
      ok: true,
      result: text,
      threadId: threadId || undefined,
      viaMCP: true,
    };
  } catch (err) {
    return {
      ok: false,
      result: '',
      viaMCP: true,
      error: err.message,
    };
  }
}

/**
 * Gracefully close the Codex MCP client.
 */
export async function closeCodexMCP() {
  if (codexClient) {
    await codexClient.close();
    codexClient = null;
  }
}
