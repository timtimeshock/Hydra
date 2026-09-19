#!/usr/bin/env node
/**
 * Multi-agent synchronization CLI for Gemini + Codex + Claude Code.
 *
 * Canonical state:
 * - <project>/docs/coordination/AI_SYNC_STATE.json
 * - <project>/docs/coordination/AI_SYNC_LOG.md
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveProject } from './hydra-config.mjs';
import { getAgentInstructionFile } from './hydra-sync-md.mjs';

const config = resolveProject();
const ROOT = config.projectRoot;
const COORD_DIR = config.coordDir;
const STATE_PATH = config.statePath;
const LOG_PATH = config.logPath;

const STATUS_VALUES = new Set(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

function toSessionId(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `SYNC_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function createAgentRecord() {
  return {
    installed: null,
    path: '',
    version: '',
    lastCheckedAt: null,
  };
}

function createDefaultState() {
  return {
    schemaVersion: 1,
    project: config.projectName,
    updatedAt: nowIso(),
    activeSession: null,
    agents: {
      codex: createAgentRecord(),
      claude: createAgentRecord(),
      gemini: createAgentRecord(),
    },
    tasks: [],
    decisions: [],
    blockers: [],
    handoffs: [],
  };
}

function normalizeState(raw) {
  const defaults = createDefaultState();
  const safe = raw && typeof raw === 'object' ? raw : {};

  return {
    ...defaults,
    ...safe,
    agents: {
      ...defaults.agents,
      ...(safe.agents || {}),
      codex: { ...defaults.agents.codex, ...(safe.agents?.codex || {}) },
      claude: { ...defaults.agents.claude, ...(safe.agents?.claude || {}) },
      gemini: { ...defaults.agents.gemini, ...(safe.agents?.gemini || {}) },
    },
    tasks: Array.isArray(safe.tasks) ? safe.tasks : [],
    decisions: Array.isArray(safe.decisions) ? safe.decisions : [],
    blockers: Array.isArray(safe.blockers) ? safe.blockers : [],
    handoffs: Array.isArray(safe.handoffs) ? safe.handoffs : [],
  };
}

function ensureCoordFiles() {
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_PATH)) {
    const state = createDefaultState();
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  if (!fs.existsSync(LOG_PATH)) {
    const lines = [
      '# AI Sync Log',
      '',
      `Created: ${nowIso()}`,
      '',
      'Use `npm run hydra:summary` to see current state.',
      '',
    ];
    fs.writeFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
  }
}

function readState() {
  ensureCoordFiles();
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.error(`Failed to read ${path.relative(ROOT, STATE_PATH)}: ${error.message}`);
    process.exit(1);
  }
}

function writeState(state) {
  const next = normalizeState(state);
  next.updatedAt = nowIso();
  if (next.activeSession?.status === 'active') {
    next.activeSession.updatedAt = next.updatedAt;
  }
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function appendLog(entry) {
  ensureCoordFiles();
  fs.appendFileSync(LOG_PATH, `- ${nowIso()} | ${entry}\n`, 'utf8');
}

function parseList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCli(argv) {
  const [command = 'help', ...rest] = argv.slice(2);
  const options = {};
  const positionals = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];

    if (token.includes('=') && !token.startsWith('--')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key) {
        options[key] = rawValue.join('=').trim();
      }
      continue;
    }

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const maybeInline = token.slice(2);
    if (maybeInline.includes('=')) {
      const [rawKey, ...rawValue] = maybeInline.split('=');
      options[rawKey] = rawValue.join('=');
      continue;
    }

    const key = maybeInline;
    const maybeValue = rest[i + 1];
    if (!maybeValue || maybeValue.startsWith('--') || maybeValue.includes('=')) {
      options[key] = true;
      continue;
    }

    options[key] = maybeValue;
    i += 1;
  }

  return { command, options, positionals };
}

function getOptionValue(options, positionals, key, positionIndex, defaultValue = '') {
  if (options[key] !== undefined && options[key] !== true) {
    return String(options[key]);
  }
  if (positionals[positionIndex] !== undefined) {
    return String(positionals[positionIndex]);
  }
  return defaultValue;
}

function getRequiredOption(options, positionals, key, positionIndex, helpHint = '') {
  const value = getOptionValue(options, positionals, key, positionIndex, '');
  if (value === undefined || value === true || value === '') {
    const extra = helpHint ? `\n${helpHint}` : '';
    console.error(`Missing required option --${key}.${extra}`);
    process.exit(1);
  }
  return String(value);
}

function nextId(prefix, items) {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);

  for (const item of items) {
    const match = String(item?.id || '').match(pattern);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }

  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function runCommand(command) {
  try {
    return execSync(command, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getCurrentBranch() {
  return runCommand('git branch --show-current') || 'unknown';
}

function detectCommand(name) {
  const locator = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
  const located = runCommand(locator);
  if (!located) {
    return {
      installed: false,
      path: '',
    };
  }

  const firstPath = located.split(/\r?\n/)[0]?.trim() || '';
  return {
    installed: true,
    path: firstPath,
  };
}

function detectVersion(name, customCommand) {
  const command = customCommand || `${name} --version`;
  return runCommand(command).split(/\r?\n/)[0] || '';
}

function printHelp() {
  console.log(`
Hydra Multi-Agent Sync CLI

Usage:
  node sync.mjs <command> [options]

Commands:
  help                Show this help
  init                Create coordination files if missing
  doctor              Detect local Gemini/Codex/Claude tooling
  start               Start a new shared session
  task:add            Add a task
  task:update         Update a task
  decision:add        Record an important decision
  blocker:add         Record a blocker
  handoff             Record handoff notes between agents
  summary             Print current shared state summary
  prompt              Print copy/paste prompt for an agent

Project: ${config.projectName} (${config.projectRoot})
`);
}

function ensureStatus(status) {
  if (!STATUS_VALUES.has(status)) {
    console.error(`Invalid status "${status}". Use one of: ${Array.from(STATUS_VALUES).join(', ')}`);
    process.exit(1);
  }
}

function commandInit() {
  ensureCoordFiles();
  const state = readState();
  writeState(state);
  appendLog('Initialized coordination files');

  console.log('Initialized multi-agent sync files:');
  console.log(`- ${path.relative(ROOT, STATE_PATH)}`);
  console.log(`- ${path.relative(ROOT, LOG_PATH)}`);
}

function commandDoctor() {
  const checks = [
    { key: 'codex', command: 'codex', versionCommand: 'codex --version' },
    { key: 'claude', command: 'claude', versionCommand: 'claude --version' },
    { key: 'gemini', command: 'gemini', versionCommand: 'gemini --version' },
    { key: 'gcloud', command: 'gcloud', versionCommand: 'gcloud --version' },
  ];

  const state = readState();
  const checkedAt = nowIso();

  console.log('Tooling check:');
  for (const item of checks) {
    const detected = detectCommand(item.command);
    const version = detected.installed ? detectVersion(item.command, item.versionCommand) : '';

    if (item.key === 'gcloud') {
      console.log(
        `- ${item.key.padEnd(7)} installed=${String(detected.installed).padEnd(5)} path=${detected.path || 'n/a'}${
          version ? ` version=${version}` : ''
        }`
      );
      continue;
    }

    state.agents[item.key] = {
      installed: detected.installed,
      path: detected.path,
      version,
      lastCheckedAt: checkedAt,
    };

    console.log(
      `- ${item.key.padEnd(7)} installed=${String(detected.installed).padEnd(5)} path=${detected.path || 'n/a'}${
        version ? ` version=${version}` : ''
      }`
    );
  }

  writeState(state);
  appendLog('Ran tooling doctor');

  if (!state.agents.gemini.installed) {
    console.log('\nGemini CLI was not detected on PATH.');
    console.log('You can still use Gemini Pro via web by pasting output from prompt command.');
  }
}

function commandStart(options, positionals) {
  const focus = getRequiredOption(
    options,
    positionals,
    'focus',
    0,
    'Example: --focus "Stabilize auth callback flow" or focus="Stabilize auth callback flow"'
  );
  const owner = getOptionValue(options, positionals, 'owner', 1, 'human');
  const branch = getOptionValue(options, positionals, 'branch', 2, getCurrentBranch());
  const participants = parseList(getOptionValue(options, positionals, 'participants', 3, 'human,codex,claude'));

  const state = readState();
  const now = nowIso();
  const session = {
    id: toSessionId(),
    focus,
    owner,
    branch,
    participants,
    status: 'active',
    startedAt: now,
    updatedAt: now,
  };

  state.activeSession = session;
  writeState(state);
  appendLog(`Started session ${session.id} | focus="${focus}" | owner=${owner} | branch=${branch}`);

  console.log(`Started session ${session.id}`);
  console.log(`Focus: ${focus}`);
  console.log(`Branch: ${branch}`);
  console.log(`Participants: ${participants.join(', ') || 'none'}`);
}

function commandTaskAdd(options, positionals) {
  const title = getRequiredOption(options, positionals, 'title', 0);
  const owner = getOptionValue(options, positionals, 'owner', 1, 'unassigned');
  const status = getOptionValue(options, positionals, 'status', 2, 'todo');
  const files = parseList(getOptionValue(options, positionals, 'files', 3, ''));
  const notes = getOptionValue(options, positionals, 'notes', 4, '');
  ensureStatus(status);

  const state = readState();
  const task = {
    id: nextId('T', state.tasks),
    title,
    owner,
    status,
    files,
    notes,
    updatedAt: nowIso(),
  };

  state.tasks.push(task);
  writeState(state);
  appendLog(`Added task ${task.id} | status=${status} | owner=${owner} | title="${title}"`);

  console.log(`Added ${task.id}: ${task.title}`);
}

function commandTaskUpdate(options, positionals) {
  const id = getRequiredOption(options, positionals, 'id', 0);
  const state = readState();
  const task = state.tasks.find((item) => item.id === id);

  if (!task) {
    console.error(`Task ${id} not found.`);
    process.exit(1);
  }

  const nextTitle = getOptionValue(options, positionals, 'title', 5, '');
  if (nextTitle) {
    task.title = nextTitle;
  }

  const positionalStatus = positionals[1];
  const positionalOwner = positionals[2];
  const positionalNotes = positionals[3];
  const positionalFiles = positionals[4];

  const nextStatusFromOption = options.status && options.status !== true ? String(options.status) : '';
  const nextStatusFromPositional = positionalStatus && STATUS_VALUES.has(String(positionalStatus)) ? String(positionalStatus) : '';
  const nextStatus = nextStatusFromOption || nextStatusFromPositional;
  if (nextStatus) {
    ensureStatus(nextStatus);
    task.status = nextStatus;
  }

  const ownerFromOption = options.owner && options.owner !== true ? String(options.owner) : '';
  let ownerFromPositional = '';
  if (positionalOwner && !STATUS_VALUES.has(String(positionalOwner))) {
    ownerFromPositional = String(positionalOwner);
  } else if (positionalStatus && !STATUS_VALUES.has(String(positionalStatus))) {
    ownerFromPositional = String(positionalStatus);
  }

  const nextOwner = ownerFromOption || ownerFromPositional;
  if (nextOwner) {
    task.owner = nextOwner;
  }

  const nextFilesRaw =
    options.files && options.files !== true ? String(options.files) : positionalFiles && positionalFiles !== true ? String(positionalFiles) : '';
  if (nextFilesRaw) {
    task.files = parseList(nextFilesRaw);
  }

  const nextNoteRaw =
    options.notes && options.notes !== true ? String(options.notes) : positionalNotes && positionalNotes !== true ? String(positionalNotes) : '';
  if (nextNoteRaw) {
    const nextNote = nextNoteRaw;
    task.notes = task.notes ? `${task.notes}\n${nextNote}` : nextNote;
  }

  task.updatedAt = nowIso();
  writeState(state);
  appendLog(`Updated task ${task.id} | status=${task.status} | owner=${task.owner}`);

  console.log(`Updated ${task.id}`);
}

function commandDecisionAdd(options, positionals) {
  const title = getRequiredOption(options, positionals, 'title', 0);
  const owner = getOptionValue(options, positionals, 'owner', 1, 'human');
  const rationale = getOptionValue(options, positionals, 'rationale', 2, '');
  const impact = getOptionValue(options, positionals, 'impact', 3, '');

  const state = readState();
  const decision = {
    id: nextId('D', state.decisions),
    title,
    rationale,
    impact,
    owner,
    createdAt: nowIso(),
  };

  state.decisions.push(decision);
  writeState(state);
  appendLog(`Recorded decision ${decision.id} | owner=${owner} | title="${title}"`);

  console.log(`Recorded ${decision.id}`);
}

function commandBlockerAdd(options, positionals) {
  const title = getRequiredOption(options, positionals, 'title', 0);
  const owner = getOptionValue(options, positionals, 'owner', 1, 'human');
  const nextStep = getOptionValue(options, positionals, 'next-step', 2, '');

  const state = readState();
  const blocker = {
    id: nextId('B', state.blockers),
    title,
    owner,
    status: 'open',
    nextStep,
    createdAt: nowIso(),
  };

  state.blockers.push(blocker);
  writeState(state);
  appendLog(`Added blocker ${blocker.id} | owner=${owner} | title="${title}"`);

  console.log(`Recorded ${blocker.id}`);
}

function commandHandoff(options, positionals) {
  const from = getRequiredOption(options, positionals, 'from', 0);
  const to = getRequiredOption(options, positionals, 'to', 1);
  const summary = getRequiredOption(options, positionals, 'summary', 2);
  const nextStep = getOptionValue(options, positionals, 'next-step', 3, '');
  const relatedTasks = parseList(getOptionValue(options, positionals, 'tasks', 4, ''));

  const state = readState();
  const handoff = {
    id: nextId('H', state.handoffs),
    from,
    to,
    summary,
    nextStep,
    tasks: relatedTasks,
    createdAt: nowIso(),
  };

  state.handoffs.push(handoff);
  writeState(state);
  appendLog(`Added handoff ${handoff.id} | ${from} -> ${to} | tasks=${relatedTasks.join(',') || 'none'}`);

  console.log(`Recorded ${handoff.id}`);
}

function formatTask(task) {
  return `${task.id} [${task.status}] owner=${task.owner} :: ${task.title}`;
}

function commandSummary() {
  const state = readState();
  const openTasks = state.tasks.filter((task) => !['done', 'cancelled'].includes(task.status));
  const activeBlockers = state.blockers.filter((blocker) => blocker.status !== 'resolved');
  const recentDecisions = state.decisions.slice(-3);
  const recentHandoff = state.handoffs.at(-1);

  console.log(`Hydra Sync Summary (${config.projectName})`);
  console.log(`State: ${path.relative(ROOT, STATE_PATH)}`);
  console.log(`Log:   ${path.relative(ROOT, LOG_PATH)}`);
  console.log(`Updated: ${state.updatedAt}`);

  if (state.activeSession) {
    console.log('\nActive Session');
    console.log(`- id: ${state.activeSession.id}`);
    console.log(`- focus: ${state.activeSession.focus}`);
    console.log(`- owner: ${state.activeSession.owner}`);
    console.log(`- branch: ${state.activeSession.branch}`);
    console.log(`- participants: ${(state.activeSession.participants || []).join(', ')}`);
  } else {
    console.log('\nActive Session');
    console.log('- none');
  }

  console.log(`\nOpen Tasks (${openTasks.length})`);
  if (openTasks.length === 0) {
    console.log('- none');
  } else {
    for (const task of openTasks) {
      console.log(`- ${formatTask(task)}`);
    }
  }

  console.log(`\nOpen Blockers (${activeBlockers.length})`);
  if (activeBlockers.length === 0) {
    console.log('- none');
  } else {
    for (const blocker of activeBlockers) {
      console.log(`- ${blocker.id} owner=${blocker.owner} :: ${blocker.title}`);
      if (blocker.nextStep) {
        console.log(`  next: ${blocker.nextStep}`);
      }
    }
  }

  console.log(`\nRecent Decisions (${recentDecisions.length})`);
  if (recentDecisions.length === 0) {
    console.log('- none');
  } else {
    for (const decision of recentDecisions) {
      console.log(`- ${decision.id} owner=${decision.owner} :: ${decision.title}`);
    }
  }

  console.log('\nLatest Handoff');
  if (!recentHandoff) {
    console.log('- none');
  } else {
    console.log(`- ${recentHandoff.id} ${recentHandoff.from} -> ${recentHandoff.to}`);
    console.log(`  summary: ${recentHandoff.summary}`);
    if (recentHandoff.nextStep) {
      console.log(`  next: ${recentHandoff.nextStep}`);
    }
  }
}

function buildPrompt(agent, state) {
  const labelByAgent = {
    codex: 'Codex',
    claude: 'Claude Code',
    gemini: 'Gemini Pro',
    generic: 'AI Assistant',
  };
  const agentLabel = labelByAgent[agent] || labelByAgent.generic;

  const openTasks = state.tasks
    .filter((task) => !['done', 'cancelled'].includes(task.status))
    .slice(0, 8)
    .map((task) => `- ${formatTask(task)}`)
    .join('\n');

  const instructionFile = getAgentInstructionFile(agent, ROOT);

  return [
    `You are ${agentLabel} collaborating in the ${config.projectName} repository with Gemini Pro, Codex, and Claude Code.`,
    '',
    'Read these files first:',
    `1) ${instructionFile}`,
    '2) docs/QUICK_REFERENCE.md',
    '3) docs/coordination/AI_SYNC_STATE.json',
    '4) docs/coordination/AI_SYNC_LOG.md',
    '',
    'Rules for this run:',
    '- Do not start edits until you claim a task in AI_SYNC_STATE.json.',
    '- Update task status when moving to in_progress, blocked, or done.',
    '- Record important decisions and blockers in AI_SYNC_STATE.json.',
    '- Before handing off, add a handoff entry with what changed and next step.',
    '',
    `Current focus: ${state.activeSession?.focus || 'not set'}`,
    `Current branch: ${state.activeSession?.branch || getCurrentBranch()}`,
    '',
    'Open tasks:',
    openTasks || '- none',
  ].join('\n');
}

function commandPrompt(options, positionals) {
  const agent = String(getOptionValue(options, positionals, 'agent', 0, 'generic')).toLowerCase();
  const state = readState();
  console.log(buildPrompt(agent, state));
}

function main() {
  const { command, options, positionals } = parseCli(process.argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'init':
      commandInit();
      return;
    case 'doctor':
      commandDoctor();
      return;
    case 'start':
      commandStart(options, positionals);
      return;
    case 'task:add':
      commandTaskAdd(options, positionals);
      return;
    case 'task:update':
      commandTaskUpdate(options, positionals);
      return;
    case 'decision:add':
      commandDecisionAdd(options, positionals);
      return;
    case 'blocker:add':
      commandBlockerAdd(options, positionals);
      return;
    case 'handoff':
      commandHandoff(options, positionals);
      return;
    case 'summary':
      commandSummary();
      return;
    case 'prompt':
      commandPrompt(options, positionals);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main();
