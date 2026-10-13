import { describe, expect, it, vi } from 'vitest';

import {
  createOpenWithHandlers,
  decodeRegOutput,
  expandWindowsEnv,
  parseChcpCodepage,
  parseCommandLineExe,
  parseRegSubkeys,
  parseRegValues,
  parseWindowsApplicationClaims,
  parseWindowsInstalledApps,
  type OpenWithDeps,
} from '../openWithApps';

describe('parseCommandLineExe', () => {
  it('extracts quoted and unquoted executable paths', () => {
    expect(parseCommandLineExe('"C:\\Program Files\\App\\app.exe" "%1"')).toBe(
      'C:\\Program Files\\App\\app.exe',
    );
    expect(parseCommandLineExe('C:\\Tools\\a.exe %1')).toBe('C:\\Tools\\a.exe');
    // 无引号但路径含空格的老注册表项:按 .exe 边界截。
    expect(parseCommandLineExe('C:\\Program Files\\App\\app.exe /open %1')).toBe(
      'C:\\Program Files\\App\\app.exe',
    );
    expect(parseCommandLineExe('')).toBeNull();
    expect(parseCommandLineExe('"unterminated')).toBeNull();
  });
});

describe('expandWindowsEnv', () => {
  it('expands %VAR% references and keeps unknown ones verbatim', () => {
    expect(expandWindowsEnv('%SystemRoot%\\notepad.exe', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\notepad.exe',
    );
    expect(expandWindowsEnv('%NOPE%\\a.exe', {})).toBe('%NOPE%\\a.exe');
    expect(expandWindowsEnv('%LOCALAPPDATA%\\a.exe', { LocalAppData: 'C:\\User' })).toBe('C:\\User\\a.exe');
  });
});

describe('reg.exe output parsing', () => {
  it('parses value rows with names, types and data', () => {
    const stdout = [
      'HKEY_CURRENT_USER\\...\\OpenWithList',
      '    a    REG_SZ    EXCEL.EXE',
      '    b    REG_SZ    notepad.exe',
      '    MRUList    REG_SZ    ab',
      '',
    ].join('\r\n');
    expect(parseRegValues(stdout)).toEqual([
      { name: 'a', data: 'EXCEL.EXE' },
      { name: 'b', data: 'notepad.exe' },
      { name: 'MRUList', data: 'ab' },
    ]);
  });

  it('parses empty-data rows (OpenWithProgids REG_NONE values)', () => {
    const stdout = [
      'HKEY_CLASSES_ROOT\\.xlsx\\OpenWithProgids',
      '    Excel.Sheet.12    REG_NONE    ',
      '',
    ].join('\r\n');
    expect(parseRegValues(stdout)).toEqual([{ name: 'Excel.Sheet.12', data: '' }]);
    expect(parseRegValues('    VSCode.md    REG_NONE')).toEqual([{ name: 'VSCode.md', data: '' }]);
  });

  it('parses subkey listings relative to the parent key', () => {
    const parent = 'HKCR\\.xlsx\\OpenWithList';
    const stdout = [
      'HKCR\\.xlsx\\OpenWithList\\EXCEL.EXE',
      'HKCR\\.xlsx\\OpenWithList\\wps.exe',
      '',
    ].join('\r\n');
    expect(parseRegSubkeys(stdout, parent)).toEqual(['EXCEL.EXE', 'wps.exe']);
  });

  it('accepts real expanded hive output and ignores grandchildren', () => {
    expect(parseRegSubkeys([
      'HKEY_CLASSES_ROOT\\Applications\\Code.exe',
      'HKEY_CLASSES_ROOT\\Applications\\Code.exe\\shell',
      'HKEY_CURRENT_USER\\Applications\\Other.exe',
    ].join('\r\n'), 'HKCR\\Applications')).toEqual(['Code.exe']);
  });

  it('accepts exact application extension claims, not search hits in unrelated keys', () => {
    const output = [
      'HKEY_CLASSES_ROOT\\Applications\\Code.exe\\SupportedTypes',
      '    .MD    REG_SZ    ',
      'HKEY_CLASSES_ROOT\\Applications\\Typora.exe\\Capabilities\\FileAssociations',
      '    .md    REG_SZ    Typora.md',
      'HKEY_CLASSES_ROOT\\Applications\\Other.exe\\SupportedTypes',
      '    .mdown    REG_SZ    ',
      'HKEY_CLASSES_ROOT\\Applications\\Unrelated.exe\\Other',
      '    .md    REG_SZ    something',
    ].join('\r\n');
    expect(parseWindowsApplicationClaims(output, '.md')).toEqual(['code.exe', 'typora.exe']);
  });
});

describe('reg.exe output decoding', () => {
  it('decodes GBK bytes with codepage 936 (中文系统 reg.exe 实际输出)', () => {
    // 「工作表」的 GBK 编码字节;按 UTF-8 解会全变 U+FFFD。
    const gbk = new Uint8Array([0xb9, 0xa4, 0xd7, 0xf7, 0xb1, 0xed]);
    expect(decodeRegOutput(gbk, 936)).toBe('工作表');
    expect(decodeRegOutput(gbk, null)).toContain('�');
  });

  it('falls back to UTF-8 for unknown or unmapped codepages', () => {
    const utf8 = new TextEncoder().encode('Notepad');
    expect(decodeRegOutput(utf8, null)).toBe('Notepad');
    expect(decodeRegOutput(utf8, 850)).toBe('Notepad');
    expect(decodeRegOutput(new TextEncoder().encode('メモ帳'), 65001)).toBe('メモ帳');
  });

  it('parses chcp output across locales', () => {
    expect(parseChcpCodepage('活动代码页: 936\r\n')).toBe(936);
    expect(parseChcpCodepage('Active code page: 437\r\n')).toBe(437);
    expect(parseChcpCodepage('')).toBeNull();
  });
});

/** 以「.xlsx 有 MRU + ProgId 两个来源」为形状的假注册表。 */
function makeDeps(overrides: Partial<OpenWithDeps> = {}): OpenWithDeps & {
  spawnDetached: ReturnType<typeof vi.fn>;
} {
  const registry: Record<string, string> = {
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.xlsx\\OpenWithList':
      '    a    REG_SZ    EXCEL.EXE\r\n    MRUList    REG_SZ    a\r\n',
    'HKCR\\Applications\\EXCEL.EXE\\shell\\open\\command':
      '    (Default)    REG_SZ    "C:\\Office\\EXCEL.EXE" "%1"\r\n',
    'HKCR\\Applications\\EXCEL.EXE': '    FriendlyAppName    REG_SZ    Microsoft Excel\r\n',
    'HKCR\\.xlsx\\OpenWithProgids': '    Wps.Sheet    REG_NONE    \r\n',
    'HKCR\\Wps.Sheet\\shell\\open\\command':
      '    (Default)    REG_SZ    "C:\\WPS\\wps.exe" "%1"\r\n',
    'HKCR\\Wps.Sheet': '    (Default)    REG_SZ    WPS 表格\r\n',
  };
  const spawnDetached = vi.fn();
  const base: OpenWithDeps = {
    platform: 'win32',
    isPathAllowed: () => true,
    fileExists: () => true,
    regQuery: async (keyPath: string) => registry[keyPath] ?? '',
    getAppIcon: async () => null,
    spawnDetached,
  };
  return { ...base, ...overrides, spawnDetached };
}

const FILE = 'C:\\work\\报表.xlsx';

describe('createOpenWithHandlers.list', () => {
  it('keeps discovered editors if optional installation-date queries fail', async () => {
    const base = makeDeps();
    const onDiscoveryError = vi.fn();
    const result = await createOpenWithHandlers(makeDeps({
      onDiscoveryError,
      regQuery: async (key, args) => {
        if (key.endsWith('Uninstall')) throw new Error('optional metadata unavailable');
        return base.regQuery(key, args);
      },
    })).list({ filePath: FILE });
    expect(result.success).toBe(true);
    expect(result.apps.map((app) => app.label)).toEqual(['Microsoft Excel', 'WPS 表格']);
    expect(onDiscoveryError).toHaveBeenCalledOnce();
  });

  it.each([
    ['HKCU', 'Software\\Editor\\Capabilities', 'HKCU\\Software\\Editor\\Capabilities'],
    ['HKLM', 'Software\\Editor\\Capabilities', 'HKLM\\Software\\Editor\\Capabilities'],
    ['HKCU', 'HKLM\\Software\\Editor\\Capabilities', 'HKLM\\Software\\Editor\\Capabilities'],
    ['HKLM', 'HKEY_CURRENT_USER\\Software\\Editor\\Capabilities', 'HKEY_CURRENT_USER\\Software\\Editor\\Capabilities'],
  ])('resolves capability paths in their registered hive: %s %s', async (hive, registeredPath, resolvedPath) => {
    const base = makeDeps();
    const query = vi.fn(async (key: string, args?: string[]) => {
      if (key === hive + '\\Software\\RegisteredApplications') return '    Editor    REG_SZ    ' + registeredPath;
      if (key === resolvedPath + '\\FileAssociations') return '    .xlsx    REG_SZ    Wps.Sheet';
      return base.regQuery(key, args);
    });
    const result = await createOpenWithHandlers(makeDeps({ regQuery: query })).list({ filePath: FILE });
    expect(result.apps.filter((app) => app.label === 'WPS 表格')).toHaveLength(1);
    expect(query.mock.calls.filter(([key]) => key.endsWith('Capabilities\\FileAssociations'))).toHaveLength(1);
  });

  it('bounds capability queries to four concurrent subprocesses', async () => {
    let active = 0;
    let peak = 0;
    const query = vi.fn(async (key: string) => {
      if (key === 'HKCU\\Software\\RegisteredApplications') {
        return Array.from({ length: 30 }, (_, i) => '    App' + i + '    REG_SZ    Software\\App' + i + '\\Capabilities').join('\r\n');
      }
      if (key.endsWith('Capabilities\\FileAssociations')) {
        active++; peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
      }
      return '';
    });
    await createOpenWithHandlers(makeDeps({ regQuery: query })).list({ filePath: FILE });
    expect(peak).toBe(4);
    expect(query.mock.calls.filter(([key]) => key.endsWith('Capabilities\\FileAssociations'))).toHaveLength(30);
  });

  it('resolves SupportedTypes applications through user-level App Paths with one bulk query', async () => {
    const query = vi.fn(async (key: string) => {
      if (key === 'HKCR\\Applications') return [
        'HKEY_CLASSES_ROOT\\Applications\\Code.exe\\SupportedTypes',
        '    .md    REG_SZ    ',
        ...Array.from({ length: 100 }, (_, i) =>
          'HKEY_CLASSES_ROOT\\Applications\\Other' + i + '.exe\\SupportedTypes\r\n    .txt    REG_SZ    '),
      ].join('\r\n');
      if (key === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\code.exe') {
        return '    (Default)    REG_SZ    "C:\\Code\\Code.exe"';
      }
      return '';
    });
    const result = await createOpenWithHandlers(makeDeps({ regQuery: query })).list({ filePath: 'C:\\work\\README.md' });
    expect(result.apps.map((app) => app.label)).toEqual(['Code']);
    expect(query).toHaveBeenCalledWith('HKCR\\Applications', ['/s', '/f', '.md', '/e']);
    expect(query.mock.calls.length).toBeLessThan(20);
    expect(query.mock.calls.some(([key]) => key.includes('Other'))).toBe(false);
  });

  it('bounds a stalled registry scan and degrades to a failed empty result', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(() => new Promise<string>(() => {}));
      const pending = createOpenWithHandlers(makeDeps({ regQuery: query })).list({ filePath: FILE });
      await vi.advanceTimersByTimeAsync(8000);
      expect(await pending).toEqual({ success: false, apps: [], error: '无法查询可用应用' });
      expect(query).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovers applications registered through Windows Capabilities', async () => {
    const base = makeDeps();
    const registered: Record<string, string> = {
      'HKCU\\Software\\RegisteredApplications':
        '    Visual Studio Code    REG_SZ    Software\\Classes\\Applications\\Code.exe\\Capabilities\r\n',
      'HKCU\\Software\\Classes\\Applications\\Code.exe\\Capabilities\\FileAssociations':
        '    .md    REG_SZ    VSCode.md\r\n',
      'HKCR\\VSCode.md\\shell\\open\\command':
        '    (Default)    REG_SZ    "C:\\Users\\test\\Code.exe" "%1"\r\n',
      'HKCR\\VSCode.md': '    (Default)    REG_SZ    Visual Studio Code\r\n',
    };
    const deps = makeDeps({
      regQuery: async (keyPath: string, args?: string[]) =>
        registered[keyPath] ?? base.regQuery(keyPath, args),
    });
    const result = await createOpenWithHandlers(deps).list({
      filePath: FILE.replace('.xlsx', '.md'),
    });
    expect(result.apps.map((app) => app.label)).toContain('Visual Studio Code');
  });

  it('enumerates registry apps, resolves labels and dedupes by exe path', async () => {
    const handlers = createOpenWithHandlers(makeDeps());
    const res = await handlers.list({ filePath: FILE });
    expect(res.success).toBe(true);
    expect(res.apps.map((a) => a.label)).toEqual(['Microsoft Excel', 'WPS 表格']);
  });

  it('skips entries whose executable no longer exists', async () => {
    const deps = makeDeps({ fileExists: (p: string) => p !== 'C:\\WPS\\wps.exe' });
    const handlers = createOpenWithHandlers(deps);
    const res = await handlers.list({ filePath: FILE });
    expect(res.success).toBe(true);
    expect(res.apps.map((a) => a.label)).toEqual(['Microsoft Excel']);
  });

  it('does not let stale user-level App Paths hide a valid machine-level install', async () => {
    const base = makeDeps();
    const query = async (key: string, args?: string[]) => {
      if (key === 'HKCR\\Applications\\EXCEL.EXE\\shell\\open\\command') return '';
      if (key.startsWith('HKCU\\Software') && key.endsWith('App Paths\\EXCEL.EXE')) {
        return '    (Default)    REG_SZ    C:\\Removed\\EXCEL.EXE';
      }
      if (key.startsWith('HKLM\\Software') && key.endsWith('App Paths\\EXCEL.EXE')) {
        return '    (Default)    REG_SZ    C:\\Office\\EXCEL.EXE';
      }
      return base.regQuery(key, args);
    };
    const result = await createOpenWithHandlers(makeDeps({
      regQuery: query, fileExists: (p) => p !== 'C:\\Removed\\EXCEL.EXE',
    })).list({ filePath: FILE });
    expect(result.apps.map((app) => app.label)).toContain('Microsoft Excel');
  });

  it('returns an empty list without a platform discovery adapter', async () => {
    const handlers = createOpenWithHandlers(makeDeps({ platform: 'darwin' }));
    const res = await handlers.list({ filePath: '/tmp/a.xlsx' });
    expect(res).toEqual({ success: true, apps: [] });
  });

  it('fails soft when the target path is rejected', async () => {
    const handlers = createOpenWithHandlers(makeDeps({ isPathAllowed: () => false }));
    const res = await handlers.list({ filePath: FILE });
    expect(res.success).toBe(false);
    expect(res.apps).toEqual([]);
  });
});

