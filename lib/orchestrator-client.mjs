#!/usr/bin/env node
/**
 * CLI client for the local orchestrator daemon.
 */

import path from 'path';
import {
  parseArgsWithCommand,
  getOption,
  requireOption,
  parseList,
  request,
} from './hydra-utils.mjs';
import {
  AGENT_NAMES,
  getActiveModel,
  setActiveModel,
  getModelSummary,
  resolveModelId,
  getMode,
  setMode,
  resetAgentModel,
} from './hydra-agents.mjs';
import {
  hydraLogoCompact,
  renderDashboard,
  renderStatsDashboard,
  label,
  agentBadge,
  relativeTime,
  sectionHeader,
  divider,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
} from './hydra-ui.mjs';
import { checkUsage } from './hydra-usage.mjs';
import pc from 'picocolors';
import { spawnHydraNodeSync } from './hydra-exec.mjs';

const DEFAULT_URL = process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';

function print(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printHelp() {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  CLI client for the Hydra orchestrator daemon'));
  console.log('');
  console.log(`${pc.bold('Usage:')}  node orchestrator-client.mjs <command> [key=value]`);
  console.log('');
  console.log(pc.bold('Commands:'));
  console.log(`  ${ACCENT('status')}              Show daemon health`);
  console.log(`  ${ACCENT('summary')}             Dashboard with tasks, agents, handoffs`);
  console.log(`  ${ACCENT('state')}               Raw sync state JSON`);
  console.log(`  ${ACCENT('next')} agent=NAME      Suggested next action for agent`);
  console.log(`  ${ACCENT('prompt')} agent=NAME    Context prompt for agent`);
  console.log(`  ${ACCENT('session:start')} ...    Start a coordination session`);
  console.log(`  ${ACCENT('task:add')} title=...   Add a task`);
  console.log(`  ${ACCENT('task:route')} taskId=   Route task to best agent`);
  console.log(`  ${ACCENT('claim')} agent=...      Claim a task`);
  console.log(`  ${ACCENT('task:update')} ...      Update task status/notes`);
  console.log(`  ${ACCENT('decision:add')} ...     Record a decision`);
  console.log(`  ${ACCENT('blocker:add')} ...      Record a blocker`);
  console.log(`  ${ACCENT('handoff')} ...          Create agent handoff`);
  console.log(`  ${ACCENT('handoff:ack')} ...      Acknowledge a handoff`);
  console.log(`  ${ACCENT('events')} [limit=50]    Recent daemon events`);
  console.log(`  ${ACCENT('verify')} taskId=...    Run tsc verification`);
  console.log(`  ${ACCENT('archive')}              Archive completed items`);
  console.log(`  ${ACCENT('stats')}                Agent metrics & usage dashboard`);
  console.log(`  ${ACCENT('model')} [mode=|agent=]  Show/set mode & active models`);
  console.log(`  ${ACCENT('model:select')} [agent]  Interactive model picker`);
  console.log(`  ${ACCENT('archive:status')}       Show archive stats`);
  console.log(`  ${ACCENT('init')}                 Initialize Hydra for current project`);
  console.log(`  ${ACCENT('stop')}                 Stop the daemon`);
  console.log('');
  console.log(DIM('  Add json=true to any command for raw JSON output'));
  console.log('');
}

async function main() {
  const { command, options } = parseArgsWithCommand(process.argv);
  const baseUrl = getOption(options, 'url', DEFAULT_URL);
  const jsonMode = getOption(options, 'json', 'false') === 'true';

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return;
      case 'status': {
        const data = await request('GET', baseUrl, '/health');
        if (jsonMode) { print(data); return; }
        console.log('');
        console.log(hydraLogoCompact());
        console.log(label('Status', data.running ? SUCCESS('running') : ERROR('stopped')));
        console.log(label('PID', pc.white(String(data.pid || '?'))));
        console.log(label('Uptime', pc.white(`${data.uptimeSec || 0}s`)));
        console.log(label('Project', pc.white(String(data.project || '?'))));
        console.log(label('Events', pc.white(String(data.eventsRecorded || 0))));
        console.log(label('Last event', relativeTime(data.lastEventAt)));
        console.log(label('State updated', relativeTime(data.stateUpdatedAt)));
        console.log('');
        return;
      }
      case 'summary': {
        const data = await request('GET', baseUrl, '/summary');
        if (jsonMode) { print(data); return; }
        const agentNextMap = {};
        for (const agent of ['gemini', 'codex', 'claude']) {
          try {
            const nextData = await request('GET', baseUrl, `/next?agent=${encodeURIComponent(agent)}`);
            agentNextMap[agent] = nextData.next;
          } catch { agentNextMap[agent] = { action: 'unknown' }; }
        }
        // Gather extras for enhanced dashboard
        const extras = {};
        try {
          const usage = checkUsage();
          extras.usage = usage;
        } catch { /* ignore */ }
        try {
          const modelSummary = getModelSummary();
          extras.models = {};
          for (const [agent, info] of Object.entries(modelSummary)) {
            const short = (info.active || '').replace(/^claude-/, '').replace(/^gemini-/, '');
            if (!info.isDefault) extras.models[agent] = short;
          }
        } catch { /* ignore */ }
        console.log('');
        console.log(renderDashboard(data.summary, agentNextMap, extras));
        return;
      }
      case 'state':
        print(await request('GET', baseUrl, '/state'));
        return;
      case 'next': {
        const agent = requireOption(options, 'agent');
        const data = await request('GET', baseUrl, `/next?agent=${encodeURIComponent(agent)}`);
        if (jsonMode) { print(data); return; }
        const next = data.next;
        console.log('');
        console.log(`  ${agentBadge(agent)}  ${pc.white(next.action)}`);
        console.log(label('Message', next.message || 'n/a'));
        if (next.task) {
          console.log(label('Task', `${pc.bold(next.task.id)} ${DIM(next.task.title || '')}`));
        }
        if (next.handoff) {
          console.log(label('Handoff', `${pc.bold(next.handoff.id)} from ${next.handoff.from}`));
        }
        console.log('');
        return;
      }
      case 'prompt': {
        const agent = requireOption(options, 'agent');
        print(await request('GET', baseUrl, `/prompt?agent=${encodeURIComponent(agent)}`));
        return;
      }
      case 'session:start': {
        const focus = requireOption(options, 'focus', 'Example: focus="Fix onboarding deadlock"');
        const payload = {
          focus,
          owner: getOption(options, 'owner', 'human'),
          participants: parseList(getOption(options, 'participants', 'human,gemini,codex,claude')),
          branch: getOption(options, 'branch', ''),
        };
        print(await request('POST', baseUrl, '/session/start', payload));
        return;
      }
      case 'task:add': {
        const payload = {
          title: requireOption(options, 'title'),
          owner: getOption(options, 'owner', 'unassigned'),
          status: getOption(options, 'status', 'todo'),
          type: getOption(options, 'type', ''),
          files: parseList(getOption(options, 'files', '')),
          notes: getOption(options, 'notes', ''),
          blockedBy: parseList(getOption(options, 'blockedBy', '')),
        };
        print(await request('POST', baseUrl, '/task/add', payload));
        return;
      }
      case 'task:route': {
        const payload = {
          taskId: requireOption(options, 'taskId'),
        };
        print(await request('POST', baseUrl, '/task/route', payload));
        return;
      }
      case 'claim': {
        const payload = {
          agent: requireOption(options, 'agent'),
          taskId: getOption(options, 'taskId', ''),
          title: getOption(options, 'title', ''),
          files: parseList(getOption(options, 'files', '')),
          notes: getOption(options, 'notes', ''),
        };
        print(await request('POST', baseUrl, '/task/claim', payload));
        return;
      }
      case 'task:update': {
        const payload = {
          taskId: requireOption(options, 'taskId'),
        };
        if (options.status !== undefined) {
          payload.status = getOption(options, 'status');
        }
        if (options.owner !== undefined) {
          payload.owner = getOption(options, 'owner');
        }
        if (options.notes !== undefined) {
          payload.notes = getOption(options, 'notes');
        }
        if (options.files !== undefined) {
          payload.files = parseList(getOption(options, 'files'));
        }
        if (options.title !== undefined) {
          payload.title = getOption(options, 'title');
        }
        if (options.blockedBy !== undefined) {
          payload.blockedBy = parseList(getOption(options, 'blockedBy'));
        }

        print(await request('POST', baseUrl, '/task/update', payload));
        return;
      }
      case 'decision:add': {
        const payload = {
          title: requireOption(options, 'title'),
          owner: getOption(options, 'owner', 'human'),
          rationale: getOption(options, 'rationale', ''),
          impact: getOption(options, 'impact', ''),
        };
        print(await request('POST', baseUrl, '/decision', payload));
        return;
      }
      case 'blocker:add': {
        const payload = {
          title: requireOption(options, 'title'),
          owner: getOption(options, 'owner', 'human'),
          nextStep: getOption(options, 'nextStep', ''),
        };
        print(await request('POST', baseUrl, '/blocker', payload));
        return;
      }
      case 'handoff': {
        const payload = {
          from: requireOption(options, 'from'),
          to: requireOption(options, 'to'),
          summary: requireOption(options, 'summary'),
          nextStep: getOption(options, 'nextStep', ''),
          tasks: parseList(getOption(options, 'tasks', '')),
        };
        print(await request('POST', baseUrl, '/handoff', payload));
        return;
      }
      case 'handoff:ack': {
        const payload = {
          handoffId: requireOption(options, 'handoffId'),
          agent: requireOption(options, 'agent'),
        };
        print(await request('POST', baseUrl, '/handoff/ack', payload));
        return;
      }
      case 'events': {
        const limit = Number.parseInt(getOption(options, 'limit', '50'), 10);
        print(await request('GET', baseUrl, `/events?limit=${Number.isFinite(limit) ? limit : 50}`));
        return;
      }
      case 'verify': {
        const payload = {
          taskId: requireOption(options, 'taskId'),
        };
        print(await request('POST', baseUrl, '/verify', payload));
        return;
      }
      case 'archive':
        print(await request('POST', baseUrl, '/state/archive', {}));
        return;
      case 'stats': {
        try {
          const data = await request('GET', baseUrl, '/stats');
          if (jsonMode) { print(data); return; }
          console.log(renderStatsDashboard(data.metrics, data.usage));
        } catch {
          // Daemon not available — fall back to standalone usage
          const usage = checkUsage();
          console.log(renderStatsDashboard(null, usage));
        }
        return;
      }
      case 'model': {
        // Handle "reset" — clear all overrides
        if (getOption(options, 'reset', '') === 'true' || process.argv.includes('reset')) {
          setMode(getMode());
          console.log(`  ${SUCCESS('\u2713')} All agent overrides cleared, following mode ${ACCENT(getMode())}`);
          console.log('');
          return;
        }

        // Handle mode= switch
        const modeVal = getOption(options, 'mode', '');
        if (modeVal) {
          try {
            setMode(modeVal);
            console.log(`  ${SUCCESS('\u2713')} Mode ${DIM('\u2192')} ${ACCENT(modeVal)}`);
          } catch (e) {
            console.log(`  ${ERROR(e.message)}`);
          }
          console.log('');
          return;
        }

        // Parse agent=modelKey pairs from positionals and options
        const assignments = [];
        for (const [key, val] of Object.entries(options)) {
          if (AGENT_NAMES.includes(key)) {
            assignments.push({ agent: key, model: val });
          }
        }

        if (assignments.length > 0) {
          for (const { agent, model } of assignments) {
            if (model === 'default') {
              const resolved = resetAgentModel(agent);
              console.log(`  ${SUCCESS('\u2713')} ${pc.bold(agent)} ${DIM('\u2192')} ${pc.white(resolved)} ${DIM('(following mode)')}`);
            } else {
              const resolved = setActiveModel(agent, model);
              console.log(`  ${SUCCESS('\u2713')} ${pc.bold(agent)} ${DIM('\u2192')} ${pc.white(resolved)}`);
            }
          }
          console.log('');
          return;
        }

        // Show current models with mode info
        const summary = getModelSummary();
        const currentMode = summary._mode || getMode();
        console.log('');
        console.log(hydraLogoCompact());
        console.log(sectionHeader('Active Models'));
        console.log(`  ${pc.bold('Mode:')} ${ACCENT(currentMode)}`);
        console.log('');
        for (const [agent, info] of Object.entries(summary)) {
          if (agent === '_mode') continue;
          const badge = agentBadge(agent);
          const model = info.isOverride ? pc.white(info.active) : DIM(info.active);
          const tag = info.isOverride ? WARNING('(override)') : DIM(`(${info.tierSource})`);
          const effort = info.reasoningEffort ? pc.yellow(` [${info.reasoningEffort}]`) : '';
          console.log(`  ${badge}  ${model}${effort} ${tag}`);
        }
        console.log('');
        console.log(DIM('  Set mode:  hydra model mode=economy'));
        console.log(DIM('  Override:  hydra model codex=gpt-5.2-codex'));
        console.log(DIM('  Reset all: hydra model reset'));
        console.log(DIM('  Reset one: hydra model codex=default'));
        console.log(DIM('  Browse:    hydra model:select'));
        console.log('');
        return;
      }
      case 'model:select': {
        const { pickAgent, pickModel, applySelection } = await import('./hydra-models-select.mjs');

        // Optional agent arg: model:select claude
        let agentName = null;
        for (const [key, val] of Object.entries(options)) {
          if (AGENT_NAMES.includes(key)) { agentName = key; break; }
          if (AGENT_NAMES.includes(val)) { agentName = val; break; }
        }
        // Also check positionals
        if (!agentName) {
          for (const arg of process.argv.slice(3)) {
            const name = arg.toLowerCase().replace(/^--?/, '');
            if (AGENT_NAMES.includes(name)) { agentName = name; break; }
          }
        }

        if (!agentName) {
          console.log('');
          agentName = await pickAgent();
          if (!agentName) { console.log(DIM('  Cancelled.\n')); return; }
        }

        console.log('');
        const modelId = await pickModel(agentName);
        if (!modelId) { console.log(DIM('  Cancelled.\n')); return; }

        const current = getActiveModel(agentName);
        if (modelId === current) {
          console.log(`\n  ${DIM(`${modelId} is already active for ${agentName}.`)}\n`);
          return;
        }

        const resolved = applySelection(agentName, modelId);
        console.log(`\n  ${SUCCESS('\u2713')} ${pc.bold(agentName)} → ${pc.white(resolved)}  ${DIM('(mode → custom)')}\n`);
        return;
      }
      case 'archive:status':
        print(await request('GET', baseUrl, '/state/archive'));
        return;
      case 'init': {
        const syncScript = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'sync.mjs');

        console.log('');
        console.log(hydraLogoCompact());
        console.log(sectionHeader('Initialize'));

        // Run sync init
        console.log(label('Step 1', DIM('Creating coordination files...')));
        const initResult = spawnHydraNodeSync(syncScript, ['init'], {
          cwd: process.cwd(),
          encoding: 'utf8',
          windowsHide: true,
        });
        if (initResult.status === 0) {
          console.log(`  ${SUCCESS('\u2713')} Coordination files created`);
        } else {
          console.log(`  ${WARNING('\u26A0')} ${initResult.stderr || 'init had warnings'}`);
        }

        // Run doctor
        console.log(label('Step 2', DIM('Running diagnostics...')));
        const doctorResult = spawnHydraNodeSync(syncScript, ['doctor'], {
          cwd: process.cwd(),
          encoding: 'utf8',
          windowsHide: true,
        });
        console.log(doctorResult.stdout || '');

        console.log(`  ${SUCCESS('\u2713')} Hydra initialized for ${process.cwd()}`);
        console.log('');
        return;
      }
      case 'stop':
        print(await request('POST', baseUrl, '/shutdown', {}));
        return;
      default:
        throw new Error(`Unknown command "${command}". Run with "help".`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
