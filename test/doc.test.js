// Keeps doc/examples.md and doc/examples.de.md (the LLM/human-facing configuration
// cookbook, English and German) from silently going stale: every check registered in
// lib/checks/index.js must be named in both. This does not catch a stale parameter
// description, only a missing check — cheap, but better than prose that nobody
// re-reads before a release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from '../lib/checks/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['doc/examples.md', 'doc/examples.de.md']) {
  test(`${file} names every registered check`, () => {
    const doc = readFileSync(join(root, file), 'utf8');
    const missing = Object.keys(CHECKS).filter((name) => !doc.includes(`"check": "${name}"`));
    assert.equal(missing.length, 0, `checks missing from ${file}: ${missing.join(', ')}`);
  });
}
