// bin/release.sh: preconditions and the archive build (--dry-run), in a throw-away git
// repository with a minimal package.json, so that `npm test` there does not recurse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'release.sh');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function makeRepo(version = '1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'skopos-release-'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync(script, join(dir, 'bin', 'release.sh'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version, scripts: { test: 'true' } }, null, 2));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function run(dir, ...args) {
  return spawnSync('bash', [join(dir, 'bin', 'release.sh'), ...args], { encoding: 'utf8' });
}

test('dry run builds and verifies the archive', () => {
  const dir = makeRepo();
  try {
    const r = run(dir, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run ok: v1\.2\.3\.tar\.gz/);
    assert.equal(git(dir, 'tag').trim(), '', 'a dry run must not create a tag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a dirty working tree', () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'stray.txt'), 'x');
    const r = run(dir, '--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses an existing tag', () => {
  const dir = makeRepo();
  try {
    git(dir, 'tag', 'v1.2.3');
    const r = run(dir, '--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a version that is not x.y.z', () => {
  const dir = makeRepo('0.2');
  try {
    const r = run(dir, '--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not x\.y\.z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real run without GH_TOKEN stops before any tag or push', () => {
  const dir = makeRepo();
  try {
    const r = spawnSync('bash', [join(dir, 'bin', 'release.sh')], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /GH_TOKEN|gh not found/);
    assert.equal(git(dir, 'tag').trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
