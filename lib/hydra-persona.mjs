/**
 * hydra-persona.mjs — Unified personality layer for Hydra.
 *
 * Provides config-driven identity, voice, tone knobs, presets,
 * and an interactive editor. Human-facing interactions only —
 * autonomous pipelines (evolve/nightly/tasks) are excluded.
 */

import pc from 'picocolors';
import { loadHydraConfig, saveHydraConfig } from './hydra-config.mjs';

// ── Cache ────────────────────────────────────────────────────────────────────

let _cache = null;

export function invalidatePersonaCache() {
  _cache = null;
}

export function getPersonaConfig() {
  if (_cache) return _cache;
  const cfg = loadHydraConfig();
  _cache = cfg.persona || {};
  return _cache;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function isPersonaEnabled() {
  return getPersonaConfig().enabled !== false;
}

export function listPresets() {
  const p = getPersonaConfig();
  return Object.keys(p.presets || {});
}

// ── Tone Modifiers ───────────────────────────────────────────────────────────

const TONE_MODIFIERS = {
  formal: 'Maintain professional distance and precise terminology.',
  balanced: '',
  casual: 'Be approachable and conversational.',
  terse: 'Be extremely brief. No pleasantries.',
};

const VERBOSITY_MODIFIERS = {
  minimal: 'Keep responses under 3 sentences where possible.',
  concise: '',
  detailed: 'Provide thorough explanations with examples when helpful.',
};

const FORMALITY_MODIFIERS = {
  formal: 'Address the developer formally.',
  neutral: '',
  informal: 'Use casual, relaxed language.',
};

function buildToneBlock(p) {
  const parts = [];
  const tone = TONE_MODIFIERS[p.tone] || '';
  const verb = VERBOSITY_MODIFIERS[p.verbosity] || '';
  const form = FORMALITY_MODIFIERS[p.formality] || '';
  if (tone) parts.push(tone);
  if (verb) parts.push(verb);
  if (form) parts.push(form);
  if (p.humor === false) parts.push('Do not use humor, wit, or personality. Stay purely functional.');
  return parts.length ? parts.join(' ') : '';
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

export function getConciergeIdentity() {
  const p = getPersonaConfig();
  if (!p.enabled) return null; // caller falls back to hardcoded text

  const voice = p.voice || '';
  const toneBlock = buildToneBlock(p);
  const voiceLine = [voice, toneBlock].filter(Boolean).join(' ');

  return [
    p.identity || '',
    '',
    voiceLine ? `Communication style: ${voiceLine}` : '',
    '',
    'You are the conversational interface. You answer questions directly, help think through problems, and escalate to your specialized perspectives when hands-on work is needed.',
  ].filter((l) => l !== undefined).join('\n');
}

export function getAgentFraming(agentName) {
  const p = getPersonaConfig();
  const name = (agentName || '').toLowerCase();
  return p.agentFraming?.[name] || `You are ${p.name || 'Hydra'}'s ${name} perspective.`;
}

export function getProcessLabel(processKey) {
  const p = getPersonaConfig();
  return p.processLabels?.[processKey] || processKey;
}

// ── Preset Application ───────────────────────────────────────────────────────

export function applyPreset(presetName) {
  const cfg = loadHydraConfig();
  const persona = cfg.persona || {};
  const preset = persona.presets?.[presetName];
  if (!preset) return false;

  // Overlay preset values onto persona (voice only if preset specifies one)
  if (preset.tone) persona.tone = preset.tone;
  if (preset.verbosity) persona.verbosity = preset.verbosity;
  if (preset.formality) persona.formality = preset.formality;
  if (preset.humor !== undefined) persona.humor = preset.humor;
  if (preset.voice) persona.voice = preset.voice;

  cfg.persona = persona;
  saveHydraConfig(cfg);
  invalidatePersonaCache();
  return true;
}

// ── Display ──────────────────────────────────────────────────────────────────

export function showPersonaSummary() {
  const p = getPersonaConfig();
  const enabled = p.enabled !== false;
  const label = (v) => pc.white(v);
  const dim = (v) => pc.dim(v);

  console.log('');
  console.log(`  ${pc.bold(pc.cyan('Persona Configuration'))}`);
  console.log(`  ${dim('─'.repeat(36))}`);
  console.log(`  Enabled     ${enabled ? pc.green('on') : pc.red('off')}`);
  console.log(`  Name        ${label(p.name || 'Hydra')}`);
  console.log(`  Tone        ${label(p.tone || 'balanced')}`);
  console.log(`  Verbosity   ${label(p.verbosity || 'concise')}`);
  console.log(`  Formality   ${label(p.formality || 'neutral')}`);
  console.log(`  Humor       ${p.humor !== false ? pc.green('on') : pc.dim('off')}`);
  console.log('');
}

// ── Interactive Editor ───────────────────────────────────────────────────────

export async function runPersonaEditor(rl) {
  const { promptChoice } = await import('./hydra-prompt-choice.mjs');

  const cfg = loadHydraConfig();
  const persona = cfg.persona || {};
  const changes = [];

  showPersonaSummary();

  // Main menu loop
  let done = false;
  while (!done) {
    const action = await promptChoice(rl, {
      title: 'Persona Editor',
      choices: [
        { label: 'Switch preset', value: 'preset' },
        { label: 'Tweak settings', value: 'tweak' },
        { label: 'Edit name', value: 'name' },
        { label: persona.enabled !== false ? 'Disable persona' : 'Enable persona', value: 'toggle' },
        { label: 'Done', value: 'done' },
      ],
    });

    if (!action || action.value === 'done' || action.timedOut) {
      done = true;
      break;
    }

    if (action.value === 'preset') {
      const presetNames = Object.keys(persona.presets || {});
      if (presetNames.length === 0) {
        console.log(`  ${pc.dim('No presets available.')}`);
        continue;
      }
      const pick = await promptChoice(rl, {
        title: 'Select Preset',
        choices: presetNames.map((n) => ({ label: n, value: n })),
      });
      if (pick && pick.value) {
        const preset = persona.presets[pick.value];
        if (preset) {
          if (preset.tone) persona.tone = preset.tone;
          if (preset.verbosity) persona.verbosity = preset.verbosity;
          if (preset.formality) persona.formality = preset.formality;
          if (preset.humor !== undefined) persona.humor = preset.humor;
          if (preset.voice) persona.voice = preset.voice;
          changes.push(`preset → ${pick.value}`);
          console.log(`  ${pc.green('Applied preset:')} ${pick.value}`);
        }
      }
    }

    if (action.value === 'tweak') {
      // Tone
      const tone = await promptChoice(rl, {
        title: 'Tone',
        context: `Current: ${persona.tone || 'balanced'}`,
        choices: [
          { label: 'formal', value: 'formal' },
          { label: 'balanced', value: 'balanced' },
          { label: 'casual', value: 'casual' },
          { label: 'terse', value: 'terse' },
        ],
      });
      if (tone && tone.value) { persona.tone = tone.value; changes.push(`tone → ${tone.value}`); }

      // Verbosity
      const verb = await promptChoice(rl, {
        title: 'Verbosity',
        context: `Current: ${persona.verbosity || 'concise'}`,
        choices: [
          { label: 'minimal', value: 'minimal' },
          { label: 'concise', value: 'concise' },
          { label: 'detailed', value: 'detailed' },
        ],
      });
      if (verb && verb.value) { persona.verbosity = verb.value; changes.push(`verbosity → ${verb.value}`); }

      // Formality
      const form = await promptChoice(rl, {
        title: 'Formality',
        context: `Current: ${persona.formality || 'neutral'}`,
        choices: [
          { label: 'formal', value: 'formal' },
          { label: 'neutral', value: 'neutral' },
          { label: 'informal', value: 'informal' },
        ],
      });
      if (form && form.value) { persona.formality = form.value; changes.push(`formality → ${form.value}`); }

      // Humor
      const humor = await promptChoice(rl, {
        title: 'Humor',
        context: `Current: ${persona.humor !== false ? 'on' : 'off'}`,
        choices: [
          { label: 'On', value: true },
          { label: 'Off', value: false },
        ],
      });
      if (humor && humor.value !== undefined) { persona.humor = humor.value; changes.push(`humor → ${humor.value}`); }
    }

    if (action.value === 'name') {
      const nameResult = await promptChoice(rl, {
        title: 'Persona Name',
        context: `Current: ${persona.name || 'Hydra'}`,
        freeform: true,
        choices: [
          { label: 'Hydra', value: 'Hydra' },
          { label: 'Custom (type below)', value: '__freeform__' },
        ],
      });
      if (nameResult && nameResult.value && nameResult.value !== '__freeform__') {
        persona.name = nameResult.value;
        changes.push(`name → ${nameResult.value}`);
      }
    }

    if (action.value === 'toggle') {
      persona.enabled = persona.enabled === false;
      changes.push(`enabled → ${persona.enabled}`);
      console.log(`  Persona ${persona.enabled ? pc.green('enabled') : pc.red('disabled')}`);
    }
  }

  // Save if changed
  if (changes.length > 0) {
    cfg.persona = persona;
    saveHydraConfig(cfg);
    invalidatePersonaCache();
    console.log(`  ${pc.green('Saved')} ${changes.length} change${changes.length !== 1 ? 's' : ''}: ${changes.join(', ')}`);
  } else {
    console.log(`  ${pc.dim('No changes.')}`);
  }
}
