// Collector state: one JSON file, written atomically after every poll. Its modification time
// doubles as the collector's own heartbeat (a `json-file` age check can watch it).
import { readFile, rename, writeFile } from 'node:fs/promises';
import { STATE_VERSION } from './machine.js';

export function fileStateStore(file) {
  return {
    async load() {
      let raw;
      try {
        raw = await readFile(file, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      try {
        const s = JSON.parse(raw);
        if (s?.state_version !== STATE_VERSION) throw new Error(`state version ${JSON.stringify(s?.state_version)} is unknown`);
        return s;
      } catch (e) {
        // No silent fresh start: move the file aside and fail loudly. The next poll starts over.
        const aside = `${file}.broken-${Date.now()}`;
        await rename(file, aside);
        throw new Error(`state file unreadable (${e.message}); moved to ${aside}, the next poll starts over`);
      }
    },
    async save(state) {
      // Mode 0640: the file may be watched by a local monitoring user through the group.
      await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o640 });
      await rename(`${file}.tmp`, file); // atomic: never a half-written state
    },
  };
}
