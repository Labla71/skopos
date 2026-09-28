#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Skopos: `skopos run` measures once, `skopos report --json` prints heartbeat, status and history,
// `skopos collect` polls the reports of other hosts and notifies confirmed state changes.
import { parseArgs } from 'node:util';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig } from '../lib/config.js';
import { runOnce } from '../lib/run.js';
import { buildReport } from '../lib/report.js';
import { DEFAULT_DB_PATH, openStore, openStoreReadOnly } from '../lib/store.js';
import { loadCollectConfig } from '../lib/collect/config.js';
import { createNotifier } from '../lib/collect/notify.js';
import { collectOnce, formatPoll } from '../lib/collect/run.js';
import { fileStateStore } from '../lib/collect/store.js';
import { DEFAULT_MARKER_PATH } from '../lib/checks/boot.js';

const HELP = `Usage:
  skopos run    [--config <file>] [--db <file>]
  skopos report --json [--since <ISO timestamp>] [--db <file>]
  skopos collect --config <file>
  skopos expect-reboot [--reason <text>] [--marker <file>]
Defaults: --config ${DEFAULT_CONFIG_PATH}, --db ${DEFAULT_DB_PATH} (also via SKOPOS_DB).
expect-reboot: run right before a deliberate reboot (e.g. after an apt/kernel update) so the
"boot" check reports it as ok instead of warn. Default marker: ${DEFAULT_MARKER_PATH}.`;

// process.exit() discards output that is still queued for a pipe: whatever the reader has not
// taken yet beyond the 64 KB pipe buffer (e.g. over SSH) would be cut off, and the collector
// would get broken JSON. Output therefore waits until it has been handed to the OS.
// (fail() writes a few lines only, which always fit into the pipe buffer.)
const writeOut = (text) => new Promise((resolve) => { process.stdout.write(text, resolve); });

function fail(text, code) {
  process.stderr.write(`${text}\n`);
  process.exit(code);
}

const { positionals, values } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        db: { type: 'string' },
        json: { type: 'boolean' },
        since: { type: 'string' },
        reason: { type: 'string' },
        marker: { type: 'string' },
      },
    });
  } catch (e) {
    return fail(`${e.message}\n${HELP}`, 2);
  }
})();

const dbPath = values.db ?? process.env.SKOPOS_DB ?? DEFAULT_DB_PATH;
const [command] = positionals;

try {
  if (command === 'run' && positionals.length === 1) {
    const config = loadConfig(values.config ?? DEFAULT_CONFIG_PATH);
    const store = openStore(dbPath);
    try {
      const r = await runOnce(config, store);
      const n = (s) => r.measurements.filter((m) => m.status === s).length;
      // Peak RSS of this process, for the resource footprint in the journal (systemd does not
      // keep MemoryPeak of a finished oneshot unit).
      const rssMb = (process.resourceUsage().maxRSS / 1024).toFixed(1);
      await writeOut(`run ${r.runId}: ok=${n('ok')} warn=${n('warn')} crit=${n('crit')} unknown=${n('unknown')} (${r.durationMs} ms, peak rss ${rssMb} MB)\n`);
    } finally {
      store.close();
    }
  } else if (command === 'report' && positionals.length === 1 && values.json) {
    let since;
    if (values.since !== undefined) {
      const t = Date.parse(values.since);
      if (Number.isNaN(t)) fail(`--since is not a valid ISO timestamp: ${values.since}`, 2);
      since = new Date(t).toISOString();
    }
    const store = openStoreReadOnly(dbPath);
    try {
      await writeOut(`${JSON.stringify(buildReport(store, { since }), null, 2)}\n`);
    } finally {
      store.close();
    }
  } else if (command === 'collect' && positionals.length === 1 && values.config) {
    const cfg = loadCollectConfig(values.config);
    const r = await collectOnce({ cfg, store: fileStateStore(cfg.state_file), notifier: createNotifier(cfg.notifier) });
    await writeOut(`${formatPoll(r)}\n`);
    // Fail loudly: undelivered events wait in the state, the unit shows up as failed.
    if (r.stats.failed > 0) fail(`notifier failed: ${r.errors[0] ?? '?'}`, 1);
  } else if (command === 'expect-reboot' && positionals.length === 1) {
    const path = values.marker ?? DEFAULT_MARKER_PATH;
    const payload = { created_at: new Date().toISOString() };
    if (values.reason) payload.reason = values.reason;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
    await chmod(path, 0o644); // writeFile's mode is masked by umask; the boot check runs as a different user
    await writeOut(`expected-reboot marker written: ${path}\n`);
  } else {
    fail(HELP, 2);
  }
} catch (e) {
  fail(e instanceof ConfigError ? e.message : `Error: ${e.message}`, e instanceof ConfigError ? 2 : 1);
}
// A hanging check must not keep the process alive; all output has been flushed above.
process.exit(0);
