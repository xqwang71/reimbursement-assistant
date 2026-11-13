import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['server.mjs'];
for (const directory of ['lib', 'public', 'scripts', 'tests']) {
  const entries = await readdir(resolve(root, directory), { recursive: true, withFileTypes: true });
  files.push(...entries.filter((entry) => entry.isFile() && /\.(m?js)$/.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name)));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
