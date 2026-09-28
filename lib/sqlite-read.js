// Read-only access to a SQLite database owned by someone else (decision 5). One opening
// function for every check that reads foreign databases:
//   <db>-wal exists  -> normal read-only open (the -wal/-shm files are readable, the reader
//                       sees the WAL content)
//   <db>-wal missing -> `file:<path>?mode=ro&immutable=1`: without a WAL file the whole state
//                       is in the main file, and no -shm needs to be created next to it.
// An immutable open takes no locks, so a writer starting in between could tear the read. The
// file is therefore fingerprinted before and after; a changed fingerprint means one retry,
// then an error — never a value read from a moving file.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const BUSY_TIMEOUT_MS = 5000;

// A read that failed for a known, reportable reason (becomes the `reason` of an `unknown`).
export class ReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadError';
  }
}

function describeAccess(what, e) {
  if (e.code === 'ENOENT') return `${what} not found`;
  if (e.code === 'EACCES' || e.code === 'EPERM') return `no read permission for ${what}`;
  return `cannot access ${what}: ${e.code ?? e.message}`;
}

export function openReadOnly(path) {
  let st;
  try {
    st = statSync(path);
    accessSync(path, constants.R_OK);
  } catch (e) {
    throw new ReadError(describeAccess('database file', e));
  }
  if (!st.isFile()) throw new ReadError('database path is not a regular file');
  const walExists = existsSync(`${path}-wal`);
  if (walExists) {
    try {
      accessSync(`${path}-wal`, constants.R_OK);
    } catch (e) {
      throw new ReadError(describeAccess('WAL file', e));
    }
  }
  const target = walExists ? path : `${pathToFileURL(path).href}?mode=ro&immutable=1`;
  try {
    // `timeout` is the busy timeout: foreign connections must not fail instantly on a lock.
    const db = new DatabaseSync(target, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    return { db, mode: walExists ? 'readonly' : 'immutable' };
  } catch (e) {
    throw new ReadError(`cannot open database: ${e.message}`);
  }
}

function fingerprint(path) {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}:${existsSync(`${path}-wal`)}`;
  } catch {
    return 'gone';
  }
}

// Opens the database read-only, runs the synchronous `fn(db)` and closes it again.
// Returns { result, mode }. Throws ReadError, or the error of `fn` if the file was stable.
export function withReadOnly(path, fn, { retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const before = fingerprint(path);
    const { db, mode } = openReadOnly(path);
    let result;
    let failure;
    try {
      result = fn(db);
    } catch (e) {
      failure = e;
    } finally {
      db.close();
    }
    const moved = mode === 'immutable' && fingerprint(path) !== before;
    if (moved) continue;
    if (failure) throw failure;
    return { result, mode };
  }
  throw new ReadError('database changed while it was being read');
}

// Only a single SELECT (or WITH … SELECT) statement is allowed. Returns an error message, or
// undefined if the text is acceptable. `prepare()` silently ignores anything after the first
// statement, so a second statement has to be rejected here. The connection is read-only as
// well; this is the first of two locks, not the only one.
export function checkQuery(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return 'query must be a non-empty string';
  let i = 0;
  let sawStatement = false;
  let ended = false;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
    } else if (two === '/*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return 'query has an unterminated comment';
      i = close + 2;
    } else if (/\s/.test(c)) {
      i += 1;
    } else if (c === ';') {
      if (!sawStatement) return 'query is empty';
      ended = true;
      i += 1;
    } else {
      if (ended) return 'query must be a single statement';
      if (!sawStatement) {
        const word = /^[A-Za-z]+/.exec(sql.slice(i))?.[0]?.toLowerCase();
        if (word !== 'select' && word !== 'with') return 'query must start with SELECT or WITH';
        sawStatement = true;
      }
      if (c === "'" || c === '"' || c === '`' || c === '[') {
        const close = c === '[' ? ']' : c;
        let j = i + 1;
        for (;;) {
          j = sql.indexOf(close, j);
          if (j === -1) return 'query has an unterminated quoted string or identifier';
          if (close !== ']' && sql[j + 1] === close) {
            j += 2; // doubled quote is an escaped quote
            continue;
          }
          break;
        }
        i = j + 1;
      } else {
        i += 1;
      }
    }
  }
  return sawStatement ? undefined : 'query is empty';
}
