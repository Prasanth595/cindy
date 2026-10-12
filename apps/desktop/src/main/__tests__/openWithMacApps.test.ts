import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  listMacOpenWithApps,
  MAC_OPEN_WITH_SCRIPT,
  parseMacOpenWithApps,
} from '../openWithMacApps';

let temporaryDir: string | undefined;
afterEach(() => {
  if (temporaryDir) fs.rmSync(temporaryDir, { recursive: true, force: true });
  temporaryDir = undefined;
});

it('accepts only absolute app bundle paths and finite timestamps', () => {
  const apps = parseMacOpenWithApps(
    JSON.stringify([
      { exePath: '/Applications/Code.app', label: ' Code ', lastUsedAt: 123, installedAt: null },
      { exePath: '/Applications/Typora.app', label: 'Typora', lastUsedAt: -1, installedAt: '2000' },
      { exePath: 'relative.app', label: 'Invalid' },
      { exePath: '/bin/sh', label: 'Shell' },
      { exePath: '/Applications/Bad.app', label: '' },
      { exePath: '/Applications/Bad\0.app', label: 'Invalid' },
      null,
    ]),
  );
  expect(apps).toEqual([
    { exePath: '/Applications/Code.app', label: 'Code', lastUsedAt: 123 },
    { exePath: '/Applications/Typora.app', label: 'Typora' },
  ]);
  expect(parseMacOpenWithApps('{}')).toEqual([]);
});

it('keeps the native script static and passes the file path only as argv', () => {
  expect(MAC_OPEN_WITH_SCRIPT).toContain('fileURLWithPath(argv[0])');
  expect(MAC_OPEN_WITH_SCRIPT).toContain('kMDItemLastUsedDate');
  expect(MAC_OPEN_WITH_SCRIPT).toContain('kMDItemDateAdded');
  expect(MAC_OPEN_WITH_SCRIPT).not.toContain('kMDItemFSContentChangeDate');
  expect(MAC_OPEN_WITH_SCRIPT).toContain('/^public\\.');
});

describe.skipIf(process.platform !== 'darwin')('live macOS system discovery', () => {
  it('queries the real NSWorkspace/Spotlight for a file with spaces and quotes in its path', async () => {
    temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-open-with-'));
    const file = path.join(temporaryDir, '阅读 "example".md');
    fs.writeFileSync(file, '# Markdown\n');
    const apps = await listMacOpenWithApps(file);
    expect(apps.length).toBeGreaterThan(0);
    expect(apps.every((app) => path.isAbsolute(app.exePath) && fs.existsSync(app.exePath))).toBe(
      true,
    );
    expect(apps.some((app) => app.exePath === '/System/Applications/TextEdit.app')).toBe(true);
    // 浏览器不能仅凭 public.text 通配冒充 Markdown 编辑器/阅读器。
    expect(apps.some((app) => app.exePath.includes('Chrome.app'))).toBe(false);
    const labels = apps.map((app) => app.label);
    expect(labels.every((label) => label.length > 0)).toBe(true);
    // 避免测试依赖某个第三方编辑器是否安装。
    const systemApps = JSON.parse(
      execFileSync(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', MAC_OPEN_WITH_SCRIPT, '--', file],
        { encoding: 'utf8' },
      ),
    );
    expect(systemApps.length).toBe(apps.length);
  }, 15000);
});
