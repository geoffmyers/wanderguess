import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * This game's public distribution does not include `*.tpl` files - that is
 * where the maintainer's own `op inject -i .env.tpl -o .env` password-manager
 * workflow lives (see `.env.tpl`). Every OTHER file ships as-is, including
 * every user-facing string. Audit finding (2026-09-17): several error
 * messages told players to run that private command on a file this
 * distribution does not include, instead of the README's own
 * `cp .env.example .env`. This test walks the repository the same way it is
 * packaged - everything except `*.tpl` and VCS/build/cache directories - and
 * fails if any surviving file still mentions the private workflow.
 */

const REPO_ROOT = path.resolve(__dirname, '../../');
// This file itself has to name the banned strings to describe and test the
// rule, so it is not a candidate for the scan below.
const SELF = path.resolve(__filename);

// `*.tpl` files are never part of the distribution, plus directories that
// are never shipped because they are VCS metadata, build output or local
// caches.
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'out',
  '.wrangler',
  '.viewer-verify',
  'coverage',
]);

const BANNED_SUBSTRINGS = ['.env.tpl', 'op inject'];

function collectPublishedFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectPublishedFiles(full, acc);
      continue;
    }
    if (entry.endsWith('.tpl')) continue; // excluded from publishing
    acc.push(full);
  }
  return acc;
}

// Extensions worth reading as text. Binary/generated assets (images, fonts,
// lockfiles are text but huge and irrelevant) are skipped for speed; nothing
// under those extensions can carry a private-workflow string a player or
// reader would see anyway.
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.md',
  '.json',
  '.css',
  '.yml',
  '.yaml',
  '.toml',
]);

describe('published files do not mention the private 1Password workflow', () => {
  const files = collectPublishedFiles(REPO_ROOT).filter(
    (f) => TEXT_EXTENSIONS.has(path.extname(f)) && path.resolve(f) !== SELF
  );

  // Guard the guard: if this list is ever empty the test below passes
  // vacuously and silently stops checking anything.
  it('found a non-trivial number of published text files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    it(`${rel} does not mention .env.tpl or op inject`, () => {
      const content = readFileSync(file, 'utf-8');
      for (const banned of BANNED_SUBSTRINGS) {
        expect(
          content.includes(banned),
          `${rel} contains "${banned}", a private 1Password workflow reference ` +
            `that does not apply to the published repo (use "cp .env.example .env")`
        ).toBe(false);
      }
    });
  }
});
