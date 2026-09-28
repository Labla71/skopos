// Installer: runs bin/install.sh in staging mode (--destdir), which writes the same files as
// a real installation but creates no user and touches no systemd. Node versions are faked
// with a stub `node` in front of PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(root, 'bin/install.sh');
const example = join(root, 'config/example.json');

function install(args, { env = {}, input } = {}) {
  return spawnSync('bash', [installer, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'skopos-install-'));

// Every file below dir with mode and content hash, so two installations can be compared.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      const rel = relative(dir, p);
      if (s.isDirectory()) {
        out[`${rel}/`] = (s.mode & 0o777).toString(8);
        walk(p);
      } else {
        out[rel] = `${(s.mode & 0o777).toString(8)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}

// A directory with a stub `node` that reports the given version (or none at all).
function fakeNode(version) {
  const dir = tmp();
  if (version !== undefined) {
    writeFileSync(join(dir, 'node'), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(dir, 'node'), 0o755);
  }
  return dir;
}
const SYSTEM_PATH = '/usr/bin:/bin';

test('staging installs code, configuration, data directory and units', () => {
  const d = tmp();
  const r = install(['--destdir', d, '--config', example, '--version', 'abc1234']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(d, 'opt/skopos/bin/skopos.js')));
  assert.ok(existsSync(join(d, 'opt/skopos/lib/checks/index.js')));
  assert.equal(readFileSync(join(d, 'opt/skopos/VERSION'), 'utf8'), 'abc1234\n');
  assert.equal(statSync(join(d, 'opt/skopos/bin/skopos.js')).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(d, 'etc/skopos/config.json'), 'utf8'), readFileSync(example, 'utf8'));
  assert.equal(statSync(join(d, 'etc/skopos/config.json')).mode & 0o777, 0o640);
  assert.equal(statSync(join(d, 'var/lib/skopos')).mode & 0o777, 0o755);
  assert.equal(readdirSync(join(d, 'opt')).join(','), 'skopos', 'no staging leftovers next to /opt/skopos');
});

test('service unit: absolute node path, service user and hardening', () => {
  const d = tmp();
  assert.equal(install(['--destdir', d, '--config', example]).status, 0);
  const unit = readFileSync(join(d, 'etc/systemd/system/skopos.service'), 'utf8');
  assert.match(unit, /^ExecStart=\/\S*node --disable-warning=ExperimentalWarning \/opt\/skopos\/bin\/skopos\.js run$/m);
  assert.doesNotMatch(unit, /@NODE@|Template/);
  for (const line of [
    'Type=oneshot', 'User=skopos', 'UMask=0022', 'ProtectSystem=strict', 'ReadWritePaths=/var/lib/skopos',
    'ProtectHome=read-only', 'PrivateTmp=yes', 'NoNewPrivileges=yes',
    'ProtectKernelTunables=yes', 'ProtectControlGroups=yes', 'RestrictSUIDSGID=yes', 'PrivateDevices=yes',
    // no network (pull, not push) and a resource cap to spare the watched host
    'PrivateNetwork=yes', 'MemoryMax=200M', 'CPUQuota=50%',
  ]) {
    assert.match(unit, new RegExp(`^${line.replace(/[.*/]/g, '\\$&')}$`, 'm'), line);
  }
  assert.doesNotMatch(unit, /^(User|Group)=root$/m);
});

test('timer follows interval_minutes', () => {
  const cases = [[5, ['OnCalendar=*:0/5']], [7, ['OnBootSec=7min', 'OnUnitActiveSec=7min']], [60, ['OnBootSec=60min', 'OnUnitActiveSec=60min']]];
  for (const [minutes, expected] of cases) {
    const d = tmp();
    const config = join(d, 'c.json');
    writeFileSync(config, JSON.stringify({ interval_minutes: minutes, checks: [{ check: 'uptime', key: 'boot' }] }));
    const r = install(['--destdir', join(d, 'root'), '--config', config]);
    assert.equal(r.status, 0, r.stderr);
    const timer = readFileSync(join(d, 'root/etc/systemd/system/skopos.timer'), 'utf8');
    for (const line of expected) assert.match(timer, new RegExp(`^${line.replace(/[*/]/g, '\\$&')}$`, 'm'), `${minutes}: ${line}`);
    assert.doesNotMatch(timer, /@SCHEDULE@|Template/);
  }
});

test('idempotent: a second run leaves the same state and keeps the database', () => {
  const d = tmp();
  assert.equal(install(['--destdir', d, '--config', example, '--version', 'v1']).status, 0);
  writeFileSync(join(d, 'var/lib/skopos/skopos.db'), 'data');
  const first = snapshot(d);
  const r = install(['--destdir', d, '--config', example, '--version', 'v1']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(d), first);
});

test('update without --config keeps the installed configuration', () => {
  const d = tmp();
  const own = join(tmp(), 'own.json');
  writeFileSync(own, JSON.stringify({ interval_minutes: 10, checks: [{ check: 'uptime', key: 'boot' }] }));
  assert.equal(install(['--destdir', d, '--config', own]).status, 0);
  const r = install(['--destdir', d, '--version', 'v2']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, 'etc/skopos/config.json'), 'utf8'), readFileSync(own, 'utf8'));
  assert.match(readFileSync(join(d, 'etc/systemd/system/skopos.timer'), 'utf8'), /^OnCalendar=\*:0\/10$/m);
  assert.equal(readFileSync(join(d, 'opt/skopos/VERSION'), 'utf8'), 'v2\n');
});

test('configuration from stdin (--config -)', () => {
  const d = tmp();
  const r = install(['--destdir', d, '--config', '-'], { input: readFileSync(example) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, 'etc/skopos/config.json'), 'utf8'), readFileSync(example, 'utf8'));
});

test('the installed tree can update itself (installer run from /opt/skopos)', () => {
  const d = tmp();
  assert.equal(install(['--destdir', d, '--config', example, '--version', 'v1']).status, 0);
  const r = spawnSync('bash', [join(d, 'opt/skopos/bin/install.sh'), '--destdir', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, 'opt/skopos/VERSION'), 'utf8'), 'v1\n');
  assert.ok(existsSync(join(d, 'opt/skopos/lib/config.js')));
});

// Failure cases: loud abort, nothing written.
function assertAbortsCleanly(r, d, pattern) {
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, pattern);
  assert.deepEqual(readdirSync(d), [], 'no partial installation');
}

test('aborts without node, writes nothing', () => {
  // PATH with every tool of /usr/bin and /bin except node.
  const bin = tmp();
  for (const dir of ['/usr/bin', '/bin']) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name === 'node' || existsSync(join(bin, name))) continue;
      symlinkSync(join(dir, name), join(bin, name));
    }
  }
  const d = tmp();
  assertAbortsCleanly(install(['--destdir', d, '--config', example], { env: { PATH: bin } }), d, /node not found/);
});

test('aborts when --node is not executable, writes nothing', () => {
  const d = tmp();
  assertAbortsCleanly(install(['--destdir', d, '--config', example, '--node', join(tmp(), 'node')]), d, /not executable/);
});

test('aborts with node older than 22.13, writes nothing', () => {
  for (const v of ['22.12.0', '20.18.1', '18.0.0']) {
    const d = tmp();
    const r = install(['--destdir', d, '--config', example], { env: { PATH: `${fakeNode(v)}:${SYSTEM_PATH}` } });
    assertAbortsCleanly(r, d, new RegExp(`node ${v.replace(/\./g, '\\.')} .* too old`));
  }
});

test('accepts node 22.13 and newer majors', () => {
  // The stub only answers the version question; staging then runs the real node for
  // validation, so this checks the comparison alone via a dedicated stub that delegates.
  for (const v of ['22.13.0', '23.0.0', '24.1.0']) {
    const dir = tmp();
    writeFileSync(join(dir, 'node'), `#!/bin/sh\nif [ "$1" = "-p" ]; then echo ${v}; else exec ${process.execPath} "$@"; fi\n`);
    chmodSync(join(dir, 'node'), 0o755);
    const d = tmp();
    const r = install(['--destdir', d, '--config', example, '--node', join(dir, 'node')]);
    assert.equal(r.status, 0, `${v}: ${r.stderr}`);
  }
});

test('aborts on an invalid configuration, writes nothing', () => {
  const d = tmp();
  const bad = join(tmp(), 'bad.json');
  writeFileSync(bad, JSON.stringify({ checks: [{ check: 'no-such-check', key: 'x' }] }));
  assertAbortsCleanly(install(['--destdir', d, '--config', bad]), d, /unknown check "no-such-check"/);
});

test('aborts without any configuration, writes nothing', () => {
  const d = tmp();
  assertAbortsCleanly(install(['--destdir', d]), d, /no --config given/);
});

test('aborts on an unsafe version string', () => {
  const d = tmp();
  assertAbortsCleanly(install(['--destdir', d, '--config', example, '--version', 'x; rm -rf /']), d, /invalid --version/);
});

test('without --destdir it refuses to run as a normal user', { skip: process.getuid?.() === 0 }, () => {
  const r = install(['--config', example]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must run as root/);
});

test('unit templates are complete', () => {
  assert.match(readFileSync(join(root, 'systemd/skopos.service'), 'utf8'), /@NODE@/);
  assert.match(readFileSync(join(root, 'systemd/skopos.timer'), 'utf8'), /^@SCHEDULE@$/m);
});
