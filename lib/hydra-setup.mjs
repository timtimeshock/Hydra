#!/usr/bin/env node
/**
 * Hydra Setup — CLI detection, MCP registration, and project initialization.
 *
 * Detects installed AI CLIs (claude, gemini, codex), registers Hydra's MCP
 * server with each, and provides a project init workflow for HYDRA.md.
 *
 * Usage:
 *   node lib/hydra-setup.mjs setup [--force] [--uninstall]
 *   node lib/hydra-setup.mjs init [--project-name=MyProject]
 *   node lib/hydra-setup.mjs --help
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync as nodeSpawnSync } from 'child_process';
import crossSpawn from 'cross-spawn';
import { fileURLToPath } from 'url';

/** Cross-platform spawnSync — uses cross-spawn on Windows for .cmd/.bat shim support. */
const spawnSync = (cmd, args, opts) => crossSpawn.sync(cmd, args, opts);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Path Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the Hydra installation root (one level above lib/).
 * @returns {string}
 */
export function resolveHydraRoot() {
  return path.resolve(__dirname, '..');
}

/**
 * Resolve the absolute path to hydra-mcp-server.mjs with forward slashes.
 * Forward slashes ensure cross-platform MCP config compatibility.
 * @returns {string}
 */
export function resolveMcpServerPath() {
  return path.join(resolveHydraRoot(), 'lib', 'hydra-mcp-server.mjs').replace(/\\/g, '/');
}

/**
 * Resolve the path to the node binary.
 * @returns {string}
 */
export function resolveNodePath() {
  return process.execPath;
}

// ── CLI Detection ───────────────────────────────────────────────────────────

/**
 * Check if a command exists on PATH.
 * Uses `where` on Windows, `which` on Unix.
 * @param {string} name
 * @returns {boolean}
 */
