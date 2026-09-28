// Mount points: mounted, and readable within a timeout. The read test runs in a child process
// that gets SIGKILL on timeout: a hanging network/FUSE mount blocks the system call in the
// kernel, and inside Skopos itself it would tie up a libuv thread for good.
import { readFile } from 'node:fs/promises';
import { checkNumber, checkPaths, isNumber, keyFrom, run, unknown } from './util.js';

// Mount points from /proc/self/mountinfo (field 5, octal escapes such as \040 decoded).
export function parseMountinfo(text) {
  const points = new Set();
  for (const line of String(text).split('\n')) {
    const f = line.split(' ');
    if (f.length > 5 && f[4].startsWith('/')) points.add(f[4].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
  }
  return points;
}

const defaultProbe = (path) => ({ cmd: 'ls', args: ['-f', '--', path] });

export function createMountCheck({ readMountinfo = () => readFile('/proc/self/mountinfo', 'utf8'), probe = defaultProbe } = {}) {
  return {
    name: 'mount',
    required: ['paths'],
    optional: ['read_timeout_seconds'],
    validate(params) {
      return [...checkNumber(params, 'read_timeout_seconds', { min: 0.1 }), ...checkPaths(params.paths, 'paths')];
    },
    async measure(params, ctx) {
      const timeoutMs = (params.read_timeout_seconds ?? 5) * 1000;
      let mounted;
      let mountError;
      try {
        mounted = parseMountinfo(await readMountinfo());
      } catch (e) {
        mountError = `/proc/self/mountinfo not readable: ${e.message}`;
      }
      // All paths in parallel: one hanging mount must not eat the time of the others.
      return Promise.all(params.paths.map(async (path) => {
        const key = keyFrom(path);
        if (mountError) return unknown(key, `${path}: ${mountError}`);
        if (!mounted.has(path)) return { key, value: 'not mounted', status: 'crit', reason: `${path} is not mounted` };
        const { cmd, args } = probe(path);
        const t0 = Date.now();
        const r = await run(cmd, args, { signal: ctx?.signal, timeoutMs });
        if (r.aborted) return unknown(key, `${path}: read test aborted`);
        if (r.timedOut) return { key, value: 'no response', status: 'crit', reason: `${path}: mount does not respond (no answer within ${timeoutMs / 1000} s)` };
        if (r.spawnError) return unknown(key, `${path}: read test could not be started: ${r.spawnError.message}`);
        if (r.code !== 0) return { key, value: 'unreadable', status: 'crit', reason: `${path}: not readable (${r.stderr.trim().split('\n')[0] || `exit ${r.code}`})` };
        const ms = Date.now() - t0;
        return isNumber(ms) ? { key, value: ms, unit: 'ms', status: 'ok' } : unknown(key, 'timing failed');
      }));
    },
  };
}

export default createMountCheck();
