// Leak check: every file that would be published is checked for private patterns — the
// tracked files (git ls-files) plus files not yet committed and not ignored.
// Two groups of patterns: built-in generic ones (below) and private ones from a file that is
// never published: SKOPOS_LEAK_PATTERNS, otherwise the git-ignored file `.leak-patterns` in
// the repository root (typically a symlink to a private location).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 2 * 1024 * 1024;

// Built-in patterns. Written as RegExp objects so that this source does not match itself.
export const BUILT_IN = [
  { name: 'private IPv4 (RFC 1918)', re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/ },
  { name: 'home path /home/<name>/', re: /\/home\/[a-z_][a-z0-9_-]*\// },
  { name: 'e-mail address', re: /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  { name: 'private key block', re: /-{5}BEGIN [A-Z ]*(?:PRIVATE|KEY)/ },
  { name: 'long key/token block', re: /(?<![A-Za-z0-9+/=_-])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=_-])/ },
];

// Only "#" followed by whitespace or end of line is a comment, so that a pattern like
// "#" plus digits (ticket numbers) stays possible.
export function parsePrivate(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#(?:\s|$)/.test(l))
    .map((l) => ({ name: `private pattern "${l}"`, text: l.toLowerCase() }));
}

export function loadPrivate(path) {
  if (!existsSync(path)) return null;
  return parsePrivate(readFileSync(path, 'utf8'));
}

export function scanText(fileName, content, builtIn, priv) {
  const hits = [];
  content.split('\n').forEach((line, i) => {
    for (const m of builtIn) {
      if (m.re.test(line)) hits.push(`${fileName}:${i + 1}  ${m.name}`);
    }
    const lower = line.toLowerCase();
    for (const m of priv) {
      if (lower.includes(m.text)) hits.push(`${fileName}:${i + 1}  ${m.name}`);
    }
  });
  return hits;
}

// Sibling projects may only be named in the README section "Related projects / Verwandte
// Projekte", so the references can be changed in one place once the publishing account is
// decided. Names are assembled so that this source does not match itself.
export const SIBLINGS = new RegExp(`\\b(?:${['ago', 'ra'].join('')}|${['for', 'ge'].join('')}|${['tal', 'os'].join('')})\\b`, 'i');
const RELATED_SECTION = /^##\s+(?:Related projects|Verwandte Projekte)\s*$/;
const README = /^README(?:\.[a-z]{2})?\.md$/;

export function scanSiblings(fileName, content) {
  const hits = [];
  const isReadme = README.test(fileName);
  let inSection = false;
  content.split('\n').forEach((line, i) => {
    if (/^##\s/.test(line)) inSection = isReadme && RELATED_SECTION.test(line);
    if (!inSection && SIBLINGS.test(line)) {
      hits.push(`${fileName}:${i + 1}  sibling project outside the README section "Related projects"`);
    }
  });
  return hits;
}

function publishedFiles() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const names = new Set([
    ...git('ls-files').split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ]);
  return [...names].filter(Boolean).filter((n) => {
    const p = join(root, n);
    return existsSync(p) && statSync(p).isFile() && statSync(p).size <= MAX_BYTES;
  });
}

const privatePath = process.env.SKOPOS_LEAK_PATTERNS ?? join(root, '.leak-patterns');

test('built-in patterns catch examples (negative test of the check itself)', () => {
  const ip = ['192', '168', '1', '10'].join('.');
  const home = ['', 'home', 'someone', 'x'].join('/');
  const mail = ['someone', 'company.de'].join('@');
  const block = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const token = 'aB3'.repeat(15);
  for (const probe of [ip, home, mail, block, token]) {
    assert.ok(scanText('probe', probe, BUILT_IN, []).length > 0, `not caught: ${probe}`);
  }
  const ok = ['someone', 'example.org'].join('@');
  assert.equal(scanText('probe', `${ok} 8.8.8.8 /var/lib/example/stats.db`, BUILT_IN, []).length, 0);
});

test('pattern file: only "# " is a comment, "#" plus digits is a pattern', () => {
  const ticket = ['#', '00'].join('');
  const patterns = parsePrivate(`# comment\n#\n${ticket}\n  vmname  \n\n`);
  assert.deepEqual(patterns.map((m) => m.text), [ticket, 'vmname']);
});

test('private patterns are found regardless of case', () => {
  const priv = [{ name: 'private pattern "vmname"', text: 'vmname' }];
  assert.equal(scanText('probe', 'runs on VMName', [], priv).length, 1);
});

test('sibling projects only in the README section (negative test of the check itself)', () => {
  const name = ['Ago', 'ra'].join('');
  const section = `# X\n\n## Related projects\n\n${name}\n`;
  assert.equal(scanSiblings('README.md', section).length, 0);
  assert.equal(scanSiblings('README.md', `## Quick start\n\n${name}\n`).length, 1);
  assert.equal(scanSiblings('README.md', `${section}\n## License\n\n${name}\n`).length, 1);
  assert.equal(scanSiblings('doc/concept.md', `## Related projects\n\n${name}\n`).length, 1);
  assert.equal(scanSiblings('README.md', 'forget it, agoraphobia').length, 0);
});

test('published files name sibling projects only in the README section', () => {
  const hits = [];
  for (const file of publishedFiles()) {
    hits.push(...scanSiblings(file, readFileSync(join(root, file), 'utf8')));
  }
  assert.equal(hits.length, 0, `references outside the allowed section:\n${hits.join('\n')}`);
});

test('no private information in published files', (t) => {
  const priv = loadPrivate(privatePath);
  if (priv === null) {
    t.diagnostic(`note: private pattern file missing (${privatePath}) — only the built-in patterns run.`);
  }
  const hits = [];
  for (const file of publishedFiles()) {
    hits.push(...scanText(file, readFileSync(join(root, file), 'utf8'), BUILT_IN, priv ?? []));
  }
  assert.equal(hits.length, 0, `private information in published files:\n${hits.join('\n')}`);
});
