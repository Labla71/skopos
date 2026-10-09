import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReport } from '../lib/report-text.js';

const cli = new URL('../bin/skopos.js', import.meta.url).pathname;
const node = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8' });

const check = (key, status, value = null, unit = null, reason = null) => ({ check: key, key, status, value, unit, reason, time: 't' });
const report = (checks, hb = {}) => ({
  heartbeat: { version: '1.2.3', age_seconds: 40, interval_minutes: 5, stale: false, counts: { ok: 1, warn: 0, crit: 1, unknown: 1 }, ...hb },
  checks,
});

test('text report: problems first, every status is a word, unknown keeps its reason', () => {
  const text = formatReport(report([
    check('memory.ram', 'ok', 24.8, '%'),
    check('queue', 'unknown', null, null, 'database file not found'),
    check('disk.root', 'crit', 97, '%', 'disk almost full'),
  ]));
  const lines = text.split('\n');
  assert.match(lines[0], /^Skopos 1\.2\.3 - last run 40 s ago \(every 5 min\)$/);
  assert.equal(lines[1], 'ok 1 | warn 0 | crit 1 | unknown 1');
  assert.match(lines[3], /^STATUS +CHECK +VALUE +REASON$/);
  assert.match(lines[4], /^CRIT +disk\.root +97 % +disk almost full$/);
  assert.match(lines[5], /^UNKNOWN +queue +database file not found$/);
  assert.match(lines[6], /^ok +memory\.ram +24\.8 %$/);
});

test('text report: a stale or unknown-freshness heartbeat is named, no run is not invented', () => {
  assert.match(formatReport(report([], { stale: true, age_seconds: 4000 })), /67 min ago.*STALE: no fresh run/);
  assert.match(formatReport(report([], { stale: null })), /freshness unknown/);
  assert.match(formatReport({ heartbeat: null, checks: [] }), /^No run recorded yet/);
});

test('CLI: report without --json prints the table, with --json still valid JSON', () => {
  const d = mkdtempSync(join(tmpdir(), 'skopos-text-'));
  try {
    const db = join(d, 'skopos.db');
    const config = join(d, 'config.json');
    writeFileSync(config, JSON.stringify({ checks: [{ check: 'uptime', key: 'boot' }] }));
    assert.equal(node(['run', '--config', config, '--db', db]).status, 0);
    const text = node(['report', '--db', db]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^STATUS +CHECK +VALUE +REASON$/m);
    assert.match(text.stdout, /^ok +boot/m);
    assert.equal(JSON.parse(node(['report', '--json', '--db', db]).stdout).heartbeat.counts.ok, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
