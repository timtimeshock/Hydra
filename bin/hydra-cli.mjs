#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  HYDRA_INTERNAL_FLAG,
  HYDRA_STANDALONE,
  runHydraInternalModule,
  spawnHydraNodeSync,
} from '../lib/hydra-exec.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HYDRA_ROOT = path.resolve(__dirname, '..');
const HYDRA_OPERATOR = path.join(HYDRA_ROOT, 'lib', 'hydra-operator.mjs');
const HYDRA_POWERSHELL = path.join(HYDRA_ROOT, 'bin', 'hydra.ps1');

const POWER_SHELL_ARG_MAP = {
  url: 'Url',
  skipdaemon: 'SkipDaemon',
  skipheads: 'SkipHeads',
  dryrun: 'DryRun',
  waittimeoutsec: 'WaitTimeoutSec',
  waittimeout: 'WaitTimeoutSec',
  pollintervalms: 'PollIntervalMs',
  pollms: 'PollIntervalMs',
};

const OPERATOR_KEY_ALIASES = {
  councilround: 'councilRounds',
  councilrounds: 'councilRounds',
  councilpreview: 'councilPreview',
  autominirounds: 'autoMiniRounds',
  autocouncilrounds: 'autoCouncilRounds',
  autopreview: 'autoPreview',
};

const POWER_SHELL_CANDIDATES = [
  'pwsh',
  'powershell',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];

function printHelp() {
  process.stdout.write([
    'Hydra CLI',
    '',
    'Usage:',
    '  hydra [options] [prompt text]',
    '',
    'Options:',
    '  -f, --full             Launch daemon + agent head terminals + operator',
    '  -p, --prompt <text>    One-shot prompt',
    '  -h, --help             Show this help',
    '',
    'Examples:',
    '  hydra',
    '  hydra --prompt "Fix the auth regression"',
    '  hydra --mode smart --prompt "refactor model loading"',
    '  hydra --full --dry-run',
    '',
    'Subcommands:',
    '  hydra setup              Register Hydra MCP server in AI CLIs',
    '  hydra setup --uninstall  Remove MCP registration',
    '  hydra setup --force      Overwrite existing registration',
    '  hydra init [path]        Generate HYDRA.md for a project',
    '  hydra init --force       Overwrite existing HYDRA.md',
    '  hydra gui                Open the Windows GUI',
    '',
  ].join('\n'));
}

function isOptionToken(token) {
  return /^-{1,2}[A-Za-z]/.test(token);
}

function looksLikeOption(token) {
  return Boolean(token) && isOptionToken(token);
}

function parseOptionToken(token) {
  if (!isOptionToken(token)) {
    return null;
  }

  const stripped = token.replace(/^-+/, '');
  if (!stripped) {
    return null;
  }

  const eq = stripped.indexOf('=');
  if (eq >= 0) {
    return {
      key: stripped.slice(0, eq),
      value: stripped.slice(eq + 1),
      hasInlineValue: true,
    };
  }

  const colon = stripped.indexOf(':');
  if (colon >= 0) {
    return {
      key: stripped.slice(0, colon),
      value: stripped.slice(colon + 1),
      hasInlineValue: true,
    };
  }

  return {
    key: stripped,
    value: null,
    hasInlineValue: false,
  };
}

function normalizeKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) {
    return '';
  }

  const camel = key.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
  return camel[0].toLowerCase() + camel.slice(1);
}

function normalizeOperatorKey(rawKey) {
  const normalized = normalizeKey(rawKey);
  if (!normalized) {
    return normalized;
  }

  const noPunctuation = normalized.replace(/[^a-zA-Z0-9]/g, '');
  const alias = OPERATOR_KEY_ALIASES[noPunctuation.toLowerCase()];
  if (alias) {
    return alias;
  }
  return normalized;
}

function parseCommonArgs(argv) {
  let full = false;
  let prompt = '';
  let showHelp = false;
  const passthrough = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const lower = token.toLowerCase();

    if (token === '--help' || token === '-h' || token === '-?') {
      showHelp = true;
      continue;
    }

    if (lower === '--full' || lower === '-f' || lower === '-full') {
      full = true;
      continue;
    }

    const promptInlineMatch = token.match(/^(?:--prompt|-p|-prompt)[:=](.*)$/i);
    if (promptInlineMatch) {
      prompt = promptInlineMatch[1] || '';
      continue;
    }

    if (lower === '--prompt' || lower === '-p' || lower === '-prompt') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --prompt.');
      }
      prompt = argv[i + 1];
      i += 1;
      continue;
    }

    passthrough.push(token);
  }

  return { full, prompt, showHelp, passthrough };
}

