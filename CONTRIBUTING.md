# Contributing to Hydra

Thanks for your interest in contributing! This guide covers the essentials.

## Getting Started

1. **Fork** the repo and clone your fork
2. **Branch** from `dev` (not `master`)
3. **Install** dependencies: `npm ci`
4. **Test** your changes: `npm test`
5. **Open a PR** targeting `dev`

## Branch Rules

- **`dev`** — working branch; all PRs target here
- **`master`** — stable releases only; merged from `dev` by maintainers

Never commit directly to `master`.

## Code Conventions

- **ESM only** — `import`/`export`, no CommonJS
- **No build step** — pure ESM, runs directly with Node.js 20+
- **Terminal colors** — use `picocolors` (`pc`), never chalk
- **Agent names** — always lowercase: `claude`, `gemini`, `codex`
- **Tests** — Node.js native `node:test` + `node:assert/strict`
- **Dependencies** — keep them minimal; check with maintainers before adding new ones

## Running Tests

```bash
npm test                              # all tests
node --test test/hydra-ui.test.mjs    # single file
```

## PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] Docs updated if you changed architecture, commands, or exports
- [ ] No secrets or personal paths in committed files
- [ ] Commits are focused and have clear messages

## Questions?

Open an issue or start a discussion — we're happy to help.
