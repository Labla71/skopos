// Version for the heartbeat: package.json, extended by the commit id from VERSION (written
// next to the code by the installer), if present.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function version() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const file = join(root, 'VERSION');
  if (!existsSync(file)) return pkg;
  const commit = readFileSync(file, 'utf8').trim();
  return commit ? `${pkg}+${commit}` : pkg;
}
