// systemd units in the failed state (`systemctl list-units --failed`), machine-wide. A failed
// timer-driven job shows up here; a merely stopped service does not (that is what the
// `systemd` check with an explicit unit list is for).
import { describeFailure, run, unknown } from './util.js';

const UNIT = /^[A-Za-z0-9:_.\\@-]+$/;

// First column of `systemctl list-units --no-legend --plain` output.
export function parseFailed(text) {
  return String(text).split('\n').map((l) => l.trim().replace(/^[●*×]\s*/u, '').split(/\s+/)[0]).filter((u) => u && UNIT.test(u));
}

const defaultList = ({ signal }) => run('systemctl', ['list-units', '--failed', '--no-legend', '--plain', '--no-pager'], { signal, timeoutMs: 10000 });

export function createFailedUnitsCheck({ list = defaultList } = {}) {
  return {
    name: 'failed-units',
    required: [],
    optional: ['ignore', 'severity'],
    validate(params) {
      const errors = [];
      if (params.ignore !== undefined && (!Array.isArray(params.ignore) || !params.ignore.every((u) => typeof u === 'string' && UNIT.test(u)))) {
        errors.push('ignore must be a list of unit names');
      }
      if (params.severity !== undefined && !['warn', 'crit'].includes(params.severity)) errors.push('severity must be "warn" or "crit"');
      return errors;
    },
    async measure(params, ctx) {
      const r = await list({ signal: ctx?.signal });
      if (r.spawnError || r.timedOut || r.aborted || r.code !== 0) return [unknown('failed', describeFailure('systemctl', r))];
      const ignore = new Set(params.ignore ?? []);
      const units = parseFailed(r.stdout).filter((u) => !ignore.has(u));
      const shown = units.slice(0, 5).join(', ') + (units.length > 5 ? ', …' : '');
      return [{
        key: 'failed',
        value: units.length,
        unit: 'units',
        status: units.length > 0 ? (params.severity ?? 'warn') : 'ok',
        reason: units.length > 0 ? `failed: ${shown}` : undefined,
      }];
    },
  };
}

export default createFailedUnitsCheck();