function commandExists(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(cmd, [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 && Boolean((result.stdout || '').trim());
  } catch {
    return false;
  }
}

/**
 * Detect which AI CLIs are installed and accessible on PATH.
 * @returns {{ claude: boolean, gemini: boolean, codex: boolean }}
 */
export function detectInstalledCLIs() {
  return {
    claude: commandExists('claude'),
    gemini: commandExists('gemini'),
    codex: commandExists('codex'),
  };
}

/**
 * Default Council models written into hydra.config.json on setup/postinstall.
 * Opus is NOT a separate CLI — it runs via `claude` with an Opus model id.
 */
export const DEFAULT_AGENT_MODELS = Object.freeze({
  claude: {
    default: 'claude-sonnet-4-6',
    fast: 'claude-sonnet-4-5-20250929',
    cheap: 'claude-haiku-4-5-20251001',
    active: 'default',
  },
  opus: {
    default: 'claude-opus-4-6',
    fast: 'claude-opus-4-6',
    cheap: 'claude-sonnet-4-6',
    active: 'default',
  },
  codex: {
    default: 'gpt-5.6-terra',
    fast: 'gpt-5.6-terra',
    cheap: 'gpt-5.6-terra',
    active: 'default',
  },
});

/**
 * Ensure hydra.config.json has Claude / Opus / Codex model slots.
 * Opus shares the Claude Code CLI (same `claude` binary on PATH).
 * @param {{ force?: boolean }} [opts]
 * @returns {{ ok: boolean, message: string, clis: object, changed: boolean }}
 */
export async function ensureDefaultAgentModels(opts = {}) {
  const force = Boolean(opts.force);
  const clis = detectInstalledCLIs();
  const { loadHydraConfig, saveHydraConfig } = await import('./hydra-config.mjs');
  const cfg = loadHydraConfig();
  if (!cfg.models || typeof cfg.models !== 'object') cfg.models = {};

  let changed = false;
  for (const [agent, preset] of Object.entries(DEFAULT_AGENT_MODELS)) {
    const cur = cfg.models[agent];
    const missing = !cur || typeof cur !== 'object' || !cur.default;
    if (force || missing) {
      cfg.models[agent] = force
        ? { ...preset }
        : { ...preset, ...(cur && typeof cur === 'object' ? { active: cur.active || 'default' } : {}) };
      changed = true;
    }
  }

  // Keep mode tiers aware of opus
  if (!cfg.modeTiers) cfg.modeTiers = {};
  for (const tier of ['performance', 'balanced', 'economy', 'custom']) {
    if (!cfg.modeTiers[tier]) cfg.modeTiers[tier] = {};
    for (const agent of ['claude', 'opus', 'codex']) {
      if (!cfg.modeTiers[tier][agent]) {
        cfg.modeTiers[tier][agent] = 'default';
        changed = true;
      }
    }
  }

  if (changed) saveHydraConfig(cfg);

  const lines = [
    'Agent model defaults (Council: Claude propose → Opus critique → Codex implement):',
    `  claude  → ${cfg.models.claude.default}  (CLI: claude) ${clis.claude ? '[found]' : '[MISSING — install Claude Code]'}`,
    `  opus    → ${cfg.models.opus.default}  (same CLI: claude — Opus is not a separate install) ${clis.claude ? '[ok]' : '[needs claude]'}`,
    `  codex   → ${cfg.models.codex.default}  (CLI: codex) ${clis.codex ? '[found]' : '[MISSING — install Codex CLI]'}`,
    clis.gemini
      ? '  gemini  → optional (not required for Council when Opus does critique)'
      : '  gemini  → not installed (OK — Council uses Opus via Claude)',
    changed ? '  Config updated in hydra.config.json' : '  Config already had model slots',
  ];

  const ok = clis.claude && clis.codex;
  if (!ok) {
    lines.push('');
    lines.push('Required on PATH: working `claude` + `codex` CLIs. Auth method is irrelevant to Hydra.');
    lines.push('Hydra only orchestrates — it does not install or log into those CLIs.');
  }

  const message = lines.join('\n');
  console.log(message);
  return { ok, message, clis, changed };
}

// ── MCP Server Entry Builders ───────────────────────────────────────────────

/**
 * Build the MCP server entry object for a given agent's config format.
 *
 * @param {'claude'|'gemini'|'codex'} agent
 * @returns {object|string[]} Entry object for claude/gemini, or args array for codex
 */
export function buildMcpServerEntry(agent) {
  const mcpPath = resolveMcpServerPath();

  switch (agent) {
    case 'claude':
      return {
        type: 'stdio',
        command: resolveNodePath(),
        args: [mcpPath],
        env: {},
      };

    case 'gemini':
      return {
        command: resolveNodePath(),
        args: [mcpPath],
        timeout: 600000,
        description: 'Hydra multi-agent orchestration',
      };

    case 'codex':
      // Codex uses `codex mcp add hydra -- node /path/to/mcp-server.mjs`
      // Return the args portion after `--`
      return [resolveNodePath(), mcpPath];

    default:
      throw new Error(`Unknown agent: ${agent}`);
  }
}

// ── JSON File Helpers ───────────────────────────────────────────────────────

/**
 * Read a JSON file, returning {} on any error (missing, invalid, empty).
 * @param {string} filePath
 * @returns {object}
 */
export function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Write a JSON object to a file with 2-space indentation.
 * Creates parent directories if needed.
 * @param {string} filePath
 * @param {object} data
 */
function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ── Claude Code Config ──────────────────────────────────────────────────────

/**
 * Default path to Claude Code's config file.
 * @returns {string}
 */
function defaultClaudeConfigPath() {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Merge Hydra MCP entry into Claude Code's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @param {boolean} [opts.force] Overwrite existing entry
 * @returns {{ status: 'added'|'exists'|'updated' }}
 */
export function mergeClaudeConfig(opts = {}) {
  const configPath = opts.configPath || defaultClaudeConfigPath();
  const force = Boolean(opts.force);

  const config = readJsonFile(configPath);
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  if (config.mcpServers.hydra && !force) {
    return { status: 'exists' };
  }

  const status = config.mcpServers.hydra ? 'updated' : 'added';
  config.mcpServers.hydra = buildMcpServerEntry('claude');
  writeJsonFile(configPath, config);

  return { status };
}

/**
 * Remove Hydra MCP entry from Claude Code's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @returns {{ status: 'removed'|'not_found' }}
 */
export function unmergeClaudeConfig(opts = {}) {
  const configPath = opts.configPath || defaultClaudeConfigPath();

  if (!fs.existsSync(configPath)) {
    return { status: 'not_found' };
  }

  const config = readJsonFile(configPath);
  if (!config.mcpServers || !config.mcpServers.hydra) {
    return { status: 'not_found' };
  }

  delete config.mcpServers.hydra;
  writeJsonFile(configPath, config);

  return { status: 'removed' };
}

// ── Gemini CLI Config ───────────────────────────────────────────────────────

/**
 * Default path to Gemini CLI's settings file.
 * @returns {string}
 */
function defaultGeminiConfigPath() {
  return path.join(os.homedir(), '.gemini', 'settings.json');
}

/**
 * Merge Hydra MCP entry into Gemini CLI's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @param {boolean} [opts.force] Overwrite existing entry
 * @returns {{ status: 'added'|'exists'|'updated' }}
 */
export function mergeGeminiConfig(opts = {}) {
  const configPath = opts.configPath || defaultGeminiConfigPath();
  const force = Boolean(opts.force);

  const config = readJsonFile(configPath);
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  if (config.mcpServers.hydra && !force) {
    return { status: 'exists' };
  }

  const status = config.mcpServers.hydra ? 'updated' : 'added';
  config.mcpServers.hydra = buildMcpServerEntry('gemini');
  writeJsonFile(configPath, config);

  return { status };
}

/**
 * Remove Hydra MCP entry from Gemini CLI's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @returns {{ status: 'removed'|'not_found' }}
 */
export function unmergeGeminiConfig(opts = {}) {
  const configPath = opts.configPath || defaultGeminiConfigPath();

  if (!fs.existsSync(configPath)) {
    return { status: 'not_found' };
  }

  const config = readJsonFile(configPath);
  if (!config.mcpServers || !config.mcpServers.hydra) {
    return { status: 'not_found' };
  }

  delete config.mcpServers.hydra;
  writeJsonFile(configPath, config);

  return { status: 'removed' };
}

// ── Codex CLI Config ────────────────────────────────────────────────────────

/**
 * Register Hydra MCP server with Codex CLI via `codex mcp add`.
 *
 * @returns {{ status: 'added'|'error', error?: string }}
 */
export function registerCodexMcp() {
  const [nodePath, mcpPath] = buildMcpServerEntry('codex');
  try {
    const result = spawnSync('codex', ['mcp', 'add', 'hydra', '--', nodePath, mcpPath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return { status: 'added' };
    }
    return { status: 'error', error: (result.stderr || '').trim() || `exit code ${result.status}` };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/**
 * Unregister Hydra MCP server from Codex CLI via `codex mcp remove`.
 *
 * @returns {{ status: 'removed'|'not_found'|'error', error?: string }}
 */
export function unregisterCodexMcp() {
  try {
    const result = spawnSync('codex', ['mcp', 'remove', 'hydra'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return { status: 'removed' };
    }
    const stderr = (result.stderr || '').trim();
    if (stderr.includes('not found') || stderr.includes('does not exist')) {
      return { status: 'not_found' };
    }
    return { status: 'error', error: stderr || `exit code ${result.status}` };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

// ── HYDRA.md Template ───────────────────────────────────────────────────────

/**
 * Generate a starter HYDRA.md template for project initialization.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectName] Project name for the header
 * @returns {string}
 */
export function generateHydraMdTemplate(opts = {}) {
  const name = opts.projectName || 'My Project';

  return `# HYDRA.md

> Multi-agent instructions for **${name}**. This file is parsed by \`hydra-sync-md\`
> to generate per-agent instruction files (CLAUDE.md, OPUS.md, AGENTS.md).

## Project Overview

${name} — describe your project here.

## Code Conventions

- Add shared conventions that all agents should follow.

## @claude

Claude-specific instructions go here.
- Claude is the architect role — best for design, planning, and code review.

## @opus

Opus-specific instructions go here.
- Opus is the critique role — same \`claude\` CLI with an Opus model id.

## @codex

Codex-specific instructions go here.
- Codex is the implementer role — best for code generation and refactoring.

## Testing

Shared testing instructions for all agents.
`;
}

// ── Main CLI Entry ──────────────────────────────────────────────────────────

const HELP_TEXT = `
hydra-setup — Detect CLIs, write default models, register MCP, initialize projects.

Usage:
  node lib/hydra-setup.mjs setup [--force] [--uninstall]
  node lib/hydra-setup.mjs ensure-models [--force]
  node lib/hydra-setup.mjs init  [path] [--project-name=Name] [--force]
  node lib/hydra-setup.mjs --help

Commands:
  setup          Detect CLIs, ensure default models, register MCP with installed CLIs
  ensure-models  Write Claude / Opus / Codex model defaults into hydra.config.json
  init           Generate HYDRA.md template and sync per-agent instruction files

Options:
  --force       Overwrite existing MCP registrations, models, or HYDRA.md template
  --uninstall   Remove Hydra MCP registrations from all CLIs
  --project-name=Name   Project name for HYDRA.md template (init only)
  --help        Show this help message
`.trim();

/**
 * Parse CLI arguments into a simple object.
 * @param {string[]} argv
 * @returns {{ subcommand: string, flags: object }}
 */
function parseSetupArgs(argv) {
  const args = argv.slice(2); // skip node + script path
  const flags = {};
  const positionals = [];
  let subcommand = '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        if (key === 'project-name' && i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[key] = args[i + 1];
          i += 1;
          continue;
        }
        flags[arg.slice(2)] = true;
      }
    } else if (!subcommand) {
      subcommand = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { subcommand, flags, positionals };
}

// ── Custom Agent MCP Registration ────────────────────────────────────────────

/**
 * Known config paths for popular AI CLIs (relative to os.homedir(), or null if unsupported).
 */
export const KNOWN_CLI_MCP_PATHS = {
  // GitHub Copilot — config location varies by version; manual preferred
  'gh': null,
  // Aider — YAML config, not JSON; manual preferred
  'aider': null,
  // Continue — JSON config
  'continue': path.join('.continue', 'config.json'),
};

/**
 * Register the Hydra MCP server with a custom agent's config file.
 *
 * @param {object} opts
 * @param {string|null} opts.configPath - Absolute path to the agent's config file
 * @param {'json'|string} [opts.format] - Config format ('json' is the only auto-handled format)
 * @param {boolean} [opts.force] - Overwrite existing entry
 * @returns {{ status: 'added'|'exists'|'updated'|'manual'|'error', instructions?: string }}
 */
export function registerCustomAgentMcp(opts = {}) {
  const { configPath, format, force = false } = opts;
  const mcpPath = resolveMcpServerPath();
  const nodePath = resolveNodePath();

  const manualInstructions = `Add this to your agent's MCP configuration:\n\n  Name: hydra\n  Command: ${nodePath}\n  Args: ${mcpPath}\n\nOr if your agent uses a JSON config with an "mcpServers" field:\n  {\n    "mcpServers": {\n      "hydra": {\n        "type": "stdio",\n        "command": "${nodePath}",\n        "args": ["${mcpPath}"]\n      }\n    }\n  }`;

  if (!configPath || format !== 'json') {
    return { status: 'manual', instructions: manualInstructions };
  }

  try {
    const config = readJsonFile(configPath);
    if (!config.mcpServers) config.mcpServers = {};

    if (config.mcpServers.hydra && !force) {
      return { status: 'exists' };
    }

    const status = config.mcpServers.hydra ? 'updated' : 'added';
    config.mcpServers.hydra = {
      type: 'stdio',
      command: nodePath,
      args: [mcpPath],
    };

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    return { status };
  } catch {
    return { status: 'manual', instructions: manualInstructions };
  }
}

/**
 * Main CLI entry point.
 *
 * @param {string[]} [argv] Override process.argv for testing
 * @returns {{ ok: boolean, message: string }}
 */
export async function main(argv) {
  const effectiveArgv = argv || process.argv;
  const { subcommand, flags, positionals } = parseSetupArgs(effectiveArgv);

  // --help
  if (flags.help || subcommand === 'help') {
    console.log(HELP_TEXT);
    return { ok: true, message: 'help' };
  }

  // setup
  if (subcommand === 'setup') {
    return runSetup(flags);
  }

  // ensure-models (also used from npm postinstall)
  if (subcommand === 'ensure-models') {
    return ensureDefaultAgentModels(flags);
  }

  // init
  if (subcommand === 'init') {
    return runInit(flags, positionals);
  }

  // No subcommand or unknown
  console.log(HELP_TEXT);
  return { ok: false, message: subcommand ? `Unknown command: ${subcommand}` : 'No command specified' };
}

/**
 * Run the setup flow: default models, detect CLIs, register/unregister MCP.
 * @param {object} flags
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function runSetup(flags) {
  const uninstall = Boolean(flags.uninstall);
  const force = Boolean(flags.force);

  if (!uninstall) {
    await ensureDefaultAgentModels({ force });
  }

  const clis = detectInstalledCLIs();
  const results = [];

  if (uninstall) {
    // Unregister from all
    if (clis.claude) {
      const r = unmergeClaudeConfig();
      results.push(`Claude: ${r.status}`);
    } else {
      results.push('Claude: not installed');
    }

    if (clis.gemini) {
      const r = unmergeGeminiConfig();
      results.push(`Gemini: ${r.status}`);
    } else {
      results.push('Gemini: not installed');
    }

    if (clis.codex) {
      const r = unregisterCodexMcp();
      results.push(`Codex: ${r.status}`);
    } else {
      results.push('Codex: not installed');
    }

    const msg = `Unregistered Hydra MCP:\n  ${results.join('\n  ')}`;
    console.log(msg);
    return { ok: true, message: msg };
  }

  // Register with all installed CLIs
  if (clis.claude) {
    const r = mergeClaudeConfig({ force });
    results.push(`Claude: ${r.status}`);
  } else {
    results.push('Claude: not installed');
  }

  if (clis.gemini) {
    const r = mergeGeminiConfig({ force });
    results.push(`Gemini: ${r.status}`);
  } else {
    results.push('Gemini: not installed');
  }

  if (clis.codex) {
    const r = registerCodexMcp();
    results.push(`Codex: ${r.status}`);
  } else {
    results.push('Codex: not installed');
  }

  const ok = clis.claude && clis.codex;
  const msg = `Registered Hydra MCP:\n  ${results.join('\n  ')}${ok ? '' : '\n\nWarning: need working `claude` + `codex` on PATH for Council.'}`;
  console.log(msg);
  return { ok, message: msg };
}

/**
 * Run the init flow: generate HYDRA.md and sync per-agent files.
 * @param {object} flags
 * @returns {{ ok: boolean, message: string }}
 */
async function runInit(flags, positionals = []) {
  if (positionals.length > 1) {
    const message = `Expected at most one target path for init, received ${positionals.length}.`;
    console.error(message);
    return { ok: false, message };
  }

  const projectRoot = path.resolve(positionals[0] || process.cwd());
  const hydraMdPath = path.join(projectRoot, 'HYDRA.md');
  const projectName = flags['project-name'] || path.basename(projectRoot);
  const force = Boolean(flags.force);

  if (fs.existsSync(projectRoot)) {
    const stats = fs.statSync(projectRoot);
    if (!stats.isDirectory()) {
      const message = `Target path is not a directory: ${projectRoot}`;
      console.error(message);
      return { ok: false, message };
    }
  } else {
    fs.mkdirSync(projectRoot, { recursive: true });
  }

  if (fs.existsSync(hydraMdPath) && fs.statSync(hydraMdPath).isDirectory()) {
    const message = `Target HYDRA.md path is a directory: ${hydraMdPath}`;
    console.error(message);
    return { ok: false, message };
  }

  const hadHydraMd = fs.existsSync(hydraMdPath);

  // Generate HYDRA.md if it doesn't exist
  if (hadHydraMd && !force) {
    console.log('HYDRA.md already exists — skipping template generation.');
  } else {
    const template = generateHydraMdTemplate({ projectName });
    fs.writeFileSync(hydraMdPath, template, 'utf8');
    console.log(`${hadHydraMd ? 'Updated' : 'Created'} HYDRA.md for "${projectName}".`);
  }

  // Sync per-agent files
  try {
    const { syncHydraMd } = await import('./hydra-sync-md.mjs');
    const result = syncHydraMd(projectRoot);
    if (result.synced.length > 0) {
      console.log(`Synced: ${result.synced.join(', ')}`);
    } else if (result.skipped) {
      console.log('Sync skipped (no HYDRA.md found).');
    } else {
      console.log('All agent files are up to date.');
    }
  } catch (err) {
    console.error(`Failed to sync agent files: ${err.message}`);
    return { ok: false, message: `Init completed but sync failed: ${err.message}` };
  }

  return { ok: true, message: `Initialized HYDRA.md in ${projectRoot}` };
}

// ── Direct CLI entry ────────────────────────────────────────────────────────

const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('hydra-setup.mjs');

if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
