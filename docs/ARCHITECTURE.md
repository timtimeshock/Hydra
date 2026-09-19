# Hydra — Architecture & Module Reference

## Key Modules

> Reference for all `lib/` modules. See [CLAUDE.md](../CLAUDE.md) for workflow rules and commands.

- **`hydra-operator.mjs`** — Interactive command center. 5 orchestration modes (auto, council, dispatch, smart, chat). Auto mode uses 3-way routing: single (fast-path), tandem (`publishTandemDelegation()` creates 2 tasks + 2 handoffs), or council (direct, skipping mini-round triage). Council gate warns when council is overkill. Manages workers, status bar, concierge, model switching. `:dry-run` toggle previews dispatch route/agent selection without creating tasks. Smart ghost text: after `:status` with blocked tasks, shows Tab-submittable suggestion (deterministic + async AI upgrade via `conciergeSuggest()`). This is the largest module (~115KB).
- **`orchestrator-daemon.mjs`** — HTTP server with event-sourced state. Routes split into `daemon/read-routes.mjs` and `daemon/write-routes.mjs`. Handles task lifecycle, handoffs, sessions, worktrees. Heartbeat-based crash recovery: stale detector runs every 60s, requeues tasks with expired heartbeats (configurable timeout), moves exhausted-retry tasks to dead-letter queue. Dead-letter queue for exhausted-retry tasks (failCount >= maxAttempts). Event snapshots (`docs/coordination/snapshots/`) with auto-compaction. Idempotency keys (5min TTL) for mutation endpoints. Endpoints: `GET /dead-letter`, `POST /dead-letter/retry`, `POST /admin/compact`, `POST /task/:id/heartbeat`. Config: `workers.retry.maxAttempts`, `workers.heartbeatTimeoutMs`, `daemon.snapshot.everyNEvents`, `.retentionCount`.
- **`hydra-model-profiles.mjs`** — Single source of truth for model data (benchmarks, pricing, speed, capabilities, rate limits). Zero Hydra imports — sits at the bottom of the import tree. Exports `MODEL_PROFILES` (17 models), `ROLE_DEFAULTS` (6 roles), `AGENT_PRESETS` (3 agents × 3 tiers). Query functions: `getProfile(modelId)`, `getProfilesForAgent(agent)`, `getAgentPresets(agent)`, `getRoleRecommendation(role)`, `getFallbackOrder(agent, excludeId)`, `formatBenchmarkAnnotation(modelId, opts?)`, `getDefaultRoles()`, `getCostTable()`, `getReasoningCapsMap()`, `getShortName(modelId)`, `getConciergeFallbackChain()`, `getModeTiers()`, `getRateLimits(modelId, tier)`. Each profile includes per-tier `rateLimits` (RPM, TPM/ITPM/OTPM, RPD) keyed by tier number or `'free'`. Drives defaults in hydra-config, pricing in hydra-provider-usage, reasoning caps in hydra-agents, short names in hydra-ui, fallback ordering in hydra-model-recovery, rate limits in hydra-rate-limits, and benchmark annotations in hydra-roster and hydra-models-select. Source data: `docs/MODEL_PROFILES.md`.
- **`hydra-agents.mjs`** — Agent registry. Each agent has CLI commands, invoke modes (interactive/nonInteractive/headless), task affinities, council roles. Physical agents: `claude`, `gemini`, `codex` (CLI-backed), `local` (API-backed), plus any user-defined custom agents from `agents.customAgents[]` loaded by `initAgentRegistry()` with `customType: 'cli'|'api'`. Contains `getActiveModel()`, task classification, best-agent routing with adaptive affinity learning. `recordTaskOutcome(agent, taskType, outcome)` tracks success rates and adjusts affinity scores (persisted to `docs/coordination/agent-affinities.json`). `bestAgentFor(taskType, { mode, budgetState })` merges learned overrides with base affinities when `agents.affinityLearning.enabled`; accepts mode-aware routing opts so economy mode can boost `local` for impl/testing tasks. Exports `MODEL_REASONING_CAPS` (derived from hydra-model-profiles.mjs), `getModelReasoningCaps(modelId)`, `getEffortOptionsForModel(modelId)`, `formatEffortDisplay(modelId, effortValue)`, `recordTaskOutcome(agent, taskType, outcome)`, `invalidateAffinityCache()`. `getModelFlags()` adds `--reasoning-effort` for o-series (codex). Config: `agents.affinityLearning.enabled`, `.decayFactor`, `.minSampleSize`. Note: Claude thinking budget is API-only (handled in `hydra-anthropic.mjs`) — the CLI does not support `--thinking-budget`.
- **`hydra-config.mjs`** — Central config with `HYDRA_ROOT`, project detection, `loadHydraConfig()`/`saveHydraConfig()`, `getRoleConfig(roleName)`. Config file: `hydra.config.json`. Model defaults, roles, recommendations, modeTiers, and concierge fallbackChain are derived from hydra-model-profiles.mjs (user config still overrides via mergeWithDefaults). Config sections include `github` (enabled, defaultBase, draft, labels, reviewers, prBodyFooter), `evolve.suggestions` (enabled, autoPopulateFromRejected, autoPopulateFromDeferred, maxPendingSuggestions, maxAttemptsPerSuggestion), `nightly` (enabled, baseBranch, branchPrefix, maxTasks, maxHours, perTaskTimeoutMs, sources, aiDiscovery, budget, tasks, investigator), `providers` (openai.adminKey, openai.tier, anthropic.adminKey, anthropic.tier, google.tier), `routing` (mode: 'economy'|'balanced'|'performance', useLegacyTriage, councilGate, tandemEnabled, councilMode, councilTimeoutMs), `local` (enabled, baseUrl, model, fastModel, budgetGate.dailyPct/weeklyPct — Ollama-compatible local LLM, disabled by default), `agents.customAgents[]` (user-registered CLI/API agents — see hydra-agents-wizard.mjs), `modelRecovery` (enabled, autoPersist, headlessFallback), `rateLimits` (maxRetries, baseDelayMs, maxDelayMs), `persona` (enabled, name, tone, verbosity, formality, humor, identity, voice, agentFraming, processLabels, presets). Provider `tier` values: OpenAI 1-5, Anthropic 1-4, Google `'free'`/1/2 — used by `hydra-rate-limits.mjs` for capacity tracking. `routing` section is deep-merged (not shallow) so partial overrides work correctly. Exports `AFFINITY_PRESETS` (4 task affinity presets: balanced, code-focused, review-focused, research-focused) used by the agents wizard.
- **`hydra-council.mjs`** — Two execution modes via `routing.councilMode`. **Sequential** (default): propose (Claude) → critique (Gemini) → refine (Claude) → implement (Codex). **Adversarial** (`'adversarial'`): DIVERGE (all 3 agents answer independently in parallel) → ATTACK (all 3 agents attack each other's strongest assumptions in parallel) → SYNTHESIZE (Claude as designated decider, scores criteria, reversibility tiebreaker) → IMPLEMENT (Codex). Both modes use structured convergence: explicit decision criteria (`correctness`, `complexity`, `reversibility`, `user_impact`), assumption challenges, final synthesis object with owner/confidence/nextAction/reversibleFirstStep — no majority vote. `runCrossVerification()` extended with `strongestAssumption`, `attackVector`, `criteriaScores`. Exports `COUNCIL_DECISION_CRITERIA`, `buildStepPrompt()`, `synthesizeCouncilTranscript()`. Async agent calls via `executeAgentWithRecovery()` with rate limit retry (backoff + 1 retry on 429), timeout retry (strips transcript context via empty transcript to `buildStepPrompt()`, retries once with bare prompt — shown as `(compacted retry)` in spinner), doctor notification on phase failure, and recovery tracking in transcript. Phase timeout configurable via `routing.councilTimeoutMs` (default: 420000ms / 7min).
- **`hydra-evolve.mjs`** — 7-phase autonomous improvement rounds with budget tracking, investigator self-healing, knowledge accumulation, and rate limit resilience (exponential backoff on 429/RESOURCE_EXHAUSTED for Gemini direct API and all agents via `executeAgentWithRetry`). IMPLEMENT phase (`phaseImplement`) accepts `agentOverride` param; after all Codex attempts exhaust, automatically falls back to Claude if Claude is not disabled — phase label shows `IMPLEMENT (claude)` when override is active.
- **`hydra-concierge.mjs`** — Multi-provider conversational front-end (OpenAI → Anthropic → Google fallback chain). Detects `[DISPATCH]` intent to escalate. Enriched system prompt with git info, recent completions, active workers. Bidirectional daemon communication via `POST /events/push`. Imports `COST_PER_1K` and `estimateCost` from `hydra-provider-usage.mjs` (re-exports `COST_PER_1K` for backward compat). Exports `getActiveProvider()`, `getConciergeModelLabel()`, `switchConciergeModel()`, `exportConversation()`, `getRecentContext()`, `conciergeSuggest()` (stateless one-shot suggestion for ghost text).
- **`hydra-concierge-providers.mjs`** — Provider abstraction layer with capacity-aware fallback. `detectAvailableProviders()`, `buildFallbackChain()`, `streamWithFallback()`. Dynamically reorders providers by remaining capacity (healthiest first via `getHealthiestProvider()`), performs pre-request capacity checks (`canMakeRequest()`), and skips exhausted providers. Lazy-loads provider modules via `await import()`.
- **`hydra-anthropic.mjs`** — Streaming client for Anthropic Messages API. Supports extended thinking via `cfg.thinkingBudget`. Uses `hydra-streaming-middleware.mjs` pipeline for all cross-cutting concerns. Core function handles Anthropic-specific SSE format, system message extraction, and rate limit header parsing.
- **`hydra-google.mjs`** — Streaming client for Google Gemini Generative Language API. Uses `hydra-streaming-middleware.mjs` pipeline. Core function handles Google-specific role mapping, `systemInstruction`, and `RESOURCE_EXHAUSTED` detection. Returns `rateLimits: null` (Google doesn't send rate limit headers on success).
- **`hydra-metrics.mjs`** — In-memory metrics store with file persistence. Handle-based API: `recordCallStart(agent, model)` returns handle, `recordCallComplete(handle, result)` accepts `result.stdout` or `result.output` with optional `result.outcome` (`success`/`partial`/`failed`/`rejected`). Extracts real tokens from Claude JSON and Codex JSONL output. Latency percentiles (p50/p95/p99) via `calculatePercentiles()`. SLO checking: `checkSLOs(sloConfig)` compares per-agent p95 latency and error rate against thresholds. Cost analysis: `getCostByOutcome(agentName?)` aggregates history by outcome. Exports `getRecentTokens(agentName, windowMs)`, `getSessionUsage()`, `getMetricsSummary()`, `checkSLOs(sloConfig)`, `getCostByOutcome(agentName?)`, `metricsEmitter` (EventEmitter). Config: `metrics.slo.{agent}.maxP95Ms`, `.maxErrorRate`, `metrics.alerts.enabled`.
- **`hydra-usage.mjs`** — Token usage monitor. Reads Claude Code's `stats-cache.json` + hydra-metrics fallback. Three budget tiers: weekly (primary, matches Claude's actual limit structure), daily (secondary), and sliding window (`windowHours`/`windowTokenBudget`). `checkUsage()` returns combined assessment with `weekly` sub-object. Uses local dates for stats-cache comparison (not UTC). Distinguishes `hydra-metrics-real` vs `hydra-metrics-estimate` sources. Standalone CLI: `node lib/hydra-usage.mjs`.
- **`hydra-worker.mjs`** — `AgentWorker` class (EventEmitter). Headless background agent execution with claim→execute→report loop. Sends periodic heartbeats to daemon during task execution (`POST /task/:id/heartbeat`) for crash recovery. Records per-call metrics. Codex workers use `--json` for JSONL output with real token usage extraction. Events include `title` for contextual display. Error recovery order: (1) `detectUsageLimitError()` — account quota exhaustion, no retry, annotates result as `usage-limit`; (2) `detectCodexError()` — sandbox/auth/invocation issues, no model fallback; (3) `detectModelError()` — model unavailable, triggers fallback via `recoverFromModelError()`. Config: `workers.heartbeatIntervalMs` (default: 30s), `workers.heartbeatTimeoutMs` (default: 90s).
- **`hydra-ui.mjs`** — All terminal rendering. Uses `picocolors` (`pc`) exclusively — never chalk. Exports `AGENT_COLORS`, `AGENT_ICONS`, `stripAnsi`, formatters. `createSpinner()` supports themed styles with per-style colors: `solar` (yellow, dispatch agents), `orbital` (magenta, council deliberation), `stellar` (yellow, concierge thinking), `eclipse` (white, dispatch handoff). Custom color via `opts.color`.
- **`hydra-statusbar.mjs`** — 5-line persistent ANSI footer. SSE event streaming preferred, polling fallback. Ticker events show task/handoff context (title/summary) alongside IDs.
- **`hydra-prompt-choice.mjs`** — Interactive numbered-choice prompt with rounded box UI. Dynamic width (60-120 cols, 90% terminal), word-wrapped context values, cooperative readline lock, auto-accept mode, freeform input support, animated box draw-in. Supports `multiSelect: true` mode with checkbox rendering (`[x]`/`[ ]`), toggle input (numbers, ranges `1-3`, `a` for all), and `preSelected` values. Exports `parseMultiSelectInput()`, `confirmActionPlan(rl, opts)` for action plan summary + binary confirm.
- **`hydra-roster.mjs`** — Inline REPL editor for role→agent→model assignments. Walks each role in `config.roles`, offers keep/change/skip, then agent→model→reasoning pickers. Uses `promptChoice()` and `getEffortOptionsForModel()`. Exports `runRosterEditor(rl)`. Accessed via `:roster` command.
- **`hydra-persona.mjs`** — Unified personality layer. Config-driven identity, voice, tone knobs, presets, and interactive editor. Exports `getPersonaConfig()`, `isPersonaEnabled()`, `getConciergeIdentity()`, `getAgentFraming(agentName)`, `getProcessLabel(processKey)`, `invalidatePersonaCache()`, `applyPreset(presetName)`, `listPresets()`, `showPersonaSummary()`, `runPersonaEditor(rl)`. Config: `persona.enabled`, `.name`, `.tone` (formal/balanced/casual/terse), `.verbosity` (minimal/concise/detailed), `.formality` (formal/neutral/informal), `.humor`, `.identity`, `.voice`, `.agentFraming`, `.processLabels`, `.presets`. Accessed via `:persona` command.
- **`hydra-local.mjs`** — Streaming client for any OpenAI-compatible local endpoint (Ollama, LM Studio, vllm, etc.). `streamLocalCompletion(messages, cfg, onChunk)` wraps the OpenAI SSE format with configurable `baseUrl`. Returns `{ ok, fullResponse, output, usage, rateLimits: null }`. On ECONNREFUSED returns `{ ok: false, errorCategory: 'local-unavailable' }` triggering transparent cloud fallback. Config: `local.enabled`, `.baseUrl` (default: `http://localhost:11434/v1`), `.model`, `.budgetGate`.
- **`hydra-openai.mjs`** — Shared `streamCompletion()` for OpenAI API. Callers must always pass `cfg.model`. Uses `hydra-streaming-middleware.mjs` pipeline for rate limiting, circuit breaking, retry, usage tracking, header capture, telemetry, and latency measurement. Core function handles only HTTP call + SSE parsing.
- **`hydra-sub-agents.mjs`** — Built-in virtual sub-agent definitions (security-reviewer, test-writer, doc-generator, researcher, evolve-researcher, failure-doctor). Registered at startup via `registerBuiltInSubAgents()`.
- **`hydra-agent-forge.mjs`** — Multi-model agent creation pipeline. 5-phase: ANALYZE (Gemini) → DESIGN (Claude) → CRITIQUE (Gemini) → REFINE (Claude) → TEST (optional). Exports `runForgeWizard()`, `forgeAgent()`, `runForgePipeline()`, `analyzeCodebase()`, `validateAgentSpec()`, `testForgedAgent()`, `persistForgedAgent()`, `removeForgedAgent()`, `loadForgeRegistry()`/`saveForgeRegistry()`, `listForgedAgents()`, `generateSamplePrompt()`. Metadata stored in `docs/coordination/forge/FORGE_REGISTRY.json`. Config: `forge.enabled`, `.autoTest`, `.phaseTimeoutMs`, `.storageDir`.
- **`hydra-model-recovery.mjs`** — Post-hoc model error detection, rate/usage limit handling, circuit breaker, Codex-specific error detection, and fallback. Four detection tiers: (1) `detectUsageLimitError()` — long-term account quota exhaustion (days until reset, NO retries); (2) `detectRateLimitError()` — transient rate limits (retry with backoff); (3) `detectCodexError()` — Codex-specific non-model errors that should NOT be retried with a different model. Expanded categories: sandbox, auth, invocation, internal ("something went wrong", "unexpected error"), config, context-overflow, timeout, network, signal, silent-crash, codex-jsonl-error, codex-unknown (catch-all with rich diagnostics — ensures no Codex failure goes undetected); (4) `detectModelError()` — model unavailability (fallback selection). Circuit breaker: `recordModelFailure(model)` tracks failures per model within a window; `isCircuitOpen(model)` returns true when failure threshold exceeded (auto-resets after window). `detectRateLimitError()` automatically skips usage-limit matches to prevent double-detection. Exports `detectUsageLimitError(agent, result)`, `formatResetTime(seconds)`, `detectCodexError(agent, result)`, `detectModelError(agent, result)`, `detectRateLimitError(agent, result)`, `calculateBackoff(attempt, opts)`, `getFallbackCandidates(agent, failedModel)`, `recoverFromModelError(agent, failedModel, opts)`, `isModelRecoveryEnabled()`, `recordModelFailure(model)`, `isCircuitOpen(model)`, `getCircuitState()`, `resetCircuitBreaker(model)`. Config: `modelRecovery.enabled`, `.autoPersist`, `.headlessFallback`, `.circuitBreaker.enabled`, `.circuitBreaker.failureThreshold`, `.circuitBreaker.windowMs`; `rateLimits.maxRetries`, `.baseDelayMs`, `.maxDelayMs`.
- **`hydra-env.mjs`** — Minimal `.env` loader. Auto-loads on import. Real env vars take priority.
- **`hydra-github.mjs`** — GitHub integration via `gh` CLI. Exports `gh()`, `isGhAvailable()`, `isGhAuthenticated()`, `detectRepo()`, `createPR()`, `listPRs()`, `getPR()`, `mergePR()`, `closePR()`, `pushBranchAndCreatePR()`, `verifyRequiredChecks()`, `getGitHubConfig()`. Auto-generates PR title/body from branch name and commit log. PR template detection (checks `.github/pull_request_template.md` variants), auto-label detection from changed files via pattern matching. `verifyRequiredChecks()` validates CI checks against `config.github.requiredChecks`. Config: `github.requiredChecks`, `github.autolabel` (label→pattern map).
- **`hydra-shared/`** — Shared infrastructure for nightly and evolve pipelines:
  - `git-ops.mjs` — Git helpers (parameterized baseBranch): `git()`, `getCurrentBranch()`, `checkoutBranch()`, `createBranch()`, `getBranchStats()`, `smartMerge()`, plus remote sync helpers: `getRemoteUrl()`, `parseRemoteUrl()`, `fetchOrigin()`, `pushBranch()`, `hasRemote()`, `getTrackingBranch()`, `isAheadOfRemote()`.
  - `constants.mjs` — `BASE_PROTECTED_FILES`, `BASE_PROTECTED_PATTERNS`, `BLOCKED_COMMANDS`
  - `guardrails.mjs` — `verifyBranch()`, `isCleanWorkingTree()`, `buildSafetyPrompt()` (supports `attribution` param for commit trailers), `scanBranchViolations()`, `scanForSecrets(projectRoot, changedFiles)` (filename + content pattern matching), `checkDiffSize(projectRoot, branchName, opts)` (enforces `maxDiffLines`). Config: `verification.secretsScan`, `.maxDiffLines`.
  - `budget-tracker.mjs` — Base `BudgetTracker` class with configurable thresholds
  - `agent-executor.mjs` — Unified `executeAgent()` with stdin piping, stderr capture, progress ticking, OTel span instrumentation. Auto-resolves codex model via `getActiveModel()`. Returns `{ output, stdout, stderr, exitCode, signal, errorCategory?, errorDetail?, errorContext?, ... }` (`stdout` alias for metrics compatibility). Accepts `opts.reasoningEffort` for role-specific overrides, `opts.permissionMode` to override permission level (claude: `'plan'`|`'auto-edit'`, codex: `'read-only'`|`'full-auto'`). Adds `--reasoning-effort` for o-series (codex). Note: Claude thinking budget is API-only — not passed as CLI flag. Also exports `diagnoseAgentError(agent, result)` — post-hoc error classification that enriches failed results with `errorCategory` (auth/sandbox/permission/invocation/network/server/parse/internal/oom/crash/signal/silent-crash/codex-jsonl-error/usage-limit/unclassified) and `errorDetail`. For Codex, extracts structured JSONL error events from `--json` output before falling back to generic exit code interpretation. Called automatically on every failed `executeAgent()` result. Also exports `executeAgentWithRecovery()` — wraps `executeAgent()` with OTel pipeline span, usage limit detection (no retry), rate limit retry (backoff, configurable retries), circuit breaker check, and model-error fallback via `hydra-model-recovery.mjs`. Used by operator (cross-model verification) and dispatch pipeline (sequential agent calls).
  - `review-common.mjs` — Interactive review helpers: `handleBranchAction()` (with `[p]r` option when `gh` available, `useSmartMerge` option for auto-rebase), `loadLatestReport()`, `cleanBranches()`
- **`hydra-evolve-suggestions.mjs`** — Persistent suggestions backlog for evolve pipeline. Stores improvement ideas from failed/deferred rounds, user input, and review sessions. Exports `loadSuggestions()`, `saveSuggestions()`, `addSuggestion()`, `updateSuggestion()`, `removeSuggestion()`, `getPendingSuggestions()`, `getSuggestionById()`, `searchSuggestions()`, `createSuggestionFromRound()`, `promptSuggestionPicker()`, `getSuggestionStats()`, `formatSuggestionsForPrompt()`. Storage: `docs/coordination/evolve/SUGGESTIONS.json`.
- **`hydra-evolve-suggestions-cli.mjs`** — Standalone CLI for managing suggestions backlog. Subcommands: `list`, `add`, `remove`, `reset`, `import`, `stats`.
- **`hydra-activity.mjs`** — Real-time activity digest for concierge situational awareness. `detectSituationalQuery()` classifies "What's going on?" style queries. `buildActivityDigest()` fetches `GET /activity` + merges local state. `formatDigestForPrompt()` renders structured digest. `generateSitrep()` produces AI-narrated situation reports via the concierge provider chain (falls back to raw digest if no provider available). Ring buffer via `pushActivity()`/`getRecentActivity()`. Session summaries: `saveSessionSummary(text)` persists to `docs/coordination/session-summaries.json` (max 10), `getSessionContext()` returns recent activity + last 3 prior sessions for cross-session continuity. Annotation helpers: `annotateDispatch()`, `annotateHandoff()`, `annotateCompletion()`.
- **`hydra-codebase-context.mjs`** — Codebase knowledge injection for concierge. `loadCodebaseContext()` parses CLAUDE.md sections + builds module index. `detectCodebaseQuery()` classifies architecture questions by topic. `getTopicContext(topic)` returns focused context (12 topics: dispatch, council, config, workers, agents, concierge, evolve, daemon, ui, modules, github, metrics). `getBaselineContext()` returns permanent baseline for system prompt. `searchKnowledgeBase()` queries evolve KB. `getConfigReference()` formats config sections.
- **`hydra-tasks-scanner.mjs`** — Aggregates work items from code comments (git grep TODO/FIXME/HACK/XXX), `docs/TODO.md` unchecked items, and GitHub issues. Exports `scanAllSources()`, `scanTodoComments()`, `scanTodoMd()`, `scanGitHubIssues()`, `createUserTask()`, `deduplicateTasks()`, `prioritizeTasks()`, `taskToSlug()`. Returns `ScannedTask[]` with id, title, slug, source, taskType, suggestedAgent, complexity, priority.
- **`hydra-tasks.mjs`** — Autonomous tasks runner. Interactive setup (scan → select → budget) then executes per-task lifecycle: CLASSIFY → PLAN (complex only) → EXECUTE → VERIFY → DECIDE (council-lite for complex). Branch isolation (`tasks/{date}/{slug}`), BudgetTracker with 4 thresholds, investigator self-healing, model recovery. Generates JSON + Markdown reports to `docs/coordination/tasks/`.
- **`hydra-tasks-review.mjs`** — Post-run interactive review. Subcommands: `review` (walk branches, merge/skip/diff/delete/PR), `status` (show latest report), `clean` (delete all `tasks/*` branches). Same pattern as `hydra-nightly-review.mjs`.
- **`hydra-nightly.mjs`** — Autonomous overnight task execution. 6-phase pipeline: SCAN → DISCOVER → PRIORITIZE → SELECT (optional, `--interactive`) → EXECUTE → REPORT. SELECT phase presents tasks grouped by source with interactive pick/add/confirm. EXECUTE phase renders a live progress dashboard (task checklist with status icons, budget gauge, elapsed time, per-task agent progress). Config-driven via `nightly` section. Supports `--dry-run`, `--no-discovery`, `--interactive`, CLI overrides.
- **`hydra-nightly-discovery.mjs`** — AI discovery phase for nightly pipeline. Dispatches an agent (default: gemini) to analyze the codebase and propose improvement tasks. Returns `ScannedTask[]` for merging. Non-blocking (failures return `[]`). Exports `runDiscovery(projectRoot, opts)`.
- **`hydra-nightly-review.mjs`** — Post-run interactive review. Reads `baseBranch` from report JSON. Smart merge via `smartMerge()` (auto-rebases when base has advanced). Dev-advanced detection warns when base has diverged. Subcommands: `review`, `status`, `clean`.
- **`hydra-mcp-server.mjs`** — MCP server using official `@modelcontextprotocol/sdk` (protocol 2025-03-26). Exposes 11 tools (Zod-validated schemas), 5 resources (`hydra://config`, `hydra://metrics`, `hydra://agents`, `hydra://activity`, `hydra://status`), and 3 prompts (`hydra_council`, `hydra_review`, `hydra_analyze`). Two modes: **standalone** (`hydra_ask` + `hydra_forge` work without daemon) and **daemon** (task queue, handoffs, council, status). Dependencies: `@modelcontextprotocol/sdk`, `zod`.
- **`hydra-investigator.mjs`** — Re-exports from `hydra-evolve-investigator.mjs`. Self-healing failure diagnosis (shared).
- **`hydra-knowledge.mjs`** — Re-exports from `hydra-evolve-knowledge.mjs`. Persistent knowledge base (shared).
- **`hydra-doctor.mjs`** — Higher-level failure diagnostic and triage layer. Fires on non-trivial failures in evolve/nightly/tasks. Calls existing investigator for diagnosis, triages into follow-ups (daemon task, suggestion backlog entry, or KB learning), and tracks recurring error patterns via append-only NDJSON log. Exports `initDoctor()`, `isDoctorEnabled()`, `diagnose(failure)`, `getDoctorStats()`, `getDoctorLog(limit)`, `resetDoctor()`. `resetDoctor()` removes entries written during the current session from the persistent log file (tracked via `_sessionEntries`), making it safe for test `beforeEach/afterEach` hooks without contaminating the production log. Action pipeline scanners: `scanDoctorLog()`, `scanDaemonIssues(baseUrl)`, `scanErrorActivity()`, `enrichWithDiagnosis(items, cliContext)`, `executeFixAction(item, opts)`. Storage: `docs/coordination/doctor/DOCTOR_LOG.ndjson`. Config: `doctor.enabled`, `.autoCreateTasks`, `.autoCreateSuggestions`, `.addToKnowledgeBase`, `.recurringThreshold`, `.recurringWindowDays`. Accessible via `:doctor` and `:doctor fix` operator commands.
- **`hydra-cleanup.mjs`** — Cleanup scanners and executors for the `:cleanup` command. Scans for stale/completed items across the system. Scanners: `scanArchivableTasks(baseUrl)`, `scanOldHandoffs(baseUrl)`, `scanStaleBranches(projectRoot)`, `scanStaleTasks(baseUrl)`, `scanAbandonedSuggestions()`, `scanOldCheckpoints(projectRoot)`, `scanOldArtifacts(projectRoot)`. Enrichment: `enrichCleanupWithSitrep(items, opts)`. Executor: `executeCleanupAction(item, opts)` — maps `item.category` (archive/delete/requeue/cleanup) to appropriate actions (daemon task update, branch deletion, file removal, suggestion cleanup).
- **`hydra-action-pipeline.mjs`** — Unified SCAN → ENRICH → SELECT → CONFIRM → EXECUTE → REPORT pipeline. `runActionPipeline(rl, opts)` enforces a consistent interactive workflow: parallel scanners → optional AI enrichment → multi-select → confirmation → per-item execution with spinners → summary report. Used by `:doctor fix` and `:cleanup`. All future scan→select→act workflows should use this pipeline.
- **`hydra-output-history.mjs`** — CLI output ring buffer. Intercepts `process.stdout.write`/`process.stderr.write` to capture recent terminal output. Exports `initOutputHistory(opts?)`, `getRecentOutput(n?)`, `getRecentOutputRaw(n?)`, `clearOutputHistory()`, `getOutputContext()`. Filters status bar redraws, strips ANSI for clean text. Initialized at operator startup.
- **`hydra-resume-scanner.mjs`** — Unified resumable state detection. Scans daemon (paused/stale/handoffs), evolve session state, council checkpoints, unmerged branches (evolve/nightly/tasks), and pending suggestions in parallel via `Promise.allSettled`. Exports `scanResumableState({ baseUrl, projectRoot })` returning `ResumableItem[]`. Used by the unified `:resume` command.
- **`hydra-setup.mjs`** — CLI awareness setup. Detects installed AI CLIs (Claude Code, Gemini CLI, Codex CLI), registers Hydra MCP server globally, generates project-level HYDRA.md. Exports `detectInstalledCLIs()`, `buildMcpServerEntry()`, `mergeClaudeConfig()`, `mergeGeminiConfig()`, `registerCodexMcp()`, `generateHydraMdTemplate()`, `main()`, `registerCustomAgentMcp(opts)` (inject Hydra MCP into custom agent JSON config, or return manual instructions; opts: `{ configPath, format, force }`; returns `{ status: 'added'|'exists'|'updated'|'manual', instructions? }`), `KNOWN_CLI_MCP_PATHS` (map of CLI name → auto-detect config path). Subcommands: `setup` (global MCP registration), `init` (project HYDRA.md generation). Config targets: `~/.claude.json`, `~/.gemini/settings.json`, `~/.codex/config.toml` (via CLI).
- **`hydra-agents-wizard.mjs`** — Interactive wizard for registering custom CLI and API agents. `runAgentsWizard(rl)` walks CLI or API track, writes to `agents.customAgents[]` in config, and calls `registerCustomAgentMcp()`. Exports `buildCustomAgentEntry(fields)` (builds config entry from wizard fields), `parseArgsTemplate(template)` (splits args string into array), `validateAgentName(name)` (rejects reserved names, enforces lowercase-alphanumeric format). Accessed via `:agents add`.
- **`hydra-provider-usage.mjs`** — Per-provider token usage tracking (local + external billing APIs). Single source of truth for `COST_PER_1K` pricing table (moved from concierge). Two-layer: session counters from streaming calls + external API queries (OpenAI/Anthropic admin keys). Exports `recordProviderUsage()`, `getProviderUsage()`, `getProviderSummary()`, `getExternalSummary()`, `loadProviderUsage()`, `saveProviderUsage()`, `resetSessionUsage()`, `refreshExternalUsage()`, `COST_PER_1K`, `estimateCost()`. Persistence: `docs/coordination/provider-usage.json` (7-day retention). Also persists RPD state from `hydra-rate-limits.mjs` (loaded on startup, saved alongside daily counters). Config: `providers.openai.adminKey`, `providers.anthropic.adminKey` (or env `OPENAI_ADMIN_KEY`, `ANTHROPIC_ADMIN_KEY`).
- **`hydra-cache.mjs`** — Shared LRU cache with TTL, content hashing (SHA-256), and negative cache. Named namespaces (`routing`, `agent`, `negative`). Exports `getCached(ns, key)`, `setCached(ns, key, val, opts)`, `invalidateCache(ns, key?)`, `recordNegativeHit(ns, key, err)`, `isNegativeHit(ns, key)`, `getCacheStats()`, `contentHash(data)`. Config: `cache.enabled`, `.maxEntries`, `.ttlSec`, `.negativeCache.enabled`, `.negativeCache.ttlSec`.
- **`hydra-rate-limits.mjs`** — Consolidated rate limiting module: passive tracking (RPM/TPM/RPD sliding windows, header capture, health scoring) + token bucket enforcement (per-provider `TokenBucket`, concurrency counter). Exports passive: `recordApiRequest()`, `updateFromHeaders()`, `canMakeRequest()`, `getRemainingCapacity()`, `getHealthiestProvider()`, `getRateLimitSummary()`, `loadRpdState()`, `getRpdState()`. Exports enforcement: `acquireRateLimit(provider)`, `tryAcquireRateLimit()`, `getRateLimitStats()`, `resetRateLimiter()`, `initRateLimiters()`, `TokenBucket`, `initConcurrency()`, `acquireConcurrencySlot()`, `tryAcquireConcurrencySlot()`, `getConcurrencyStats()`. Config: `providers.rateLimit.openai`, `.anthropic`, `.google`; `providers.*.tier`.
- **`hydra-eval.mjs`** — Routing evaluation harness against golden corpora. Evaluates `classifyPrompt()` and `bestAgentFor()` against labeled test cases. Exports `loadGoldenCorpus(paths)`, `evaluateRouting(corpus)`, `evaluateAgentSelection(corpus)`, `generateEvalReport(results)`. Reports: `docs/coordination/eval/eval_*.{json,md}`. CLI: `npm run eval`. Config: `eval.corpusPaths`.
- **`hydra-streaming-middleware.mjs`** — Composable middleware pipeline for provider API calls (Helicone Tower-inspired). Wraps core streaming functions with onion-style layers: latency → retry → rateLimit → circuitBreaker → telemetry → headerCapture → usageTracking. Exports `createStreamingPipeline(provider, coreFn)`, `PeakEWMA` class (exponentially weighted moving average for latency tracking), `getProviderEWMA(provider)`, `getLatencyEstimates()`, individual middleware functions, `compose()`, `DEFAULT_LAYERS`. Used by `hydra-openai.mjs`, `hydra-anthropic.mjs`, `hydra-google.mjs`.
- **`hydra-telemetry.mjs`** — OTel GenAI tracing wrapper. Optional peer dependency — no-op when `@opentelemetry/api` is not installed. Lazy-loads OTel via dynamic `import()`. Exports `startAgentSpan(agent, model, opts)`, `endAgentSpan(span, result)`, `startProviderSpan(provider, model, opts)`, `endProviderSpan(span, usage, latencyMs)`, `startPipelineSpan(name, attrs)`, `endPipelineSpan(span, opts)`, `getTracer()`, `isTracingEnabled()`. Standard attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.agent.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`. Config: `telemetry.enabled` (default: true, auto-detected).

## Commit Attribution

Automated pipelines (evolve, nightly, tasks) add git trailers to commits for provenance:
```
Originated-By: hydra-evolve
Executed-By: codex
```
- `buildSafetyPrompt()` accepts `attribution: { pipeline, agent }` to instruct agents to include trailers
- `stageAndCommit()` accepts `opts.originatedBy` and `opts.executedBy` to append trailers programmatically

## Dispatch Modes

1. **Auto** — Classifies prompt locally → 3-way routing: single (fast-path), tandem (2-agent pair), or council (full deliberation). Zero agent CLI calls for classification.
2. **Council** — Full multi-round deliberation across agents with structured synthesis. Council gate warns when prompt is too simple for council.
3. **Dispatch** — Sequential pipeline: Claude → Gemini → Codex
4. **Smart** — Auto-selects model tier (economy/balanced/performance) per prompt
5. **Chat** — Concierge conversational layer, escalates with `!` prefix or `[DISPATCH]` intent

## Route Strategies

Auto mode uses `classifyPrompt()` to determine `routeStrategy`:
- **`single`** — Simple prompts: 1 task, 1 handoff, 0 agent CLI calls (fast-path dispatch)
- **`tandem`** — Moderate prompts: 2 tasks + 2 handoffs (lead→follow pair), 0 agent CLI calls. Task-type matrix selects optimal pair (e.g., planning: claude→codex, review: gemini→claude). Tandem indicators (`first...then`, `review and fix`) can upgrade simple prompts to tandem.
- **`council`** — Complex prompts (complexScore >= 0.6): full council deliberation, skips mini-round triage (saves 4 agent calls)

Legacy mini-round triage available via `routing.useLegacyTriage: true` config. Council gate (`routing.councilGate: true`, default) shows `promptChoice()` when council mode is overkill, offering the efficient route instead.

## Task Routing

10 task types (planning, architecture, review, refactor, implementation, analysis, testing, security, research, documentation) × 3 physical agents + 6 virtual sub-agents with affinity scores. `classifyTask()` in hydra-agents.mjs selects the optimal agent. Virtual sub-agents (e.g. `security-reviewer`) resolve to their base physical agent for CLI dispatch via `resolvePhysicalAgent()`. `selectTandemPair()` in hydra-utils.mjs maps task types to optimal lead→follow agent pairs, respecting agent filters.

## Module Dependency Graph

```
hydra-config.mjs ──────────────────────────────┐
       │                                        │
       v                                        v
hydra-agents.mjs ──> hydra-metrics.mjs    hydra-usage.mjs
       │                    │                   │
       v                    v                   │
hydra-utils.mjs <───────────┘                   │
       │                                        │
       ├──────────┬──────────┐                  │
       v          v          v                  │
hydra-dispatch  hydra-council  hydra-operator <─┘
       │          │          │
       v          v          v
hydra-context.mjs   hydra-ui.mjs
                         │
                         v
                    picocolors

orchestrator-daemon.mjs ──> hydra-agents, hydra-ui, hydra-config,
                            hydra-metrics, hydra-usage, hydra-verification,
                            hydra-worktree, hydra-mcp
       │
       └──> daemon/read-routes.mjs + daemon/write-routes.mjs

hydra-concierge.mjs ──> hydra-config, hydra-agents,
       │                    hydra-concierge-providers
       └──> Multi-provider fallback (OpenAI → Anthropic → Google)

hydra-concierge-providers.mjs ──> hydra-config
       │
       ├──> hydra-openai.mjs (lazy)
       ├──> hydra-anthropic.mjs (lazy)
       └──> hydra-google.mjs (lazy)

hydra-anthropic.mjs ──> Anthropic Messages API (streaming)
hydra-google.mjs ──> Google Gemini Generative Language API (SSE streaming)

hydra-sub-agents.mjs ──> hydra-agents (registerAgent), hydra-config

hydra-mcp-server.mjs ──> HTTP daemon API (standalone stdio MCP server)

hydra-worktree.mjs ──> git CLI (child_process.execSync)

hydra-mcp.mjs ──> Codex MCP server (JSON-RPC over stdio)

orchestrator-client.mjs ──> hydra-utils, hydra-ui, hydra-agents,
                            hydra-usage
```

## Data Flow

### Prompt Dispatch (Auto Mode)

```
User prompt
     │
     v
[Operator] ──> classifyPrompt() ──> tier: simple | moderate | complex
     │
     ├── simple ──> fast-path delegation (bypass council entirely)
     │                   │
     │                   └── bestAgentFor(taskType) ──> single handoff
     │
     ├── moderate ──> mini-round triage (1 fast council round)
     │     │
     │     ├── recommendation=handoff ──> create daemon handoffs for each agent
     │     │                                    │
     │     │                              [Agent Heads] poll /next, pick up handoffs
     │     │
     │     └── recommendation=council ──> full council deliberation
     │
     └── complex ──> generateSpec() ──> anchoring spec document
                          │
                          v
                     full council deliberation (spec injected into every phase)
                          │
                     Claude (propose)
                          │
                     Gemini (critique)
                          │
                     Claude (refine)
                          │
                     Codex (implement)
                          │
                          v
     structured synthesis (criteria, challenged assumptions, reversible next step)
                          │
                     cross-model verification (optional)
                          │
                     publish tasks/decisions/handoffs
```

### Fast-Path Dispatch

Simple prompts bypass the council entirely for lower latency:

```
classifyPrompt(prompt) ──> tier: simple
     │
     v
publishFastPathDelegation(prompt, agents)
     │
     ├── bestAgentFor(taskType, filteredAgents) ──> recommended agent
     │
     └── create single handoff to recommended agent
           │
           v
     [Agent Head] picks up handoff via /next polling
```

Fast-path respects the `agents=` filter — if only specific agents are allowed, the best match within that set is chosen.

### Smart Mode

Smart mode (`smart`) auto-selects the model tier based on prompt complexity:

```
User prompt
     │
     v
classifyPrompt(prompt) ──> { tier: simple | moderate | complex }
     │
     v
SMART_TIER_MAP:
  simple   ──> economy tier   (fast/cheap models)
  medium   ──> balanced tier   (default + fast mix)
  complex  ──> performance tier (default/best models)
     │
     v
Temporarily override mode ──> run auto dispatch ──> restore original mode
```

### Concierge (Multi-Provider Conversational Front-End)

The concierge is a multi-provider conversational AI layer with automatic fallback (OpenAI → Anthropic → Google). It sits in front of the dispatch pipeline and is active by default (`autoActivate: true`).

```
User input at hydra⬢[gpt-5]> prompt
     │
     ├── starts with ':'?
     │     │
     │     ├── recognized command ──> execute directly (bypass concierge)
     │     │
     │     ├── fuzzy match (Levenshtein ≤ 2) ──> suggest correct command locally
     │     │
     │     └── unrecognized ──> concierge suggests the correct command
     │
     ├── starts with '!'?
     │     │
     │     └── strip prefix ──> bypass concierge ──> dispatch pipeline directly
     │
     └── normal text ──> conciergeTurn(userMsg, context)
               │
               ├── streamWithFallback() ──> try primary provider
               │     │
               │     ├── primary OK ──> stream response
               │     ├── primary fail ──> try next in fallback chain
               │     └── all fail ──> throw combined error
               │
               ├── response starts with [DISPATCH]?
               │     │
               │     ├── yes ──> extract cleaned prompt ──> dispatch pipeline
               │     │            post concierge:dispatch event to daemon
               │     │
               │     └── no  ──> chat response streamed to user in blue
               │                  display cost estimate [~$0.0042]
               │
               ├── API error?
               │     │
               │     ├── 401/403 ──> auto-disable concierge, revert to normal prompt
               │     └── other   ──> show error, keep concierge active
               │
               └── every 5 turns ──> post concierge:summary event to daemon
```

The concierge maintains an in-memory conversation history (capped at 40 messages). Its system prompt is rebuilt with context-hash invalidation (fingerprint changes OR TTL expiry) and includes: project name, mode, open tasks, agent models, git branch/status, recent completions, recent errors, and active workers. It includes a full command reference for typo correction.

**Provider fallback chain** (configurable via `concierge.fallbackChain`):
1. OpenAI (`gpt-5`) — primary
2. Anthropic (`claude-sonnet-4-5-20250929`) — first fallback
3. Google (`gemini-2.5-flash`) — last resort

Provider modules are lazy-loaded via `await import()` to avoid loading unused ones.

**Bidirectional communication**: The concierge posts events to the daemon via `POST /events/push`:
- `concierge:dispatch` — when escalating to dispatch pipeline (includes conversation context)
- `concierge:summary` — every 5 turns (turn count, topic, tokens used)
- `concierge:error` — on provider errors
- `concierge:model_switch` — when switching models at runtime

**Prompt shows active model**: `hydra⬢[gpt-5]>` or `hydra⬢[sonnet ↓]>` (↓ indicates fallback).

Modules: `lib/hydra-concierge.mjs`, `lib/hydra-concierge-providers.mjs`, `lib/hydra-anthropic.mjs`, `lib/hydra-google.mjs`.

### Ghost Text (Placeholder Prompts)

The operator console shows greyed-out placeholder text after the cursor, similar to Claude Code CLI:

```
hydra⬢[gpt-5]> Chat naturally — prefix ! to dispatch
         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
         dim ghost text, disappears on first keystroke
```

Implementation:
- `rl.prompt()` is wrapped to append dim ghost text via ANSI after each fresh prompt
- A one-shot `stdin` data listener fires `\x1b[K` (erase to EOL) on the first keystroke
- `rl.prompt(true)` (mid-typing refreshes) does NOT show ghost text
- Messages rotate from a contextual pool (concierge-aware vs normal hints)
- Ghost text cleanup listener is removed on `rl.close()`

### Agent Terminal Auto-Launch

On Windows, the operator console can auto-spawn terminal windows for each agent:

```
Operator init
     │
     v
findPowerShell() ──> pwsh or powershell
findWindowsTerminal() ──> wt.exe (optional)
     │
     v
For each agent (gemini, codex, claude):
     │
     ├── Windows Terminal available?
     │   ├── yes ──> wt.exe new-tab -p "PowerShell" -d <cwd> pwsh -EncodedCommand ...
     │   └── no  ──> Start-Process pwsh -EncodedCommand ...
     │
     └── Each terminal runs: hydra-head.ps1 -Agent <name> -Url <daemonUrl>
```

Agent heads poll the daemon and auto-claim handoffs and owned tasks (`claim_owned_task` action).

### Agent Filtering

When `agents=claude,gemini` is specified, only those agents participate:
- Fast-path: `suggestedAgent` falls back to best match within the filtered set
- Council: `COUNCIL_FLOW` phases filtered to only include allowed agents
- Handoffs: only created for agents in the filter

### Cross-Model Verification

```
Producer agent output
     │
     v
shouldCrossVerify(tier, config) ──> mode: always | on-complex | off
     │
     ├── skip ──> return output as-is
     │
     └── verify ──> getVerifier(producer) ──> paired verifier agent
                         │
                         v
                    modelCall(verifier, reviewPrompt)
                         │
                         v
                    { approved, issues[], suggestions[] }
                         │
                         ├── approved ──> return original output
                         └── issues ──> append verification notes to result
```

### Checkpoint Flow

```
Long-running task (council or multi-step)
     │
     ├── phase complete ──> POST /task/checkpoint
     │                         { taskId, name, context, agent }
     │                              │
     │                              v
     │                         task.checkpoints[] appended
     │
     └── failure/timeout ──> GET /task/:id/checkpoints
                                  │
                                  v
                             resume from last checkpoint context
```

### Session Fork/Spawn

```
Active session
     │
     ├── :fork ──> POST /session/fork
     │                 │
     │                 v
     │            Copy current state snapshot
     │            Create sibling session (type: 'fork', parentId: original)
     │
     └── :spawn focus="subtask" ──> POST /session/spawn
                                        │
                                        v
                                   Fresh session (type: 'spawn', parentId: original)
                                   Focus field anchors the child's scope
```

### Session Pause/Resume

```
:pause [reason]
     │
     v
POST /session/pause { reason }
     │
     └── activeSession.status = 'paused'
         activeSession.pauseReason = reason
         activeSession.pausedAt = ISO timestamp

:unpause
     │
     v
POST /session/resume
     │
     └── activeSession.status = 'active'
         clear pauseReason/pausedAt
```

The operator `:resume` command handles stale recovery: acks pending handoffs, resets stale tasks to `todo`, and optionally relaunches agent terminals.

### Agent Invocation

```
modelCall(agent, prompt, timeout)
     │
     ├── recordCallStart(agent, model)  [metrics]
     │
     ├── resolve model flags from config/env
     │
     ├── Windows? ──> pipe via stdin (8191 char limit workaround)
     │   │
     │   └── codex? ──> exec mode with output file
     │
     └── recordCallComplete/Error  [metrics]

modelCallAsync(agent, prompt, timeout, opts)
     │
     ├── agent === 'codex' && MCP enabled?
     │   │
     │   ├── yes ──> codexMCP(prompt, opts) ──> JSON-RPC over stdio
     │   │               │
     │   │               └── threadId? ──> multi-turn via codex-reply tool
     │   │
     │   └── no ──> fall back to modelCall() (CLI spawn)
     │
     └── other agents ──> modelCall() directly
```

### Model Resolution

```
Priority chain:
  1. HYDRA_CLAUDE_MODEL env var
  2. hydra.config.json models.claude.active (when override is not "default")
  3. hydra.config.json modeTiers[mode].claude preset
  4. hydra.config.json models.claude.default

Shorthand resolution:
  "sonnet" ──> MODEL_ALIASES.claude.sonnet ──> "claude-sonnet-4-5-20250929"
  "fast"   ──> config.models.claude.fast   ──> "claude-sonnet-4-5-20250929"
```

## Status Bar

The operator console renders a persistent 5-line status bar pinned to the terminal bottom using ANSI scroll regions:

```
initStatusBar(agents)
     │
     ├── Set scroll region: rows 1 through (rows - 5)
     │
     ├── Register agents ──> initialize agentState Map
     │
     └── Listen to metricsEmitter events:
              │
              ├── call:start  ──> setAgentActivity(agent, 'working', model)
              ├── call:complete ──> setAgentActivity(agent, 'idle')
              └── call:error  ──> setAgentActivity(agent, 'error', message)

Data sources (preferred order):
  1. SSE /events/stream ──> real-time daemon events (handoffs, claims, task updates)
  2. Fallback polling /next?agent=... ──> periodic daemon state checks
  3. metricsEmitter ──> local agent call lifecycle events
```

Agent activity metadata: `{ status, action, model, taskTitle, phase, step, updatedAt }`.

Context line displays: mode icon, open task count, dispatch context/last route, session cost, and today's token count.

Module: `lib/hydra-statusbar.mjs`.

## State Management

### Daemon Write Queue

All state mutations go through `enqueueMutation()`:

```
Request ──> enqueueMutation(label, mutator, detail)
                │
                v
           readState() ──> mutator(state) ──> writeState(state)
                │                                    │
                v                                    v
           appendSyncLog()                    appendEvent(type, detail)
                │                                    │
                v                                    v
           writeStatus()                   { id, seq, at, type, category, payload }
                                                     │
                                                     v
                                              broadcastEvent() ──> SSE clients
```

This ensures serialized writes even with concurrent HTTP requests. The write queue is **fault-tolerant** — a failed mutation does not poison subsequent ones. Each mutation's rejection is isolated while the queue continues processing.

### State File Structure

`AI_SYNC_STATE.json`:
- `activeSession` - Current coordination session
- `tasks[]` - Task queue with status, owner, blockedBy, claimToken, worktreePath, checkpoints[]
- `decisions[]` - Recorded decisions
- `blockers[]` - Active blockers
- `handoffs[]` - Agent handoffs (acknowledged or pending)
- `childSessions[]` - Forked/spawned child sessions with parentId, type, focus

### Auto-Behaviors

- **Auto-unblock**: When a task completes, blocked dependents move to `todo`
- **Cycle detection**: `blockedBy` mutations are checked for circular dependencies
- **Auto-archive**: When >20 completed tasks, move to archive file
- **Auto-verify**: Project-aware verification runs on task completion
  (configurable command or auto-detected by stack)

## Event System

NDJSON append-only log at `AI_ORCHESTRATOR_EVENTS.ndjson`:

```json
{"id":"...", "seq":1, "at":"ISO", "type":"mutation", "category":"task", "payload":{"label":"task:add ..."}}
{"id":"...", "seq":2, "at":"ISO", "type":"agent_call_start", "category":"system", "payload":{"agent":"claude"}}
{"id":"...", "seq":3, "at":"ISO", "type":"daemon_start", "category":"system", "payload":{"host":"127.0.0.1","port":4173}}
```

Each event has a **monotonic sequence number** (`seq`) and a **category** for filtered replay.

Event types:
- `daemon_start`, `daemon_stop`
- `mutation` (any state change)
- `auto_archive`
- `verification_start`, `verification_complete`
- `agent_call_start`, `agent_call_complete`, `agent_call_error`

Event categories (auto-classified from event type/label):
- `task` — task mutations (add, update, claim, checkpoint)
- `handoff` — handoff creation, acknowledgment
- `decision` — decision recording
- `blocker` — blocker creation/resolution
- `session` — session start, fork, spawn
- `concierge` — concierge dispatch, summary, error, model switch events
- `system` — daemon lifecycle, agent calls, archive, verification

### Event Replay

`GET /events/replay?from=N&category=X` returns all events since sequence number N, optionally filtered by category. On startup, `initEventSeq()` reads the last event from the NDJSON file to restore the sequence counter.

### Atomic Task Claiming

`POST /task/claim` returns a `claimToken` (UUID) on success. Subsequent `/task/update` calls can include the `claimToken` — if it doesn't match, the update is rejected (preventing stale updates from racing agents). Pass `force: true` to override claim validation for operator/human use.

## Context Tiers

Three context levels matched to agent capabilities:

| Tier | Agent | Contents |
|------|-------|----------|
| **Minimal** | Codex | Task files + types + signatures only |
| **Medium** | Claude | Summary + priorities + git rules (Claude reads more via tools) |
| **Large** | Gemini | Full context + recent git changes + TODO.md + task files |

Context is cached for 60 seconds to avoid redundant file reads.

## Agent Affinity System

Each agent has affinity scores (0-1) for 10 task types:

| Task Type | Gemini | Codex | Claude |
|-----------|--------|-------|--------|
| planning | 0.70 | 0.20 | 0.95 |
| architecture | 0.75 | 0.15 | 0.95 |
| review | 0.95 | 0.40 | 0.85 |
| refactor | 0.65 | 0.70 | 0.80 |
| implementation | 0.60 | 0.95 | 0.60 |
| analysis | 0.98 | 0.30 | 0.75 |
| testing | 0.65 | 0.85 | 0.50 |
| research | 0.90 | 0.25 | 0.70 |
| documentation | 0.50 | 0.40 | 0.80 |
| security | 0.85 | 0.35 | 0.70 |

Task type is auto-classified from title/description via regex patterns. The `POST /task/route` endpoint uses these scores to recommend the best agent.

## Usage Monitoring

```
~/.claude/stats-cache.json
     │
     v
findStatsCache() ──> parseStatsCache()
     │
     v
checkUsage() ──> { level, percent, todayTokens, ... }
     │
     ├── normal ──> no action
     ├── warning ──> one-line alert
     └── critical ──> auto-switch model + contingency menu
```

Contingency options:
1. Switch to fast/cheap model
2. Hand off to Gemini
3. Hand off to Codex
4. Save progress and pause

## Metrics Collection

```
modelCall() ──> recordCallStart(agent, model) ──> handle
     │
     ├── success ──> recordCallComplete(handle, result)
     └── error ──> recordCallError(handle, error)
     │
     v
metricsStore.agents[name] = {
  callsTotal, callsToday, callsSuccess, callsFailed,
  estimatedTokensToday, totalDurationMs, avgDurationMs,
  lastCallAt, lastModel, history[last 20]
}
     │
     v
persistMetrics() ──> hydra-metrics.json (every 30s + on shutdown)
```

Token estimation: ~0.25 tokens per output character (rough heuristic).

## Git Worktree Isolation

When `worktrees.enabled=true` in config, tasks can be assigned isolated git worktrees:

```
POST /task/add { ..., worktree: true }
     │
     v
createWorktree(taskId, baseBranch)
     │
     ├── git worktree add .hydra/worktrees/<taskId> -b hydra/<taskId>
     │
     └── store worktreePath on task record
            │
            v
     modelCall(..., { cwd: worktreePath })  ──> agent works in isolation
            │
            v
     task complete ──> autoCleanup?
            │
            ├── yes ──> removeWorktree(taskId)
            └── no  ──> worktree persists for manual merge
```

Module: `lib/hydra-worktree.mjs` — exports `createWorktree()`, `removeWorktree()`, `getWorktreePath()`, `listWorktrees()`, `mergeWorktree()`, `isWorktreeEnabled()`.

## Codex MCP Integration

When `mcp.codex.enabled=true`, Codex calls use a persistent MCP server process instead of one-shot CLI spawns:

```
modelCallAsync('codex', prompt, timeout, opts)
     │
     v
getCodexMCPClient() ──> lazy init MCPClient
     │
     ├── MCPClient.start() ──> spawn 'codex mcp-server' subprocess
     │       │
     │       └── JSON-RPC over stdin/stdout
     │
     ├── codexMCP(prompt) ──> callTool('codex', { prompt })
     │       │
     │       └── threadId? ──> callTool('codex-reply', { thread_id, message })
     │
     └── idle timeout (300s) ──> auto-close; re-opened on next call
```

Module: `lib/hydra-mcp.mjs` — exports `MCPClient`, `getCodexMCPClient()`, `codexMCP()`, `closeCodexMCP()`.

## Hydra MCP Server

Hydra can be exposed as an MCP server so that AI agents can self-coordinate:

```
Agent (Gemini/Codex/Claude)
     │
     └── MCP tool call (JSON-RPC over stdio)
              │
              v
         hydra-mcp-server.mjs
              │
              └── HTTP request to daemon API
                       │
                       v
                  orchestrator-daemon.mjs
```

8 exposed MCP tools:
- `hydra_tasks_list` — list open tasks with filters
- `hydra_tasks_claim` — claim a task atomically
- `hydra_tasks_update` — update task status/notes
- `hydra_tasks_checkpoint` — save checkpoint
- `hydra_handoffs_pending` — get pending handoffs for an agent
- `hydra_handoffs_ack` — acknowledge a handoff
- `hydra_council_request` — request council deliberation
- `hydra_status` — get daemon health summary

Module: `lib/hydra-mcp-server.mjs` — run with `node lib/hydra-mcp-server.mjs`.
