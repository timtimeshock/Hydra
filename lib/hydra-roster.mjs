/**
 * Hydra Roster Editor — Inline REPL editor for role→agent→model assignments.
 *
 * Walks through each role in config.roles and lets the user change
 * the agent, model, and reasoning/thinking settings interactively.
 *
 * Usage:
 *   import { runRosterEditor } from './hydra-roster.mjs';
 *   await runRosterEditor(rl);
 */

import pc from 'picocolors';
import { loadHydraConfig, saveHydraConfig, getRoleConfig } from './hydra-config.mjs';
import {
  getActiveModel,
  getPhysicalAgentNames,
  getEffortOptionsForModel,
  getModelReasoningCaps,
  formatEffortDisplay,
} from './hydra-agents.mjs';
import { promptChoice } from './hydra-prompt-choice.mjs';
import { formatBenchmarkAnnotation } from './hydra-model-profiles.mjs';

/**
 * Run the interactive roster editor.
 * @param {readline.Interface} rl - Readline interface from the operator
 */
export async function runRosterEditor(rl) {
  const cfg = loadHydraConfig();
  const roles = cfg.roles || {};
  const recs = cfg.recommendations || {};
  const physicalAgents = getPhysicalAgentNames();
  const changes = [];

  console.log('');
  console.log(pc.bold('  Roster Editor'));
  console.log(pc.dim('  Walk through each role and adjust agent/model/reasoning settings.'));
  console.log(pc.dim('  Press Esc or Ctrl+C at any prompt to abort.'));
  console.log('');

  for (const [role, rc] of Object.entries(roles)) {
    const rec = recs[role];
    const currentAgent = rc.agent || 'claude';
    const currentModel = rc.model || '(agent default)';
    const currentEffort = rc.reasoningEffort || null;
    const effDisplay = formatEffortDisplay(rc.model || getActiveModel(currentAgent), currentEffort);

    // Step 1: Show current + ask keep/change/skip
    const benchAnnotation = formatBenchmarkAnnotation(rc.model || getActiveModel(currentAgent));
    const contextLines = [
      `Agent: ${currentAgent}`,
      `Model: ${currentModel}`,
      benchAnnotation ? `Benchmarks: ${benchAnnotation}` : null,
      effDisplay ? `Reasoning: ${effDisplay}` : null,
      rec?.note ? `Tip: ${rec.note}` : null,
    ].filter(Boolean);

    const actionResult = await promptChoice(rl, {
      title: `Role: ${role}`,
      context: contextLines.join('\n'),
      choices: [
        { label: 'Keep current', value: 'keep' },
        { label: 'Change', value: 'change' },
        { label: 'Skip to next', value: 'skip' },
      ],
    });

    if (!actionResult || actionResult.value === 'skip') continue;
    if (actionResult.value === 'keep') continue;

    // Step 2: Pick agent
    const agentChoices = physicalAgents.map((a) => {
      const isCurrent = a === currentAgent;
      const isRecommended = rec?.models?.some((m) => {
        const agentModels = cfg.models?.[a] || {};
        return m === agentModels.default || m === agentModels.fast || m === agentModels.cheap;
      });
      let desc = '';
      if (isCurrent) desc = '(current)';
      else if (isRecommended) desc = '(recommended)';
      return { label: a, value: a, description: desc };
    });

    const agentResult = await promptChoice(rl, {
      title: `${role}: Select Agent`,
      context: rec ? `Recommended models: ${rec.models.join(', ')}` : '',
      choices: agentChoices,
    });

    if (!agentResult) continue;
    const newAgent = agentResult.value;

    // Step 3: Pick model
    const agentModels = cfg.models?.[newAgent] || {};
    const modelChoices = [];

    // Add recommended models first
    const seen = new Set();
    if (rec?.models) {
      for (const m of rec.models) {
        if (!seen.has(m)) {
          seen.add(m);
          const annotation = formatBenchmarkAnnotation(m, { includePrice: false });
          const desc = annotation ? `(recommended) ${annotation}` : '(recommended)';
          modelChoices.push({ label: m, value: m, description: desc });
        }
      }
    }

    // Add agent presets
    for (const key of ['default', 'fast', 'cheap']) {
      const id = agentModels[key];
      if (id && !seen.has(id)) {
        seen.add(id);
        const annotation = formatBenchmarkAnnotation(id, { includePrice: false });
        const desc = annotation ? `(${key} preset) ${annotation}` : `(${key} preset)`;
        modelChoices.push({ label: id, value: id, description: desc });
      }
    }

    // Add current if not already listed
    if (rc.model && !seen.has(rc.model)) {
      modelChoices.push({ label: rc.model, value: rc.model, description: '(current)' });
    }

    // Add "agent default" option
    modelChoices.push({ label: '(agent default)', value: null, description: 'use the agent\'s default model' });

    const modelResult = await promptChoice(rl, {
      title: `${role}: Select Model`,
      context: `Agent: ${newAgent}`,
      choices: modelChoices,
      allowFreeform: true,
      freeformHint: 'Enter a model ID',
    });

    if (!modelResult) continue;
    const newModel = modelResult.value;

    // Step 4: Pick reasoning/thinking (if supported)
    const effectiveModel = newModel || getActiveModel(newAgent);
    const effortOptions = getEffortOptionsForModel(effectiveModel);
    let newEffort = null;

    if (effortOptions.length > 0) {
      const caps = getModelReasoningCaps(effectiveModel);
      const TITLES = {
        effort: 'Reasoning Effort',
        thinking: 'Thinking Budget',
        'model-swap': 'Thinking Mode',
      };
      const effortChoices = effortOptions.map((opt) => ({
        label: opt.label,
        value: opt.id,
        description: opt.hint || '',
      }));

      const effortResult = await promptChoice(rl, {
        title: `${role}: ${TITLES[caps.type] || 'Reasoning'}`,
        context: `Model: ${effectiveModel}`,
        choices: effortChoices,
      });

      if (effortResult) {
        newEffort = effortResult.value;
      }
    }

    // Record change
    changes.push({ role, agent: newAgent, model: newModel, reasoningEffort: newEffort });
  }

  // Apply changes
  if (changes.length === 0) {
    console.log(pc.dim('  No changes made.'));
    console.log('');
    return;
  }

  // Summary
  console.log('');
  console.log(pc.bold('  Changes to apply:'));
  for (const c of changes) {
    const eff = formatEffortDisplay(c.model || getActiveModel(c.agent), c.reasoningEffort);
    const effStr = eff ? pc.yellow(` ${eff}`) : '';
    const modelStr = c.model ? pc.white(c.model) : pc.dim('(agent default)');
    console.log(`  ${pc.cyan(c.role.padEnd(16))} ${c.agent}  ${modelStr}${effStr}`);
  }
  console.log('');

  // Persist
  const saveCfg = loadHydraConfig();
  for (const c of changes) {
    if (!saveCfg.roles) saveCfg.roles = {};
    saveCfg.roles[c.role] = {
      agent: c.agent,
      model: c.model,
      reasoningEffort: c.reasoningEffort,
    };
  }
  saveHydraConfig(saveCfg);
  console.log(`  ${pc.green('✓')} Saved ${changes.length} role update${changes.length > 1 ? 's' : ''} to hydra.config.json`);
  console.log('');
}