describe('createOpenWithHandlers.open', () => {
  it('opens via the main-side appId mapping only', async () => {
    const deps = makeDeps();
    const handlers = createOpenWithHandlers(deps);
    const res = await handlers.list({ filePath: FILE });
    const excel = res.apps.find((a) => a.label === 'Microsoft Excel');
    expect(excel).toBeDefined();
    await handlers.open({ filePath: FILE, appId: excel!.id });
    expect(deps.spawnDetached).toHaveBeenCalledWith('C:\\Office\\EXCEL.EXE', [FILE]);
  });

  it('rejects appIds that never came from an enumeration', async () => {
    const deps = makeDeps();
    const handlers = createOpenWithHandlers(deps);
    // 未 list 先 open:映射为空,任何 appId(包括看似路径的字符串)都拒绝。
    await expect(handlers.open({ filePath: FILE, appId: 'C:\\evil\\payload.exe' })).rejects.toThrow(
      /NOT_FOUND/,
    );
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it('validates the file path before spawning', async () => {
    const deps = makeDeps();
    const handlers = createOpenWithHandlers(deps);
    await expect(handlers.open({ filePath: 'relative.xlsx', appId: 'x' })).rejects.toThrow(
      /INVALID_PARAMS/,
    );
  });
});

describe('createOpenWithHandlers surface', () => {
  it('exposes only list/open — no system OpenAs dialog escape hatch', () => {
    // 「选择其他应用…」已下线(系统 OpenAs 对话框实测起不来,且与 Codex 形态
    // 不符),对应的 choose handler 与 showOpenAppDialog 依赖一并移除。
    const handlers = createOpenWithHandlers(makeDeps());
    expect(Object.keys(handlers).sort()).toEqual(['list', 'open']);
  });
});

describe('macOS local apps and chronological ordering', () => {
  const filePath = '/tmp/README.md';
  const NOW = 10000;
  const vscode = { exePath: '/Applications/Visual Studio Code.app', label: 'Visual Studio Code' };
  const typora = { exePath: '/Applications/Typora.app', label: 'Typora' };
  function macDeps(overrides: Partial<OpenWithDeps> = {}) {
    return makeDeps({
      platform: 'darwin',
      now: () => NOW,
      listMacApps: async () => [vscode, typora],
      ...overrides,
    });
  }

  it('sorts by the newer of last use and installation, not system default order', async () => {
    const deps = macDeps({
      listMacApps: async () => [
        { ...typora, lastUsedAt: 7000, installedAt: 1000 },
        { ...vscode, installedAt: 9000 },
        { exePath: '/Applications/Obsidian.app', label: 'Obsidian', lastUsedAt: 8000 },
      ],
    });
    const result = await createOpenWithHandlers(deps).list({ filePath });
    expect(result.apps.map((app) => app.label)).toEqual([
      'Visual Studio Code',
      'Obsidian',
      'Typora',
    ]);
  });

  it('puts the most recently used application first', async () => {
    const result = await createOpenWithHandlers(
      macDeps({
        listMacApps: async () => [
          { ...typora, lastUsedAt: 2000 },
          { ...vscode, lastUsedAt: 9000 },
        ],
      }),
    ).list({ filePath });
    expect(result.apps[0].label).toBe('Visual Studio Code');
  });

  it('uses alphabetic order for unknown, invalid or future times without inventing times', async () => {
    const result = await createOpenWithHandlers(
      macDeps({
        listMacApps: async () => [
          { ...vscode, installedAt: NOW + 1, lastUsedAt: NaN },
          { ...typora, installedAt: -1, lastUsedAt: Infinity },
        ],
      }),
    ).list({ filePath });
    expect(result.apps.map((app) => app.label)).toEqual(['Typora', 'Visual Studio Code']);
  });

  it('merges Cindy usage with OS usage and records only a successfully opened application', async () => {
    const used = new Map<string, number>();
    const recordUsed = vi.fn((appPath: string, timestamp: number) => {
      used.set(appPath, timestamp);
    });
    const deps = macDeps({
      usage: { getLastUsed: (appPath) => used.get(appPath) ?? 0, recordUsed },
    });
    const handlers = createOpenWithHandlers(deps);
    const first = await handlers.list({ filePath });
    const code = first.apps.find((app) => app.label === 'Visual Studio Code')!;
    await handlers.open({ filePath, appId: code.id });
    expect(deps.spawnDetached).toHaveBeenCalledWith('/usr/bin/open', [
      '-a',
      vscode.exePath,
      '--',
      filePath,
    ]);
    expect(recordUsed).toHaveBeenCalledWith(vscode.exePath, NOW);
    const second = await handlers.list({ filePath });
    expect(second.apps[0].label).toBe('Visual Studio Code');
    expect(second.apps[0].id).toBe(code.id);
  });

  it('does not truncate the available apps after twelve entries', async () => {
    const result = await createOpenWithHandlers(
      macDeps({
        listMacApps: async () =>
          Array.from({ length: 15 }, (_, i) => ({
            exePath: '/Applications/Editor' + i + '.app',
            label: 'Editor ' + i,
          })),
      }),
    ).list({ filePath });
    expect(result.apps).toHaveLength(15);
  });

  it('refreshes installed apps and rejects the old id after uninstallation', async () => {
    const apps = [vscode, typora];
    const handlers = createOpenWithHandlers(macDeps({ listMacApps: async () => apps }));
    const first = await handlers.list({ filePath });
    const code = first.apps.find((app) => app.label === 'Visual Studio Code')!;
    apps.splice(0, 1);
    expect((await handlers.list({ filePath })).apps.map((app) => app.label)).toEqual(['Typora']);
    await expect(handlers.open({ filePath, appId: code.id })).rejects.toThrow(/NOT_FOUND/);
  });

  it('dedupes bundles and removes missing applications', async () => {
    const result = await createOpenWithHandlers(
      macDeps({
        listMacApps: async () => [vscode, vscode, typora],
        fileExists: (p) => p !== typora.exePath,
      }),
    ).list({ filePath });
    expect(result.apps.map((app) => app.label)).toEqual(['Visual Studio Code']);
  });

  it('keeps apps when an icon fails and fails soft if native discovery fails', async () => {
    const result = await createOpenWithHandlers(
      macDeps({
        getAppIcon: async () => {
          throw new Error('icon failed');
        },
      }),
    ).list({ filePath });
    expect(result.success).toBe(true);
    expect(result.apps).toHaveLength(2);
    const failed = await createOpenWithHandlers(
      macDeps({
        listMacApps: async () => {
          throw new Error('/private/path');
        },
      }),
    ).list({ filePath });
    expect(failed).toEqual({ success: false, apps: [], error: '无法查询可用应用' });
  });

  it('does not record a failed launch or block opening when usage storage fails', async () => {
    const recordUsed = vi.fn();
    const deps = macDeps({ usage: { getLastUsed: () => 0, recordUsed } });
    const handlers = createOpenWithHandlers(deps);
    const result = await handlers.list({ filePath });
    deps.spawnDetached.mockRejectedValueOnce(new Error('failed to launch'));
    await expect(handlers.open({ filePath, appId: result.apps[0].id })).rejects.toThrow(
      'failed to launch',
    );
    expect(recordUsed).not.toHaveBeenCalled();
    recordUsed.mockImplementationOnce(() => {
      throw new Error('readonly');
    });
    await expect(handlers.open({ filePath, appId: result.apps[0].id })).resolves.toBeUndefined();
  });

  it('validates path grants before any native enumeration and never accepts raw bundle paths', async () => {
    const listMacApps = vi.fn(async () => [vscode]);
    const handlers = createOpenWithHandlers(macDeps({ listMacApps, isPathAllowed: () => false }));
    expect((await handlers.list({ filePath })).success).toBe(false);
    expect(listMacApps).not.toHaveBeenCalled();
    const allowed = createOpenWithHandlers(macDeps());
    await allowed.list({ filePath });
    await expect(allowed.open({ filePath, appId: vscode.exePath })).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('Windows application recency', () => {
  it('parses real install dates and rejects invalid calendar dates', () => {
    const rows = [
      'HKEY_LOCAL_MACHINE\\Software\\Uninstall\\Code',
      '    InstallDate    REG_SZ    20261012',
      '    InstallLocation    REG_SZ    C:\\Code',
      '    DisplayIcon    REG_SZ    "C:\\Code\\Code.exe",0',
      'HKEY_LOCAL_MACHINE\\Software\\Uninstall\\Invalid',
      '    InstallDate    REG_SZ    20260231',
      '    InstallLocation    REG_SZ    C:\\Bad',
    ].join('\r\n');
    expect(parseWindowsInstalledApps(rows)).toEqual([
      { location: 'C:\\Code', icon: 'C:\\Code\\Code.exe', installedAt: Date.UTC(2026, 9, 12) },
    ]);
  });

  it('sorts using MRUList rather than registry enumeration order when no times exist', async () => {
    const base = makeDeps();
    const deps = makeDeps({
      regQuery: async (key, args) =>
        key.endsWith('FileExts\\.xlsx\\OpenWithList')
          ? '    a    REG_SZ    EXCEL.EXE\r\n    b    REG_SZ    wps.exe\r\n    MRUList    REG_SZ    ba\r\n'
          : base.regQuery(key, args),
    });
    const result = await createOpenWithHandlers(deps).list({ filePath: FILE });
    expect(result.apps.map((app) => app.label)).toEqual(['WPS 表格', 'Microsoft Excel']);
  });

  it('brings a newly installed app above older installed apps and keeps unrelated paths out', async () => {
    const base = makeDeps();
    const deps = makeDeps({
      now: () => Date.UTC(2026, 9, 12, 12),
      regQuery: async (key, args) =>
        key === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
          ? [
              'HKEY_CURRENT_USER\\Software\\Uninstall\\WPS',
              '    InstallDate    REG_SZ    20261012',
              '    InstallLocation    REG_SZ    C:\\WPS',
              'HKEY_CURRENT_USER\\Software\\Uninstall\\Office',
              '    InstallDate    REG_SZ    20260901',
              '    DisplayIcon    REG_SZ    "C:\\Office\\EXCEL.EXE",0',
            ].join('\r\n')
          : base.regQuery(key, args),
    });
    const result = await createOpenWithHandlers(deps).list({ filePath: FILE });
    expect(result.apps.map((app) => app.label)).toEqual(['WPS 表格', 'Microsoft Excel']);
  });
});
