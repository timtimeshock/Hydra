/**
 * Hydra Agents Wizard — Interactive wizard for registering custom CLI and API agents.
 *
 * Exports: runAgentsWizard(rl), buildCustomAgentEntry(), parseArgsTemplate(), validateAgentName()
 * Called by hydra-operator.mjs via: :agents add
 */

import os from 'os';
import path from 'path';
import { promptChoice } from './hydra-prompt-choice.mjs';
import { loadHydraConfig, saveHydraConfig, AFFINITY_PRESETS } from './hydra-config.mjs';
import { registerCustomAgentMcp, KNOWN_CLI_MCP_PATHS } from './hydra-setup.mjs';

const RESERVED_NAMES = ['claude', 'gemini', 'codex', 'local'];

/**
 * Validate a custom agent name.
 * @param {string} name
 * @returns {string|null} Error message, or null if valid
 */
export function validateAgentName(name) {
  if (!name || !name.trim()) return 'Name cannot be empty';
  if (RESERVED_NAMES.includes(name.toLowerCase())) return `"${name}" is a reserved agent name`;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return 'Name must be lowercase alphanumeric with hyphens (e.g. copilot, my-agent)';
  return null;
}

/**
 * Split a space-separated args template string into an array.
 * @param {string} template - e.g. "copilot suggest -p {prompt}"
 * @returns {string[]}
 */
export function parseArgsTemplate(template) {
  return template.trim().split(/\s+/).filter(Boolean);
}

/**
 * Build a customAgents[] entry from wizard field values.
 * @param {object} fields
 * @returns {object} Agent entry ready for config
 */
export function buildCustomAgentEntry(fields) {
  const { name, type, affinityPreset, councilRole, contextBudget, enabled } = fields;
  const taskAffinity = AFFINITY_PRESETS[affinityPreset] || AFFINITY_PRESETS['balanced'];

  const base = {
    name,
    type,
    displayName: fields.displayName || name,
    contextBudget: Number(contextBudget) || 32000,
    councilRole: councilRole || null,
    taskAffinity,
    enabled: enabled !== false,
  };

  if (type === 'cli') {
    const args = parseArgsTemplate(fields.argsTemplate || '{prompt}');
    const invokeEntry = { cmd: fields.cmd, args };
    return {
      ...base,
      invoke: { nonInteractive: invokeEntry, headless: invokeEntry },
      responseParser: fields.responseParser || 'plaintext',
    };
  }

  // API type
  return {
    ...base,
    baseUrl: fields.baseUrl || 'http://localhost:11434/v1',
    model: fields.model || 'default',
  };
}

/**
 * Interactive wizard for adding a custom agent.
 * @param {import('readline').Interface} rl
 */
