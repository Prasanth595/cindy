/** Explicit native check, outside default unit tests; never opens an app or reads documents. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listMacOpenWithApps } from '../src/main/openWithMacApps';

async function main() {
  assert.equal(process.platform, 'darwin', 'requires macOS');
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-open-with-'));
  try {
    const filePath = path.join(directory, '阅读 "example".md');
    await writeFile(filePath, '# fixture\n');
    const apps = await listMacOpenWithApps(filePath);
    assert.ok(apps.length > 0);
    assert.ok(
      apps.every((app) => path.isAbsolute(app.exePath) && existsSync(app.exePath) && app.label),
    );
    assert.ok(apps.some((app) => app.exePath === '/System/Applications/TextEdit.app'));
    assert.ok(!apps.some((app) => app.exePath.includes('Google Chrome.app')));
    process.stdout.write('NSWorkspace native discovery passed; no app launched\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
});