function toOperatorArgs(rawTokens) {
  const out = [];

  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = rawTokens[i];

    if (!isOptionToken(token)) {
      out.push(token);
      continue;
    }

    const parsed = parseOptionToken(token);
    if (!parsed || !parsed.key) {
      out.push(token);
      continue;
    }

    const key = String(parsed.key || '').trim();
    if (!key) {
      out.push(token);
      continue;
    }

    let value = parsed.value;
    if (value === null && i + 1 < rawTokens.length && !looksLikeOption(rawTokens[i + 1])) {
      value = rawTokens[i + 1];
      i += 1;
    }

    const normalizedKey = normalizeOperatorKey(key);
    if (!normalizedKey) {
      continue;
    }

    const lowerKey = normalizedKey.toLowerCase();
    if (value === null && lowerKey.startsWith('no') && key.startsWith('no-') && normalizedKey.length > 2) {
      const positiveKey = normalizedKey[2].toLowerCase() + normalizedKey.slice(3);
      out.push(`${positiveKey}=false`);
      continue;
    }

    out.push(`${normalizedKey}=${value === null ? 'true' : value}`);
  }

  return out;
}

function toPowerShellArgs(rawTokens) {
  const out = [];

  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = rawTokens[i];

    if (!isOptionToken(token)) {
      out.push(token);
      continue;
    }

    const parsed = parseOptionToken(token);
    if (!parsed || !parsed.key) {
      out.push(token);
      continue;
    }

    const key = String(parsed.key || '').trim();
    if (!key) {
      out.push(token);
      continue;
    }

    const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const psParam = POWER_SHELL_ARG_MAP[normalized];
    if (!psParam) {
      out.push(token);
      continue;
    }

    let value = parsed.value;
    if (value === null && i + 1 < rawTokens.length && !looksLikeOption(rawTokens[i + 1])) {
      value = rawTokens[i + 1];
      i += 1;
    }

    out.push(`-${psParam}`);
    if (value !== null) {
      out.push(value);
    }
  }

  return out;
}

function runOperator(prompt, rawTokens) {
  const operatorArgs = toOperatorArgs(rawTokens);
  const hasMode = operatorArgs.some((arg) => /^mode=/i.test(arg));
  const hasPrompt = operatorArgs.some((arg) => /^prompt=/i.test(arg));

  if (!hasMode) {
    operatorArgs.push('mode=auto');
  }
  if (prompt && !hasPrompt) {
    operatorArgs.push(`prompt=${prompt}`);
  }

  const result = spawnHydraNodeSync(HYDRA_OPERATOR, operatorArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  if (result.error) {
    throw result.error;
  }

  process.exit(1);
}

function runFull(prompt, rawTokens) {
  if (process.platform !== 'win32') {
    throw new Error('`hydra --full` is only available on Windows.');
  }
  if (HYDRA_STANDALONE) {
    throw new Error('`hydra --full` is not available in standalone .exe builds. Use `hydra` (operator mode) instead.');
  }

  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    HYDRA_POWERSHELL,
    '-Full',
    ...toPowerShellArgs(rawTokens),
  ];

  if (prompt) {
    psArgs.push('-Prompt', prompt);
  }

  let lastError = null;
  for (const shell of POWER_SHELL_CANDIDATES) {
    const result = spawnSync(shell, psArgs, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
      windowsHide: false,
    });

    if (!result.error) {
      if (typeof result.status === 'number') {
        process.exit(result.status);
      }
      process.exit(1);
    }

    if (result.error.code === 'ENOENT') {
      continue;
    }

    lastError = result.error;
  }

  if (lastError) {
    throw new Error(`Unable to launch PowerShell (${lastError.code || lastError.message}).`);
  }

  throw new Error('Could not find `pwsh` or `powershell` in PATH.');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === HYDRA_INTERNAL_FLAG) {
    const moduleId = argv[1];
    const moduleArgs = argv.slice(2);
    await runHydraInternalModule(moduleId, moduleArgs, HYDRA_ROOT);
    return;
  }

  // Subcommands that bypass the operator
  const subcommand = argv[0]?.toLowerCase();
  if (subcommand === 'gui') {
    const { startGui } = await import('../lib/hydra-gui.mjs');
    await startGui({ open: true });
    return;
  }

  if (subcommand === 'setup' || subcommand === 'init') {
    const { main: setupMain } = await import('../lib/hydra-setup.mjs');
    // main() expects process.argv-shaped array (parseSetupArgs does .slice(2))
    await setupMain(['_', '_', subcommand, ...argv.slice(1)]);
    return;
  }

  const { full, prompt, showHelp, passthrough } = parseCommonArgs(argv);

  if (showHelp) {
    printHelp();
    process.exit(0);
  }

  if (full) {
    runFull(prompt, passthrough);
    return;
  }

  runOperator(prompt, passthrough);
}

main().catch((error) => {
  console.error(`Hydra CLI failed: ${error.message}`);
  process.exit(1);
});
