// Registry of all checks. A new check is a module with
//   name, required[], optional[], validate?(params) -> string[], async measure(params, ctx) -> result[]
// plus an entry here. Result: { key?, value, unit?, status, reason? }.
import boot from './boot.js';
import disk from './disk.js';
import failedUnits from './failed-units.js';
import jsonFile from './json-file.js';
import journal from './journal.js';
import load from './load.js';
import memory from './memory.js';
import mount from './mount.js';
import oom from './oom.js';
import sqliteQuery from './sqlite-query.js';
import systemd from './systemd.js';
import uptime from './uptime.js';

export const CHECKS = Object.fromEntries([uptime, boot, memory, load, disk, oom, journal, failedUnits, systemd, mount, sqliteQuery, jsonFile].map((c) => [c.name, c]));
