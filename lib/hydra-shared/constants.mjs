/**
 * Shared Constants — Protected files, patterns, and blocked commands
 * used by both nightly and evolve guardrails.
 *
 * Each pipeline adds its own extras on top of these base sets.
 */

/** Base set of files that autonomous agents must NEVER modify. */
export const BASE_PROTECTED_FILES = new Set([
  'HYDRA.md',
  'CLAUDE.md',
  'GEMINI.md',
  'AGENTS.md',
  'TODO.md',
  'package.json',
  'package-lock.json',
  'app.json',
  'nightly-queue.md',
  'docs/sessions/CHANGELOG_2026.md',
  'docs/TODO.md',
]);

/** Path patterns that autonomous agents must not touch. */
export const BASE_PROTECTED_PATTERNS = [
  /^\.github\//,
  /^\.env/,
  /^supabase\/migrations\//,
  /^scripts\/release/,
];

/** Shell commands that autonomous agents must never execute. */
export const BLOCKED_COMMANDS = [
  'git push',
  'git checkout dev',
  'git checkout staging',
  'git checkout main',
  'git merge',
  'git rebase',
  'DROP TABLE',
  'TRUNCATE',
  'DELETE FROM',
  'rm -rf',
  'rm -r /',
  'npm publish',
  'eas build',
  'npx supabase db push',
  'npx supabase migration',
];