export async function runAgentsWizard(rl) {
  console.log('');
  console.log('  Custom Agent Setup Wizard');
  console.log('  ─────────────────────────');

  function ask(prompt) {
    return new Promise((resolve) => {
      rl.question(`  ${prompt}: `, (ans) => resolve(ans.trim()));
    });
  }

  // 1. Name
  let name;
  while (true) {
    name = await ask('Agent name (e.g. copilot, mixtral)');
    const err = validateAgentName(name);
    if (!err) break;
    console.log(`  ✗ ${err}`);
  }

  // 2. Type
  const typeChoice = await promptChoice(rl, {
    prompt: 'Agent type',
    choices: [
      { value: 'cli', label: 'CLI agent', description: 'Spawns a local CLI tool (e.g. gh copilot, aider)' },
      { value: 'api', label: 'API endpoint', description: 'Calls an OpenAI-compatible HTTP API (e.g. Ollama, LM Studio)' },
    ],
  });
  const agentType = typeChoice.value;

  const fields = { name, type: agentType };

  if (agentType === 'cli') {
    fields.cmd = await ask('CLI command (e.g. gh, aider, continue)');
    fields.argsTemplate = await ask('Args template (e.g. copilot suggest -p {prompt})');

    const parserChoice = await promptChoice(rl, {
      prompt: 'Response parser',
      choices: [
        { value: 'plaintext', label: 'Plaintext', description: 'Capture stdout as-is' },
        { value: 'json', label: 'JSON', description: 'Parse JSON stdout, extract .content/.text field' },
        { value: 'markdown', label: 'Markdown', description: 'Capture markdown output as-is' },
      ],
      autoAccept: true,
    });
    fields.responseParser = parserChoice.value;
  } else {
    fields.baseUrl = await ask('Base URL (e.g. http://localhost:11434/v1)');
    fields.model = await ask('Model name (e.g. mixtral:8x7b, llama3.2)');
  }

  // Context budget
  const budgetRaw = await ask('Context budget in tokens (default: 32000)');
  fields.contextBudget = parseInt(budgetRaw, 10) || 32000;

  // Task profile
  const profileChoice = await promptChoice(rl, {
    prompt: 'Task affinity profile',
    choices: [
      { value: 'balanced', label: 'Balanced', description: 'Equal weight across all task types' },
      { value: 'code-focused', label: 'Code-focused', description: 'High weight for implementation, refactor, testing' },
      { value: 'review-focused', label: 'Review-focused', description: 'High weight for review, analysis, security' },
      { value: 'research-focused', label: 'Research-focused', description: 'High weight for research, documentation, analysis' },
    ],
  });
  fields.affinityPreset = profileChoice.value;

  // Council role
  const councilChoice = await promptChoice(rl, {
    prompt: 'Council role',
    choices: [
      { value: null, label: 'None', description: 'Excluded from council deliberation' },
      { value: 'analyst', label: 'Analyst', description: 'Critique and analysis role' },
      { value: 'architect', label: 'Architect', description: 'Planning and architecture role' },
      { value: 'implementer', label: 'Implementer', description: 'Implementation role' },
    ],
  });
  fields.councilRole = councilChoice.value;

  // Build entry
  const entry = buildCustomAgentEntry(fields);

  // MCP setup (CLI agents only)
  let mcpConfig = null;
  if (agentType === 'cli') {
    const knownPath = KNOWN_CLI_MCP_PATHS[fields.cmd];
    const mcpChoices = [
      { value: 'auto', label: 'Auto-detect', description: knownPath ? `Try ${knownPath}` : 'Attempt auto-detection' },
      { value: 'manual-path', label: 'Enter config path', description: "Provide the path to your agent's config file" },
      { value: 'skip', label: 'Skip', description: 'Show manual instructions at the end' },
    ];
    const mcpChoice = await promptChoice(rl, { prompt: 'MCP registration', choices: mcpChoices });

    if (mcpChoice.value === 'auto' && knownPath) {
      mcpConfig = { configPath: path.join(os.homedir(), knownPath), format: 'json' };
    } else if (mcpChoice.value === 'manual-path') {
      const rawPath = await ask('Path to agent config file (absolute path)');
      const fmt = await ask('Config format (json / other)');
      mcpConfig = { configPath: rawPath, format: fmt };
    }
  }

  // Save to config
  const cfg = loadHydraConfig();
  const customAgents = [...(cfg.agents?.customAgents || [])];
  const existing = customAgents.findIndex(a => a.name === entry.name);
  if (existing >= 0) {
    customAgents[existing] = entry;
  } else {
    customAgents.push(entry);
  }
  saveHydraConfig({ agents: { ...cfg.agents, customAgents } });

  console.log(`\n  ✓ Agent "${entry.name}" saved to config`);

  // MCP registration
  if (mcpConfig) {
    const mcpResult = registerCustomAgentMcp(mcpConfig);
    if (mcpResult.status === 'added' || mcpResult.status === 'updated') {
      console.log(`  ✓ Hydra MCP server registered with ${entry.name}`);
    } else if (mcpResult.status === 'exists') {
      console.log(`  ✓ Hydra MCP already registered with ${entry.name}`);
    } else {
      console.log('\n  Manual MCP setup required:\n');
      console.log(mcpResult.instructions?.split('\n').map(l => `    ${l}`).join('\n'));
    }
  } else if (agentType === 'cli') {
    const manualResult = registerCustomAgentMcp({ configPath: null });
    console.log('\n  MCP setup (manual):\n');
    console.log(manualResult.instructions?.split('\n').map(l => `    ${l}`).join('\n'));
  }

  console.log(`\n  Restart the operator for "${entry.name}" to be available for dispatch.\n`);
}
