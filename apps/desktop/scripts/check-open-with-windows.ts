/**
 * Windows-only opt-in registry integration check.
 * Uses unique temporary HKCU keys and a real existing Node executable; never
 * changes a default association or launches an external application.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createOpenWithHandlers,
  decodeRegOutput,
  parseChcpCodepage,
} from '../src/main/openWithApps';

const exec = promisify(execFile);

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'This check requires a Windows runner');
  const id = 'CindyOpenWithTest-' + randomUUID();
  const ext = '.' + id.toLowerCase();
  const appName = id + '.exe';
  const applicationKey = 'HKCU\\Software\\Classes\\Applications\\' + appName;
  const progIdKey = 'HKCU\\Software\\Classes\\' + id;
  const registrationKey = 'HKCU\\Software\\RegisteredApplications';
  const directory = await mkdtemp(path.join(tmpdir(), 'cindy-open-with-'));
  const filePath = path.join(directory, 'README' + ext);
  const cleanupKeys = [applicationKey, progIdKey];
  let registered = false;
  const codepage = await exec('chcp.com', [], { windowsHide: true }).then(
    ({ stdout }) => parseChcpCodepage(stdout),
    () => null,
  );
  const reg = (args: string[], signal?: AbortSignal) =>
    exec('reg.exe', args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
      signal,
    });
  const addValue = (key: string, name: string | null, value: string) =>
    reg([
      'add',
      key,
      ...(name === null ? ['/ve'] : ['/v', name]),
      '/t',
      'REG_SZ',
      '/d',
      value,
      '/f',
    ]);
  let queries = 0;
  let launch: { command: string; args: string[] } | undefined;
  const handlers = createOpenWithHandlers({
    platform: 'win32',
    resolveFile: async (p) => ({ path: realpathSync(p), isFile: statSync(p).isFile() }),
    isPathAllowed: (candidate) => candidate === filePath,
    fileExists: existsSync,
    regQuery: async (key, args = [], signal) => {
      queries++;
      try {
        const { stdout } = await reg(['query', key, ...args], signal);
        return decodeRegOutput(stdout, codepage);
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) return '';
        throw error;
      }
    },
    getAppIcon: async () => null,
    spawnDetached: (command, args) => {
      launch = { command, args };
    },
  });
  const assertListed = async (source: string) => {
    const startedAt = performance.now();
    const result = await handlers.list({ filePath });
    assert.equal(result.success, true, source + ': registry discovery failed');
    assert.equal(result.apps.length, 1, source + ': installed editor missing or duplicated');
    assert.equal(result.apps[0].label, id);
    await handlers.open({ filePath, appId: result.apps[0].id });
    assert.deepEqual(launch, { command: process.execPath, args: [filePath] });
    console.log(
      source +
        ': passed; queries=' +
        queries +
        '; elapsedMs=' +
        Math.round(performance.now() - startedAt),
    );
    queries = 0;
  };
  try {
    await writeFile(filePath, '# Registry integration fixture');
    const command = '"' + process.execPath + '" "%1"';
    await addValue(applicationKey + '\\shell\\open\\command', null, command);
    await addValue(applicationKey, 'FriendlyAppName', id);
    await addValue(progIdKey + '\\shell\\open\\command', null, command);
    await addValue(progIdKey, null, id);
    await addValue(applicationKey + '\\SupportedTypes', ext, '');
    await assertListed('HKCR Applications / SupportedTypes (expanded hive output)');
    await reg(['delete', applicationKey + '\\shell', '/f']);
    const appPathsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + appName;
    cleanupKeys.push(appPathsKey);
    await addValue(appPathsKey, null, '"' + process.execPath + '"');
    await assertListed('SupportedTypes / HKCU App Paths');
    await reg(['delete', applicationKey + '\\SupportedTypes', '/f']);
    await addValue(applicationKey + '\\Capabilities\\FileAssociations', ext, id);
    await assertListed('HKCR Applications / Capabilities');
    // Remove the Applications declaration to test RegisteredApplications independently.
    await reg(['delete', applicationKey + '\\Capabilities', '/f']);
    const standaloneKey = 'HKCU\\Software\\' + id;
    cleanupKeys.push(standaloneKey);
    await addValue(standaloneKey + '\\FileAssociations', ext, id);
    await addValue(registrationKey, id, 'Software\\' + id);
    registered = true;
    await assertListed('HKCU RegisteredApplications (relative capability path)');
    await addValue(applicationKey + '\\SupportedTypes', ext, '');
    await assertListed('Multiple registration sources / deduplication');
  } finally {
    // Unique fixture entries only; attempt every cleanup even if one operation fails.
    const cleanup = await Promise.allSettled([
      ...cleanupKeys.map((key) => reg(['delete', key, '/f'])),
      ...(registered ? [reg(['delete', registrationKey, '/v', id, '/f'])] : []),
      rm(directory, { recursive: true, force: true }),
    ]);
    const unexpected = cleanup.filter(
      (result) => result.status === 'rejected' && (result.reason as { code?: unknown }).code !== 1,
    );
    assert.equal(unexpected.length, 0, 'Temporary fixture cleanup failed');
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
