# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Desktop GUI with CS / EN / DE UI strings
- Council flow Claude → Opus (same `claude` CLI) → Codex
- Agent diagnostics that only check CLI presence on PATH (auth method ignored)
- Setup helpers for default model slots in `hydra.config.json`

### Changed

- Documentation clarifies that Hydra orchestrates existing CLIs and does not install them
- README / INSTALL / SECURITY written for a public GitHub first release (English)
- Agent instruction sync: `GEMINI.md` / `@gemini` replaced by `OPUS.md` / `@opus`
- Removed household-only house rules from published agent markdown
- Agent Forge analyze/critique phases use Opus instead of Gemini CLI
- README / USAGE / ARCHITECTURE Council and dispatch docs match Claude → Opus → Codex

## [1.2.0]

- Baseline multi-agent orchestrator (daemon, operator, workers, MCP, pipelines)
