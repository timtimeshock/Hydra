# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Desktop GUI with CS / EN / DE UI strings
- Council flow Claude → Grok (Cursor CLI) → Codex
- Agent diagnostics that only check CLI presence on PATH (auth method ignored)
- Setup helpers for default model slots in `hydra.config.json`

### Changed

- Dropped the leftover Gemini model preset. Active presets are Claude, Grok (`opus`), and Codex
- Council critique (`opus`) uses the Cursor CLI `agent` with `grok-4.7-high` in ask mode, replacing Claude Haiku 4.5
- GUI council log shows short phase lines named Grok and skips the raw JSON report
- After Council finishes, the hint says it finished and the decision is readable text, not a cut-off JSON dump
- Critique waits while another Cursor `agent` is running, then takes its turn
- Critique writes its CLI config under `%LOCALAPPDATA%\\Hydra\\cursor-cli` so it does not lock the IDE `cli-config.json`
- Critique prompt names Grok. The routing id remains `opus`
- Council critique stays on `grok-4.7-high`. High Fast was not kept
- Critique must not use a model below Claude Sonnet 4.6
- Documentation clarifies that Hydra orchestrates existing CLIs and does not install them
- README / INSTALL / SECURITY written for a public GitHub first release (English)
- Agent instruction sync: `GEMINI.md` / `@gemini` replaced by `OPUS.md` / `@opus`
- Removed household-only house rules from published agent markdown
- Agent Forge analyze/critique phases use Opus instead of Gemini CLI
- README / USAGE / ARCHITECTURE Council and dispatch docs match Claude → Opus → Codex

## [1.2.0]

- Baseline multi-agent orchestrator (daemon, operator, workers, MCP, pipelines)
