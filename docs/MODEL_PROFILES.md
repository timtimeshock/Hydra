# Hydra Model Profiles & Benchmark Reference

> Last updated: March 6, 2026
> Purpose: Inform default model assignments, roster recommendations, and smart-mode routing across all Hydra positions.

---

## Table of Contents

1. [Provider Profiles](#1-provider-profiles)
   - [Anthropic (Claude)](#anthropic-claude)
   - [OpenAI (Codex)](#openai-codex)
   - [Google (Gemini)](#google-gemini)
2. [Head-to-Head Benchmark Tables](#2-head-to-head-benchmark-tables)
3. [Hydra Position Mapping](#3-hydra-position-mapping)
4. [Recommended Defaults](#4-recommended-defaults)
5. [Model Selection Guide](#5-model-selection-guide)
6. [Pricing Reference](#6-pricing-reference)

---

## 1. Provider Profiles

### Anthropic (Claude)

#### Claude Opus 4.6

| Attribute | Value |
|---|---|
| **Model ID** | `claude-opus-4-6` |
| **Released** | February 5, 2026 |
| **Context** | 200K (1M beta) |
| **Max Output** | 128K tokens |
| **Pricing** | $5 / $25 per 1M (in/out) |
| **Speed** | ~66 tok/s (API), ~79 tok/s (Bedrock) |
| **TTFT** | ~1.52s |
| **Thinking** | Adaptive (`effort`: low/medium/high/max) |

**Key Benchmarks:**

| Benchmark | Score | Rank |
|---|---|---|
| SWE-bench Verified | **80.8%** | #1 (tied) |
| HumanEval | **97.6%** | #1 |
| Terminal-Bench 2.0 | 65.4% | #2 |
| GPQA Diamond | 91.3% | #2 |
| ARC-AGI-2 | **68.8%** | #1 (1.8x runner-up) |
| BrowseComp | **84.0%** | #1 |
| OSWorld | **72.7%** | #1 |
| TAU2-bench Retail | **91.9%** | #1 |
| TAU2-bench Telecom | 98.2% (4.5) | #1 |
| Humanity's Last Exam | **40.0%** | #1 |
| LiveCodeBench | 76% | -- |
| MMLU | 91% | -- |
| AIME 2025 | **100%** | Tied #1 |
| Long-Context Retrieval | **76%** | #1 (vs 18.5% predecessor) |
| Chatbot Arena Coding | **~1,510 ELO** | #1 (4.5 data) |

**Strengths:**
- Best abstract reasoning (ARC-AGI-2 nearly 2x competition)
- Best agentic tool use (TAU2-bench, BrowseComp, OSWorld)
- Best code generation quality (SWE-bench, HumanEval, Arena Coding)
- Largest output capacity (128K) for whole-file generation
- 1M context beta for whole-codebase analysis
- Adaptive thinking auto-scales reasoning to complexity
- Agent Teams for multi-agent orchestration (experimental)
- Best long-context retrieval (76% vs 18.5% predecessor)

**Weaknesses:**
- Moderate latency (slowest flagship)
- Expensive ($5/$25 per 1M)
- Cascading calculation errors on multi-step math
- Spatial reasoning gaps
- Multi-constraint instruction following can degrade under overload
- Prefilling removed (must use structured outputs)

**Best For:** Architecture, planning, code review, complex reasoning, agentic tasks, long-context analysis.

---

#### Claude Sonnet 4.6

| Attribute | Value |
|---|---|
| **Model ID** | `claude-sonnet-4-6` |
| **Released** | February 2026 |
| **Context** | 200K (1M beta) |
| **Max Output** | 64K tokens |
| **Pricing** | $3 / $15 per 1M (in/out) |
| **Speed** | ~82 tok/s |
| **TTFT** | ~1.50s |
| **Thinking** | Adaptive (same generation as Opus 4.6) |

**Key Benchmarks (estimates):**

| Benchmark | Score |
|---|---|
| SWE-bench Verified | ~79.2% |
| GPQA Diamond | ~87.4% |
| LiveCodeBench | ~72% |

**Strengths:**
- Same generation as Opus 4.6 with adaptive thinking
- Strong coding at 40% lower cost than Opus
- Good balance of speed and quality for agentic tasks
- 1M context (beta)

**Weaknesses:**
- Lower max output than Opus (64K vs 128K)
- Not for highest-complexity abstract reasoning (use Opus 4.6)

**Best For:** General agentic coding, balanced workloads, architect/implementer role, cost-conscious pipelines.

---

#### Claude Sonnet 4.5

| Attribute | Value |
|---|---|
| **Model ID** | `claude-sonnet-4-5-20250929` |
| **Released** | September 29, 2025 |
| **Context** | 200K (1M beta) |
| **Max Output** | 64K tokens |
| **Pricing** | $3 / $15 per 1M (in/out) |
| **Speed** | ~63-72 tok/s |
| **TTFT** | ~1.80s |
| **Thinking** | Extended (budget_tokens) |

**Key Benchmarks:**

| Benchmark | Score |
|---|---|
| SWE-bench Verified | 77.2% (82% w/ parallel compute) |
| HumanEval | 94% |
| GPQA Diamond | 83.4% |
| Terminal-Bench | 50-51% |
| OSWorld | 61.4% |
| LiveCodeBench | 68% |
| Aider Polyglot | 78.8% |
| MMLU | 89% |

**Strengths:**
- Best price/performance in Anthropic lineup
- Strong coding at 40% lower cost than Opus
- 1M context (beta)
- Good balance of speed and quality
- Extended thinking for correctness-critical tasks

**Weaknesses:**
- Extended thinking adds ~157s mean latency
- No adaptive thinking (Opus 4.6 only)
- Physics/simulation reasoning gaps
- Thinking tokens billed at output rate

**Best For:** General coding, balanced workloads, cost-conscious complex tasks, concierge fallback.

---

#### Claude Haiku 4.5

| Attribute | Value |
|---|---|
| **Model ID** | `claude-haiku-4-5-20251001` |
| **Released** | October 15, 2025 |
| **Context** | 200K |
| **Max Output** | 64K tokens |
| **Pricing** | $1 / $5 per 1M (in/out) |
| **Speed** | ~108-200+ tok/s |
| **TTFT** | ~0.50s |
| **Thinking** | Extended (budget_tokens) |

**Key Benchmarks:**

| Benchmark | Score |
|---|---|
| SWE-bench Verified | 73.3% |
| Terminal-Bench | 41.0% |
| OSWorld | 50.7% |

**Strengths:**
- Blazing fast (lowest latency of any Claude)
- Near-Sonnet-4 coding at 1/3 the cost
- SWE-bench 73.3% exceeds earlier Sonnet 4
- Extended thinking available
- Ideal for high-volume and multi-agent pipelines

**Weaknesses:**
- No 1M context (200K only)
- No adaptive thinking
- Weaker on complex reasoning benchmarks
- Not for hardest tasks

**Best For:** Economy tier, high-volume processing, worker agents, real-time chat, budget coding.

---

### OpenAI (Codex)

#### GPT-5.3-Codex

| Attribute | Value |
|---|---|
| **Model ID** | `gpt-5.2-codex` |
| **Released** | February 5, 2026 |
| **Context** | 400K (272K in + 128K out) |
| **Max Output** | 128K tokens |
| **Pricing** | ~$1.75 / ~$14 per 1M (est.) |
| **Speed** | **~339 tok/s** (high effort) |
| **Reasoning** | `low`, `medium`, `high`, `xhigh` |

**Key Benchmarks:**

| Benchmark | Score | Rank |
|---|---|---|
| Terminal-Bench 2.0 | **77.3%** | #1 |
| SWE-bench Pro (Public) | **56.8%** | #1 |
| SWE-Lancer IC Diamond | **81.4%** | #1 |
| OSWorld-Verified | 64.7% | #2 |
| GDPval | 70.9% | -- |

**Strengths:**
- Fastest flagship model (339 tok/s, 25% faster than predecessor)
- Best terminal/agentic coding (Terminal-Bench 77.3% SOTA)
- Achieves results with fewer tokens than any prior model
- 128K output capacity
- Codex CLI with OS-enforced sandbox
- JSONL output for CI/automation
- Self-developing (first model instrumental in creating itself)

**Weaknesses:**
- API access still rolling out
- SWE-bench Pro improvement over 5.2-Codex is marginal
- Expensive output tokens
- Responses API only (no Chat Completions)
- No standard SWE-bench Verified score reported

**Best For:** Implementation, refactoring, agentic terminal tasks, file editing, headless workers.

---

#### GPT-5.4

| Attribute | Value |
|---|---|
| **Model ID** | `gpt-5.4` |
| **Released** | March 5, 2026 |
| **Context** | 1,050,000 tokens (1.05M) |
| **Max Output** | 128K tokens |
| **Pricing** | $2.50 / $15 per 1M (in/out) |
| **Speed** | ~78 tok/s (xhigh reasoning) |
| **Reasoning** | `none` (default), `low`, `medium`, `high`, `xhigh` |

**Key Benchmarks:**

| Benchmark | Score | Rank |
|---|---|---|
| SWE-bench Pro | **57.7%** | #1 |
| GPQA Diamond | 84.2% | -- |
| AIME 2025 | **100%** | Tied #1 |
| MMLU | 91% | -- |

**Strengths:**
- Largest context of any OpenAI model (1.05M tokens)
- Best SWE-bench Pro score (57.7%)
- Full reasoning control with 5 effort levels including `none` for speed
- General-purpose flagship (not CLI-specific like 5.3-Codex)
- Strong computer use and code generation capabilities
- 128K output capacity

**Weaknesses:**
- Slower than GPT-5.3-Codex (78 tok/s vs 424 tok/s)
- More expensive than 5.3-Codex ($2.50/$15 vs $1.75/$14)
- Reasoning default is `none` (must set explicitly for deep reasoning)

**Best For:** Implementation, refactoring, long-context analysis, computer use, agentic tasks.

---

#### GPT-5.2

| Attribute | Value |
|---|---|
| **Model ID** | `gpt-5.2` |
| **Released** | December 11, 2025 |
| **Context** | 400K (272K in + 128K out) |
| **Pricing** | $1.75 / $14 per 1M (in/out) |
| **Speed** | ~50 tok/s |
| **Reasoning** | `none`, `low`, `medium`, `high`, `xhigh` |

**Key Benchmarks:**

| Benchmark | Score | Rank |
|---|---|---|
| SWE-bench Verified (Thinking) | 80.0% | #2 |
| GPQA Diamond (Pro) | **93.2%** | #1 |
| AIME 2025 (no tools) | **100%** | Tied #1 |
| FrontierMath T1-3 | **40.3%** | #1 (SOTA) |
| ARC-AGI-2 (Pro) | 54.2% | #2 |
| MMMU Pro | **86.5%** | #1 |
| MRCR 4-needle (256K) | ~100% | #1 |

**Strengths:**
- Best science/math reasoning (GPQA, FrontierMath, AIME)
- Excellent long-context (near-perfect 256K needle retrieval)
- `xhigh` reasoning effort for maximum depth
- Concise reasoning summaries
- Context compaction for long-running agents

**Weaknesses:**
- 40% more expensive output than GPT-5/5.1
- Instant mode shows regressions in some categories
- SimpleBench ranked only 9th
- Still hallucinates on legal/medical content

**Best For:** Investigator, deep analysis, math/science reasoning, failure diagnosis.

---

#### GPT-5

| Attribute | Value |
|---|---|
| **Model ID** | `gpt-5` |
| **Released** | August 7, 2025 |
| **Context** | 400K (272K in + 128K out) |
| **Pricing** | $1.25 / $10 per 1M (in/out) |
| **Speed** | ~50+ tok/s |
| **Reasoning** | `minimal`, `low`, `medium` (default), `high` |

**Key Benchmarks:**

| Benchmark | Score |
|---|---|
| SWE-bench Verified | 74.9% |
| Aider Polyglot | 88% |
| GPQA (no tools) | 88.4% (Pro) |
| AIME 2025 (no tools) | 94.6% |
| TAU2-bench Telecom | 96.7% |

**Strengths:**
- Unified reasoning model (replaces o-series + GPT-series split)
- Strong coding + tool calling + math in one model
- `minimal` effort provides o3-level speed at better quality
- Front-end coding beats o3 ~70% of the time
- Good streaming speed for chat UX

**Weaknesses:**
- Superseded by 5.2 for deep reasoning
- Higher latency than GPT-4.1 for simple tasks
- Some tasks don't benefit from reasoning overhead

**Best For:** Concierge, general chat, broad-spectrum tasks, streaming.

---

#### o4-mini

| Attribute | Value |
|---|---|
| **Model ID** | `o4-mini` |
| **Released** | April 16, 2025 |
| **Context** | 200K (input) / 100K (output) |
| **Pricing** | $1.10 / $4.40 per 1M (in/out) |
| **Speed** | High throughput |
| **Reasoning** | `low`, `medium`, `high` |

**Key Benchmarks:**

| Benchmark | Score |
|---|---|
| SWE-bench Verified | 68.1% |
| AIME 2025 (no tools) | **92.7%** |
| AIME 2025 (w/ tools) | **99.5%** |
| Codeforces Elo | **2,719** |
| GPQA Diamond | 81.4% |

**Strengths:**
- Best math reasoning per dollar
- Outperforms o3 on AIME at o3-mini pricing
- Near-o3 coding at much lower cost
- High throughput for volume workloads
- Supports caching and batching

**Weaknesses:**
- Smaller context than GPT-5 family (200K vs 400K)
- Reasoning tokens hidden and billed as output
- Superseded by GPT-5 mini for many use cases

**Best For:** Budget reasoning, nightly handoff, math-heavy tasks, competitive programming.

---

#### GPT-4.1-mini

| Attribute | Value |
|---|---|
| **Model ID** | `gpt-4.1-mini` |
| **Released** | April 14, 2025 |
| **Context** | **1,000,000 tokens (1M)** |
| **Pricing** | $0.40 / $1.60 per 1M (in/out) |
| **Speed** | ~50% lower latency than GPT-4o |

**Strengths:**
- 1M context at rock-bottom pricing
- Beats GPT-4o on many benchmarks at 83% lower cost
- No reasoning token overhead (predictable costs)

**Weaknesses:**
- No reasoning mode
- Less capable than GPT-5 nano for reasoning tasks

**Best For:** Quick summaries, simple refactors, high-volume chat, long-document processing.

---

#### GPT-5 mini / nano

| Model | Input | Output | Context | Speed |
|---|---|---|---|---|
| **GPT-5 mini** | $0.25/1M | $2.00/1M | 400K | Fast |
| **GPT-5 nano** | $0.05/1M | $0.40/1M | 400K | Fastest |

- **GPT-5 mini**: Good reasoning at 5x cheaper than GPT-5. GPQA 82.8%.
- **GPT-5 nano**: Ultra-cheap. For classification, routing, simple extraction.

---

### Google (Gemini)

#### Gemini 3 Pro

| Attribute | Value |
|---|---|
| **Model ID** | `gemini-3-pro-preview` |
| **Released** | November 2025 |
| **Context** | **1M input** / 65K output |
| **Pricing** | $2 / $12 per 1M (in/out) |
| **Speed** | ~128-131 tok/s |
| **Thinking** | Always-on (`thinking_level`: LOW/HIGH) |

**Key Benchmarks:**

| Benchmark | Score | Rank |
|---|---|---|
| SWE-bench Verified | 76.2% | -- |
| LiveCodeBench v6 | **91.7%** | #1 |
| LiveCodeBench Elo | **2,439** | #1 (Grandmaster) |
| GPQA Diamond | 91.9% (93.8% DT) | #1 (Deep Think) |
| AIME 2025 | 95% (100% w/ tools) | -- |
| MMLU-Pro | **90.1%** | #1 |
| Aider Polyglot | 82.2% | -- |
| Terminal-Bench 2.0 | 54.2% | -- |
| Chatbot Arena Overall | **1,492 ELO** | #1 |

**Strengths:**
- Best competitive/algorithmic coding (Grandmaster Codeforces, LiveCodeBench #1)
- Best overall Arena ELO (1,492)
- Best science reasoning with Deep Think (GPQA 93.8%)
- 1M native context (production, not beta)
- Strong multimodal (video, image, audio, PDF)
- Deep Think mode for significant reasoning uplift

**Weaknesses:**
- **Hallucination**: 88% rate in some evaluations
- Inconsistent code quality (sometimes bloated)
- File editing issues ("old_string not found" errors in agent workflows)
- Slower than Claude Sonnet for coding tasks (10-15s responses)
- Instruction following can overreach (sweeping edits vs surgical)
- Preview instability

**Best For:** Analysis, code review, algorithmic problems, long-context review, competitive programming.

---

#### Gemini 3 Flash

| Attribute | Value |
|---|---|
| **Model ID** | `gemini-3-flash-preview` |
| **Released** | December 2025 |
| **Context** | **1M input** / 65K output |
| **Pricing** | **$0.50 / $3 per 1M** (cheapest frontier) |
| **Speed** | **~218 tok/s** |
| **Thinking** | Always-on (`thinking_level`: MINIMAL/LOW/MEDIUM/HIGH) |

**Key Benchmarks:**

| Benchmark | Score | Rank |
|---|---|---|
| SWE-bench Verified | **78%** | Beats Gemini 3 Pro! |
| Aider Polyglot | **95.2%** | Exceptional |
| GPQA Diamond | 90.4% | Near-flagship |
| MMMU Pro | 81.2% | -- |

**Strengths:**
- **Best value in AI**: 78% SWE-bench at $0.50/$3 pricing
- Actually beats Gemini 3 Pro on SWE-bench (78% vs 76.2%)
- Exceptional code editing (95.2% Aider Polyglot)
- Near-Pro reasoning at 75% lower cost
- 4-level thinking granularity (MINIMAL/LOW/MEDIUM/HIGH)
- 1M context window
- 3x faster than 2.5 Pro

**Weaknesses:**
- 91% hallucination rate in some evaluations (highest of all)
- Shallow reasoning on complex tasks
- Instruction following inferior to Pro
- Overconfidence on uncertain claims
- Long-context reliability lower than Pro (22.1% vs 26.3% at 1M)
- Preview instability

**Best For:** Economy tier, high-volume coding, fast triage, iterative development loops, agent workflows.

---

#### Gemini 2.5 Pro / Flash (Stable GA)

| Model | Input/1M | Output/1M | Context | Speed | Status |
|---|---|---|---|---|---|
| **2.5 Pro** | $1.25 | $10 | 1M | ~150 tok/s | Stable GA |
| **2.5 Flash** | $0.30 | $2.50 | 1M | ~237 tok/s | Stable GA |

- **2.5 Pro**: SWE-bench 63.8%, GPQA 84%, AIME 2024 92%. Stable but outperformed by 3.x.
- **2.5 Flash**: Fastest stable model with reasoning. Best for budget/high-volume workloads requiring GA stability.
- Both use `thinkingBudget` (NOT `thinking_level`). Different API from 3.x models.

---

## 2. Head-to-Head Benchmark Tables

### Coding Benchmarks (Flagship Models)

| Benchmark | Opus 4.6 | Sonnet 4.6 | GPT-5.3-Codex | GPT-5.2 | Gemini 3 Pro | Gemini 3 Flash |
|---|---|---|---|---|---|---|
| SWE-bench Verified | **80.8%** | ~79.2% | -- | 80.0% | 76.2% | 78.0% |
| SWE-bench Pro | -- | -- | **56.8%** | 55.6% | -- | -- |
| Terminal-Bench 2.0 | 65.4% | -- | **77.3%** | -- | 54.2% | -- |
| HumanEval | **97.6%** | -- | -- | -- | -- | -- |
| LiveCodeBench Elo | -- | -- | -- | -- | **2,439** | -- |
| LiveCodeBench v6 | -- | ~72% | -- | -- | **91.7%** | -- |
| Aider Polyglot | 89.4% (4.5) | -- | -- | -- | 82.2% | **95.2%** |
| Chatbot Arena Coding | **~1,510** | -- | -- | ~1,480 | ~1,470 | -- |

### Reasoning Benchmarks

| Benchmark | Opus 4.6 | GPT-5.2 | Gemini 3 Pro |
|---|---|---|---|
| GPQA Diamond | 91.3% | **93.2%** (Pro) | 91.9% (93.8% DT) |
| AIME 2025 (no tools) | **100%** | **100%** | 95% |
| ARC-AGI-2 | **68.8%** | 54.2% (Pro) | 45.1% (DT) |
| FrontierMath T1-3 | -- | **40.3%** | -- |
| Humanity's Last Exam | **40.0%** | -- | 37.5% |
| MMLU | 91% | -- | **91.8%** |
| MMLU-Pro | -- | -- | **90.1%** |
| MMMU Pro | 73.9% | **86.5%** | 81.2% |

### Agentic Benchmarks

| Benchmark | Opus 4.6 | GPT-5.3-Codex | GPT-5 |
|---|---|---|---|
| TAU2-bench Retail | **91.9%** | -- | -- |
| TAU2-bench Telecom | **98.2%** (4.5) | -- | 96.7% |
| OSWorld | **72.7%** | 64.7% | -- |
| BrowseComp | **84.0%** | -- | -- |
| SWE-Lancer IC Diamond | -- | **81.4%** | -- |
| Finance Agent | **60.7%** | -- | -- |

### Economy Tier Comparison

| Benchmark | Haiku 4.5 | o4-mini | Gemini 3 Flash |
|---|---|---|---|
| SWE-bench Verified | 73.3% | 68.1% | **78.0%** |
| GPQA Diamond | -- | 81.4% | **90.4%** |
| AIME 2025 | -- | **99.5%** | -- |
| Codeforces Elo | -- | **2,719** | -- |
| **Price (in/out per 1M)** | $1/$5 | $1.10/$4.40 | **$0.50/$3** |

---

## 3. Hydra Position Mapping

### Roles & Their Requirements

| Position | Current Default | Key Requirements | Primary Capability |
|---|---|---|---|
| **Architect** | Claude Opus 4.6 | Planning, decomposition, system design | Abstract reasoning, code quality |
| **Analyst** | Gemini 3 Pro | Review, critique, risk identification | Analytical depth, long context |
| **Implementer** | GPT-5.4 | Code generation, refactoring, execution | Long context, reasoning, code generation |
| **Concierge** | GPT-5 | Fast streaming chat, broad knowledge | Low latency, good enough quality |
| **Investigator** | GPT-5.2 | Failure diagnosis, root-cause analysis | Deep reasoning, code understanding |
| **Nightly Handoff** | o4-mini | Budget batch work, simple tasks | Cost efficiency, decent quality |

### Council Phases

| Phase | Current Agent | Model Selection Rationale |
|---|---|---|
| **Propose** | Claude (Opus 4.6) | Best at architectural thinking, ARC-AGI-2 #1 |
| **Critique** | Gemini (3 Pro) | Strong analysis, different perspective, GPQA near-#1 |
| **Refine** | Claude (Opus 4.6) | Synthesizes feedback into coherent plan |
| **Implement** | Codex (GPT-5.4) | SWE-bench Pro #1, 1.05M context |

### Forge Pipeline Phases

| Phase | Current Agent | Model Selection Rationale |
|---|---|---|
| **ANALYZE** | Gemini | Broad analysis, codebase scanning |
| **DESIGN** | Claude | Architectural design, spec creation |
| **CRITIQUE** | Gemini | Independent review, gap identification |
| **REFINE** | Claude | Integration of feedback, finalization |
| **TEST** | (any) | Validation |

### Evolve Pipeline

| Phase | Typical Agent | Model Selection Rationale |
|---|---|---|
| **RESEARCH** | Gemini | Codebase scanning, broad analysis |
| **DELIBERATE** | Council (all) | Multi-perspective evaluation |
| **PLAN** | Claude | Detailed implementation planning |
| **IMPLEMENT** | Codex | Fast code generation |
| **TEST** | Codex | Test execution, verification |
| **ANALYZE** | Gemini | Quality assessment, scoring |

### Smart Mode Tiers

| Tier | Prompt Complexity | Optimization Target |
|---|---|---|
| **Economy** | Simple (score < 0.3) | Minimize cost, maximize speed |
| **Balanced** | Medium (0.3-0.6) | Balance quality/cost/speed |
| **Performance** | Complex (>= 0.6) | Maximize quality |

---

## 4. Recommended Defaults

### Per-Agent Model Presets

#### Claude Agent

| Preset | Model | Rationale |
|---|---|---|
| **default** | `claude-sonnet-4-6` | Same generation as Opus 4.6, adaptive thinking, 40% cheaper |
| **fast** | `claude-sonnet-4-5-20250929` | Proven, SWE-bench 77.2%, extended thinking |
| **cheap** | `claude-haiku-4-5-20251001` | 5x cheaper, SWE-bench 73.3%, blazing fast |
| *performance* | `claude-opus-4-6` | Best reasoning, ARC-AGI-2 #1 — select via model picker |

#### Codex Agent

| Preset | Model | Rationale |
|---|---|---|
| **default** | `gpt-5.4` | SWE-bench Pro 57.7%, 1.05M context, 5-level reasoning |
| **fast** | `o4-mini` | $1.10/$4.40, SWE-bench 68.1%, great math |
| **cheap** | `o4-mini` | Same model, best budget reasoning |
| *alt-default* | `gpt-5.2` | When deep reasoning > speed (GPQA 93.2%) |

#### Gemini Agent

| Preset | Model | Rationale |
|---|---|---|
| **default** | `gemini-3-pro-preview` | Grandmaster coding, GPQA 91.9%, Arena #1 |
| **fast** | `gemini-3-flash-preview` | SWE-bench 78% at $0.50/$3 (!) |
| **cheap** | `gemini-3-flash-preview` | Same model — already cheapest frontier |
| *alt-cheap* | `gemini-2.5-flash` | GA stable, $0.30/$2.50, if preview instability is a concern |

### Role Assignments

| Role | Agent | Model | Reasoning | Rationale |
|---|---|---|---|---|
| **architect** | claude | `claude-sonnet-4-6` (default) | adaptive | Strong agentic coding at 40% lower cost; Opus available for highest-complexity |
| **analyst** | gemini | `gemini-3-pro-preview` | thinking_level: HIGH | Best Arena ELO, GPQA 91.9%, 1M context |
| **implementer** | codex | `gpt-5.4` | none | SWE-bench Pro 57.7%, 1.05M context |
| **concierge** | codex | `gpt-5` | low | Fast streaming, broad knowledge, $1.25/$10 |
| **investigator** | codex | `gpt-5.2` | xhigh | Best deep reasoning (GPQA 93.2%, FrontierMath 40.3%) |
| **nightlyHandoff** | codex | `o4-mini` | low | Budget-friendly, decent SWE-bench 68.1%, great math |

### Concierge Fallback Chain

| Priority | Provider | Model | Rationale |
|---|---|---|---|
| 1 | openai | `gpt-5` | Best streaming UX, broad knowledge |
| 2 | anthropic | `claude-sonnet-4-5-20250929` | Strong fallback, good coding |
| 3 | google | `gemini-3-flash-preview` | Cheapest, fast, good quality |

### Smart Mode Tier Mapping

| Tier | Claude | Codex | Gemini |
|---|---|---|---|
| **performance** | opus-4-6 | gpt-5.4 | gemini-3-pro-preview |
| **balanced** | sonnet-4-5 | o4-mini | gemini-3-flash-preview |
| **economy** | haiku-4-5 | o4-mini | gemini-3-flash-preview |

### Cross-Model Verification Pairings

| Agent | Verifier | Rationale |
|---|---|---|
| claude | gemini | Different provider perspective, strong GPQA |
| gemini | claude | Best code quality check (SWE-bench #1) |
| codex | claude | Architectural validation of implementations |

---

## 5. Model Selection Guide

### By Task Type

| Task Type | Best Model | Runner-Up | Budget Option |
|---|---|---|---|
| **Planning / Architecture** | Opus 4.6 | GPT-5.2 (xhigh) | Sonnet 4.5 |
| **Code Generation** | Opus 4.6 | GPT-5.3-Codex | Gemini 3 Flash |
| **Code Review / Analysis** | Opus 4.6 | Gemini 3 Pro | Sonnet 4.5 |
| **Refactoring / Editing** | GPT-5.3-Codex | Gemini 3 Flash (95.2% Aider) | o4-mini |
| **Implementation (bulk)** | GPT-5.3-Codex | Sonnet 4.5 | Haiku 4.5 |
| **Agentic / Terminal** | GPT-5.3-Codex | Opus 4.6 | o4-mini |
| **Competitive / Algorithmic** | Gemini 3 Pro | o4-mini (2,719 CF) | Gemini 3 Flash |
| **Math / Science** | GPT-5.2 (xhigh) | Opus 4.6 | o4-mini |
| **Long-Context Analysis** | Gemini 3 Pro (1M) | Opus 4.6 (1M beta) | Gemini 3 Flash (1M) |
| **Quick Triage** | Gemini 3 Flash | Haiku 4.5 | GPT-4.1-mini |
| **Failure Diagnosis** | GPT-5.2 (xhigh) | Opus 4.6 | GPT-5 |
| **Chat / Concierge** | GPT-5 (minimal) | Sonnet 4.5 | Gemini 3 Flash |
| **Documentation** | Sonnet 4.5 | Gemini 3 Pro | Haiku 4.5 |
| **Security Review** | Opus 4.6 | GPT-5.2 | Gemini 3 Pro |
| **Testing** | GPT-5.3-Codex | Sonnet 4.5 | Haiku 4.5 |

### By Optimization Priority

| Priority | Best Choice | Why |
|---|---|---|
| **Maximum Quality** | Claude Opus 4.6 | Highest SWE-bench, ARC-AGI, agentic benchmarks |
| **Maximum Speed** | GPT-5.3-Codex (339 tok/s) | Fastest flagship by a wide margin |
| **Maximum Value** | Gemini 3 Flash ($0.50/$3) | 78% SWE-bench at 1/10 Opus cost |
| **Maximum Reasoning** | GPT-5.2 (xhigh) | GPQA 93.2%, FrontierMath 40.3% |
| **Maximum Context** | Gemini 3 Pro/Flash (1M native) | Production-ready 1M tokens |
| **Maximum Budget** | Haiku 4.5 ($1/$5) or Gemini 3 Flash ($0.50/$3) | Both strong SWE-bench (73%/78%) |

---

## 6. Pricing Reference

### Flagship Models (per 1M tokens)

| Model | Input | Output | Effective $/quality |
|---|---|---|---|
| Claude Opus 4.6 | $5.00 | $25.00 | Premium |
| GPT-5.4 | $2.50 | $15.00 | Mid-high |
| GPT-5.3-Codex | ~$1.75 | ~$14.00 | Mid-high |
| GPT-5.2 | $1.75 | $14.00 | Mid-high |
| GPT-5 | $1.25 | $10.00 | Mid |
| Gemini 3 Pro | $2.00 | $12.00 | Mid |

### Economy Models (per 1M tokens)

| Model | Input | Output | SWE-bench |
|---|---|---|---|
| Gemini 3 Flash | **$0.50** | **$3.00** | **78.0%** |
| Claude Haiku 4.5 | $1.00 | $5.00 | 73.3% |
| o4-mini | $1.10 | $4.40 | 68.1% |
| GPT-5 mini | $0.25 | $2.00 | -- |
| GPT-4.1-mini | $0.40 | $1.60 | -- |
| GPT-5 nano | $0.05 | $0.40 | -- |

### Cost Multipliers

| Feature | Multiplier |
|---|---|
| Claude Batch API | 0.5x |
| Claude Prompt Cache reads | 0.1x input |
| Claude Fast Mode | 6x |
| OpenAI Cached Input | 0.1x input |
| OpenAI Batch API | 0.5x |
| Gemini Batch API | 0.5x |
| Gemini Cache reads | 0.1x input |
| Gemini >200K context | 2x (Gemini 3 Pro) |

### Speed Comparison

| Model | tok/s | TTFT | Notes |
|---|---|---|---|
| GPT-5.4 | ~78 | -- | Flagship general-purpose |
| GPT-5.3-Codex | **~339** | -- | Fastest flagship |
| Gemini 3 Flash | ~218 | <1s | Fastest economy |
| Claude Haiku 4.5 | ~108-200 | ~0.50s | Fastest Claude |
| Gemini 2.5 Flash | ~237 | ~0.30s | Fastest GA model |
| Gemini 3 Pro | ~128-131 | varies | -- |
| Claude Sonnet 4.5 | ~63-72 | ~1.80s | -- |
| Claude Opus 4.6 | ~66-79 | ~1.52s | -- |
| GPT-5 | ~50+ | <200ms | Good TTFT |
| GPT-5.2 | ~50 | -- | Deep reasoning mode |

---

## Notes

### API Differences to Remember

- **Gemini 3.x**: Uses `thinking_level` (LOW/HIGH for Pro; MINIMAL/LOW/MEDIUM/HIGH for Flash). Always-on thinking. Thought signatures must propagate across turns.
- **Gemini 2.5.x**: Uses `thinkingBudget` (0-24576 tokens). Can disable thinking with budget=0. Different API from 3.x.
- **Claude 4.6**: Uses adaptive thinking (`effort`: low/medium/high/max). `budget_tokens` deprecated.
- **Claude 4.5/Haiku 4.5**: Uses extended thinking with `budget_tokens`. No adaptive thinking.
- **OpenAI GPT-5.x**: Uses `reasoning_effort` (`minimal`/`low`/`medium`/`high` for GPT-5; adds `none`/`xhigh` for GPT-5.2 and GPT-5.4).
- **OpenAI o-series**: Uses `reasoning_effort` (`low`/`medium`/`high`).
- **Codex CLI**: GPT-5.3-Codex requires Responses API only (not Chat Completions).

### Hallucination Caution

All models hallucinate. Reported rates:
- Gemini 3 Flash: ~91% (highest)
- Gemini 3 Pro: ~88%
- Claude models: Lower rates but still present
- GPT-5.2: Improved but still hallucinates on legal/medical

Human review remains essential for all automated code changes.

### Context Window Summary

| Model | Native Context | Status |
|---|---|---|
| Gemini 3 Pro/Flash | **1M** | Production |
| GPT-4.1/4.1-mini/4.1-nano | **1M** | Production |
| Claude Opus 4.6 | 200K (**1M beta**) | Beta |
| Claude Sonnet 4.5 | 200K (**1M beta**) | Beta |
| GPT-5.4 | **1.05M** | Production |
| GPT-5/5.2/5.3-Codex | **400K** | Production |
| o3/o4-mini | 200K | Production |
| Claude Haiku 4.5 | 200K | Production |
