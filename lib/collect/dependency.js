// Dependencies outside the hosts (e.g. the internet uplink), asked on demand only: when a
// confirmed problem of a check that depends on one is about to go out, the collector asks
// "was <dependency> down when this problem began?". Nothing is polled continuously.
//
// Shipped kind: a command (argument vector, no shell), called as `<command…> --at <time>`, the
// time in ISO 8601 UTC to the second (`2026-01-05T03:01:08Z`, no fraction: widely parseable).
// It prints one JSON object on stdout:
//   { "affected": true | false | "unknown", "outage": { "from", "to" } | null, "reason": "…" }
// `affected: true` with `outage.to: null` or without an outage means "down right now".
// Every failure (exit code, timeout, unreadable output) is "unknown", never "ok" and never
// "affected": the problem then goes out as usual.
import { execFile } from 'node:child_process';

const clip = (s, n = 300) => String(s ?? '').trim().slice(0, n);
const unknown = (reason) => ({ affected: 'unknown', outage: null, reason: clip(reason) });
const isTime = (x) => typeof x === 'string' && !Number.isNaN(Date.parse(x));

// Turns the command's stdout into a verdict; anything unexpected is "unknown".
export function interpretDependency(stdout) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    return unknown(`output is not JSON: ${clip(stdout, 100)}`);
  }
  if (r === null || typeof r !== 'object') return unknown('output is not a JSON object');
  const reason = clip(r.reason);
  if (r.affected === false) return { affected: false, outage: null, reason };
  if (r.affected === 'unknown') return unknown(reason || 'dependency state unknown');
  if (r.affected !== true) return unknown(`affected must be true, false or "unknown", got ${JSON.stringify(r.affected)}`);
  const o = r.outage;
  if (o === null || o === undefined) return { affected: true, outage: null, reason };
  if (typeof o !== 'object' || !isTime(o.from) || !(o.to === null || o.to === undefined || isTime(o.to))) {
    return unknown(`outage must be { from, to } with times, got ${clip(JSON.stringify(o), 100)}`);
  }
  return { affected: true, outage: { ...o, to: o.to ?? null }, reason };
}

// Down right now: affected, but no outage that has ended yet.
export const ongoing = (v) => v.affected === true && (v.outage === null || v.outage.to === null);

export function commandDependency({ command, timeout_seconds: timeoutSeconds = 30 }) {
  const [file, ...args] = command;
  return {
    query(atIso) {
      return new Promise((resolve) => {
        execFile(file, [...args, '--at', atIso.replace(/\.\d+Z$/, 'Z')], { timeout: timeoutSeconds * 1000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            const why = err.killed ? `timed out after ${timeoutSeconds} s` : err.code === 'ENOENT' ? `${file} not found` : `exited with ${err.code ?? err.signal}`;
            return resolve(unknown(`${why}: ${clip(stderr, 200)}`));
          }
          resolve(interpretDependency(stdout));
        });
      });
    },
  };
}

// { name: { query(atIso) } } from the validated configuration.
export function createDependencies(deps = {}) {
  return Object.fromEntries(Object.entries(deps).map(([name, d]) => [name, commandDependency(d)]));
}
