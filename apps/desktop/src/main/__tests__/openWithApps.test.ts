import { describe, expect, it, vi } from 'vitest';

import {
  createOpenWithHandlers,
  decodeRegOutput,
  expandWindowsEnv,
  parseChcpCodepage,
  parseCommandLineExe,
  parseWindowsOpenCommand,
  parseRegSubkeys,
  parseRegValues,
  parseWindowsApplicationClaims,
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
    expect(expandWindowsEnv('%LOCALAPPDATA%\\a.exe', { LocalAppData: 'C:\\User' })).toBe(
      'C:\\User\\a.exe',
    );
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
    expect(
      parseRegSubkeys(
        [
          'HKEY_CLASSES_ROOT\\Applications\\Code.exe',
          'HKEY_CLASSES_ROOT\\Applications\\Code.exe\\shell',
          'HKEY_CURRENT_USER\\Applications\\Other.exe',
        ].join('\r\n'),
        'HKCR\\Applications',
      ),
    ).toEqual(['Code.exe']);
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
    expect(parseWindowsApplicationClaims(output, '.md')).toEqual({
      exeNames: ['code.exe', 'typora.exe'],
      progIds: ['Typora.md'],
    });
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
    'HKCR\\Wps.Sheet': '    (Default)    REG_SZ    WPS document type\r\n',
    'HKCR\\Applications\\wps.exe': '    FriendlyAppName    REG_SZ    WPS 表格\r\n',
  };
  const spawnDetached = vi.fn();
  const base: OpenWithDeps = {
    platform: 'win32',
    resolveFile: async (p) => ({ path: p, isFile: (overrides.fileExists ?? (() => true))(p) }),
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
  it('bounds capability queries to four concurrent subprocesses', async () => {
    let active = 0;
    let peak = 0;
    const query = vi.fn(async (key: string) => {
      if (key === 'HKCU\\Software\\RegisteredApplications') {
        return Array.from(
          { length: 30 },
          (_, i) => '    App' + i + '    REG_SZ    Software\\App' + i + '\\Capabilities',
        ).join('\r\n');
      }
      if (key.endsWith('Capabilities\\FileAssociations')) {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
      }
      return '';
    });
    await createOpenWithHandlers(makeDeps({ regQuery: query })).list({ filePath: FILE });
    expect(peak).toBe(4);
    expect(
      query.mock.calls.filter(([key]) => key.endsWith('Capabilities\\FileAssociations')),
    ).toHaveLength(30);
  });

  it('resolves SupportedTypes applications through user-level App Paths with one bulk query', async () => {
    const query = vi.fn(async (key: string) => {
      if (key === 'HKCR\\Applications')
        return [
          'HKEY_CLASSES_ROOT\\Applications\\Code.exe\\SupportedTypes',
          '    .md    REG_SZ    ',
          ...Array.from(
            { length: 100 },
            (_, i) =>
              'HKEY_CLASSES_ROOT\\Applications\\Other' +
              i +
              '.exe\\SupportedTypes\r\n    .txt    REG_SZ    ',
          ),
        ].join('\r\n');
      if (key === 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\code.exe') {
        return '    (Default)    REG_SZ    "C:\\Code\\Code.exe"';
      }
      return '';
    });
    const result = await createOpenWithHandlers(makeDeps({ regQuery: query })).list({
      filePath: 'C:\\work\\README.md',
    });
    expect(result.apps.map((app) => app.label)).toEqual(['Code']);
    expect(query).toHaveBeenCalledWith(
      'HKCR\\Applications',
      ['/s', '/f', '.md', '/e'],
      expect.any(AbortSignal),
    );
    expect(query.mock.calls.length).toBeLessThan(20);
    expect(query.mock.calls.some(([key]) => key.includes('Other'))).toBe(false);
  });

  it('bounds a stalled registry scan and degrades to a failed empty result', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(() => new Promise<string>(() => {}));
      const pending = createOpenWithHandlers(makeDeps({ regQuery: query })).list({
        filePath: FILE,
      });
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
      'HKCR\\VSCode.md': '    (Default)    REG_SZ    Markdown source file\r\n',
      'HKCR\\Applications\\Code.exe': '    FriendlyAppName    REG_SZ    Visual Studio Code\r\n',
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
    const result = await createOpenWithHandlers(
      makeDeps({
        regQuery: query,
        fileExists: (p) => p !== 'C:\\Removed\\EXCEL.EXE',
      }),
    ).list({ filePath: FILE });
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

describe('macOS local applications', () => {
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
});

describe('open-with review boundaries', () => {
  it('preserves registered editor arguments and substitutes the file as one argument', async () => {
    const base = makeDeps();
    const deps = makeDeps({
      regQuery: async (key, args) =>
        key === 'HKCR\\Applications\\EXCEL.EXE\\shell\\open\\command'
          ? '    (Default)    REG_SZ    "C:\\Office\\EXCEL.EXE" /safe --reuse-window "%1"'
          : base.regQuery(key, args),
    });
    const handlers = createOpenWithHandlers(deps);
    const result = await handlers.list({ filePath: FILE });
    await handlers.open({
      filePath: FILE,
      appId: result.apps.find((a) => a.label === 'Microsoft Excel')!.id,
    });
    expect(deps.spawnDetached).toHaveBeenCalledWith('C:\\Office\\EXCEL.EXE', [
      '/safe',
      '--reuse-window',
      FILE,
    ]);
  });
  it('does not offer commands whose file contract cannot be represented', async () => {
    const base = makeDeps();
    const handlers = createOpenWithHandlers(
      makeDeps({
        regQuery: async (key, args) =>
          key === 'HKCR\\Applications\\EXCEL.EXE\\shell\\open\\command'
            ? '    (Default)    REG_SZ    "C:\\Office\\EXCEL.EXE" /dde'
            : base.regQuery(key, args),
      }),
    );
    expect((await handlers.list({ filePath: FILE })).apps.map((a) => a.label)).not.toContain(
      'Microsoft Excel',
    );
  });
  it('binds an application reference to the file actually enumerated, not just its extension', async () => {
    const handlers = createOpenWithHandlers(makeDeps());
    const result = await handlers.list({ filePath: FILE });
    await expect(
      handlers.open({ filePath: 'C:\\work\\other.xlsx', appId: result.apps[0].id }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
  it('shares concurrent discovery for one file', async () => {
    const listMacApps = vi.fn(async () => [{ exePath: '/Applications/Code.app', label: 'Code' }]);
    const handlers = createOpenWithHandlers(makeDeps({ platform: 'darwin', listMacApps }));
    await Promise.all([
      handlers.list({ filePath: '/tmp/a.md' }),
      handlers.list({ filePath: '/tmp/a.md' }),
    ]);
    expect(listMacApps).toHaveBeenCalledOnce();
  });
  it('does not scan uninstall databases to order a file action', async () => {
    const query = vi.fn(makeDeps().regQuery);
    await createOpenWithHandlers(makeDeps({ regQuery: query })).list({ filePath: FILE });
    expect(query.mock.calls.some(([key]) => key.includes('Uninstall'))).toBe(false);
  });
  it('bounds native icon requests without dropping later applications', async () => {
    let active = 0,
      peak = 0;
    const result = await createOpenWithHandlers(
      makeDeps({
        platform: 'darwin',
        listMacApps: async () =>
          Array.from({ length: 20 }, (_, i) => ({
            exePath: '/Applications/App' + i + '.app',
            label: 'App' + i,
          })),
        getAppIcon: async () => {
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
          return null;
        },
      }),
    ).list({ filePath: '/tmp/a.md' });
    expect(result.apps).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('file identity and bounded references', () => {
  it('checks the real target and requires a regular file before discovering anything', async () => {
    const regQuery = vi.fn(async () => '');
    const blocked = createOpenWithHandlers(
      makeDeps({
        regQuery,
        isPathAllowed: (p) => p === FILE,
        resolveFile: async () => ({ path: 'C:\\Windows\\hidden.xlsx', isFile: true }),
      }),
    );
    expect((await blocked.list({ filePath: FILE })).success).toBe(false);
    expect(regQuery).not.toHaveBeenCalled();
    expect(
      (
        await createOpenWithHandlers(
          makeDeps({
            resolveFile: async (p) => ({ path: p, isFile: false }),
          }),
        ).list({ filePath: FILE })
      ).success,
    ).toBe(false);
  });
  it('rechecks permission on open and rejects a symlink retargeted after enumeration', async () => {
    let target = FILE;
    let allowed = true;
    const deps = makeDeps({
      isPathAllowed: () => allowed,
      resolveFile: async () => ({ path: target, isFile: true }),
    });
    const handlers = createOpenWithHandlers(deps);
    const { apps } = await handlers.list({ filePath: FILE });
    target = 'C:\\work\\different.xlsx';
    await expect(handlers.open({ filePath: FILE, appId: apps[0].id })).rejects.toThrow(/NOT_FOUND/);
    target = FILE;
    allowed = false;
    await expect(handlers.open({ filePath: FILE, appId: apps[0].id })).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });
  it('keeps another file menu valid and expires old references', async () => {
    let now = 0;
    const handlers = createOpenWithHandlers(makeDeps({ now: () => now }));
    const result = await handlers.list({ filePath: FILE });
    await handlers.list({ filePath: 'C:\\work\\other.xlsx' });
    await expect(
      handlers.open({ filePath: FILE, appId: result.apps[0].id }),
    ).resolves.toBeUndefined();
    now = 60001;
    await expect(handlers.open({ filePath: FILE, appId: result.apps[0].id })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
  it('evicts old file references rather than growing without a bound', async () => {
    const handlers = createOpenWithHandlers(makeDeps({ now: () => 0 }));
    const result = await handlers.list({ filePath: FILE });
    for (let i = 0; i < 64; i++) await handlers.list({ filePath: 'C:\\work\\file' + i + '.xlsx' });
    await expect(handlers.open({ filePath: FILE, appId: result.apps[0].id })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
  it('returns failure for malformed IPC payloads without discovery or launch', async () => {
    const deps = makeDeps({ regQuery: vi.fn(async () => '') });
    const handlers = createOpenWithHandlers(deps);
    for (const params of [null, undefined, {}, { filePath: FILE + '\0' }]) {
      expect((await handlers.list(params as never)).success).toBe(false);
      await expect(handlers.open(params as never)).rejects.toThrow();
    }
    expect(deps.regQuery).not.toHaveBeenCalled();
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });
  it('retains all choices but limits native icon work to the first 32', async () => {
    const getAppIcon = vi.fn(async () => null);
    const handlers = createOpenWithHandlers(
      makeDeps({
        platform: 'darwin',
        getAppIcon,
        listMacApps: async () =>
          Array.from({ length: 100 }, (_, i) => ({
            exePath: '/Applications/App' + i + '.app',
            label: 'App' + i,
          })),
      }),
    );
    expect((await handlers.list({ filePath: '/tmp/a.md' })).apps).toHaveLength(100);
    expect(getAppIcon).toHaveBeenCalledTimes(32);
  });
});

describe('Windows document command contract', () => {
  it.each([
    [
      String.raw`"C:\Apps\editor.exe" "say ""hello""" "%1"`,
      { exePath: 'C:\\Apps\\editor.exe', args: ['say "hello"', '%1'] },
    ],
    [
      String.raw`"C:\Apps\editor.exe" "say \"hello\"" "%1"`,
      { exePath: 'C:\\Apps\\editor.exe', args: ['say "hello"', '%1'] },
    ],
    [
      '"C:\\Apps\\editor.exe" --reuse-window "%1"',
      { exePath: 'C:\\Apps\\editor.exe', args: ['--reuse-window', '%1'] },
    ],
    [
      '"C:\\Apps\\editor.exe" "%L" /read',
      { exePath: 'C:\\Apps\\editor.exe', args: ['%L', '/read'] },
    ],
    ['"C:\\Apps\\editor.exe" /dde', null],
    ['"C:\\Apps\\editor.exe" --file=%1', null],
    ['"C:\\Apps\\editor.exe" "%1" %2', null],
    ['"C:\\Apps\\editor.exe" "%1', null],
    ['"C:\\Windows\\cmd.exe" /c "%1"', null],
  ])('parses or explicitly rejects %s', (command, expected) => {
    expect(parseWindowsOpenCommand(command as string)).toEqual(expected);
  });
});

it('finds capability-only ProgIds without an Applications command or App Paths fallback', async () => {
  const registry: Record<string, string> = {
    'HKCR\\Applications':
      'HKEY_CLASSES_ROOT\\Applications\\Editor.exe\\Capabilities\\FileAssociations\n    .md    REG_SZ    Editor.Markdown',
    'HKCR\\Editor.Markdown\\shell\\open\\command':
      '    (Default)    REG_SZ    "C:\\Editor\\Editor.exe" --markdown "%1"',
    'HKCR\\Editor.Markdown': '    (Default)    REG_SZ    Markdown document',
  };
  const deps = makeDeps({ regQuery: async (key) => registry[key] ?? '' });
  const handlers = createOpenWithHandlers(deps);
  const result = await handlers.list({ filePath: 'C:\\work\\README.md' });
  expect(result.apps.map((app) => app.label)).toContain('Editor');
  await handlers.open({ filePath: 'C:\\work\\README.md', appId: result.apps[0].id });
  expect(deps.spawnDetached).toHaveBeenCalledWith('C:\\Editor\\Editor.exe', [
    '--markdown',
    'C:\\work\\README.md',
  ]);
});

it('prefers the extension-specific ProgId arguments over a generic exe association', async () => {
  const base = makeDeps();
  const deps = makeDeps({ regQuery: async (key, args) => {
    if (key === 'HKCR\\.xlsx') return '    (Default)    REG_SZ    Excel.Specific';
    if (key === 'HKCR\\Excel.Specific\\shell\\open\\command') return '    (Default)    REG_SZ    "C:\\Office\\EXCEL.EXE" /spreadsheet "%1"';
    return base.regQuery(key, args);
  }});
  const handlers = createOpenWithHandlers(deps);
  const result = await handlers.list({filePath:FILE});
  await handlers.open({filePath:FILE, appId:result.apps.find(app => app.label === 'Microsoft Excel')!.id});
  expect(deps.spawnDetached).toHaveBeenCalledWith('C:\\Office\\EXCEL.EXE', ['/spreadsheet', FILE]);
});
