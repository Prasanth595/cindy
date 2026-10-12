/**
 * openWithApps — 聊天文件 chip 右键「打开方式」的 main 侧能力。
 * ---------------------------------------------------------------------------
 * 两个动作:
 *   - list:查询当前文件可用的本地应用，按最近使用/安装时间排序。
 *     macOS 使用 NSWorkspace + Spotlight；Windows 使用文件关联/安装注册表。
 *   - open:只允许通过 main 侧枚举的应用 ID 打开文件。
 *
 * 安全设计(electron-security §5「IPC 是授权边界」):
 *   - renderer 只能回传 **appId**,不能传可执行路径。appId → exe 的映射只存在
 *     main 侧 per-扩展名缓存里,由本模块自己的枚举写入;open 时反查不到即拒绝。
 *     「renderer 递来一个绝对路径就执行」在结构上不可表达。
 *   - 待打开的文件路径每次都重新过绝对路径 + isPathAllowed + 存在性校验。
 *   - 枚举里剔除宿主进程(rundll32 等)——它们不是"应用",且可被用作参数注入
 *     的跳板。
 *
 * Windows 枚举口径(reg.exe query,零原生依赖):
 *   HKCU FileExts\<ext>\OpenWithList(MRU)∪ HKCR/HKCU <ext>\OpenWithProgids
 *   → exe 引用经 HKCR\Applications\<exe> / HKLM App Paths 解析,ProgId 经
 *   HKCR\<ProgId>\shell\open\command 解析 → 去重、验存在。UWP/MSIX 应用不在
 *   这些键下，属既有枚举盲区，不额外增加菜单入口。
 *
 * 错误协议(engineering-conventions §2):list 是查询型,失败仍要渲染菜单其余
 * 项 → `{ success, apps }` 模式;open 是动作型 → throwIpcError。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { OpenWithUsage } from './openWithUsage.js';

import { throwIpcError } from './utils/ipcValidate.js';

export interface OpenWithApp {
  /** 稳定应用身份；renderer 原样回传，main 只认当前枚举的映射。 */
  id: string;
  label: string;
  /** app.getFileIcon 提取的 dataURL;提取失败缺省,renderer 显示通用图标。 */
  iconDataUrl?: string;
}

export interface ListOpenWithAppsResult {
  success: boolean;
  apps: OpenWithApp[];
  error?: string;
}

export interface OpenWithDeps {
  platform: NodeJS.Platform;
  isPathAllowed(absPath: string): boolean;
  fileExists(absPath: string): boolean;
  /**
   * `reg.exe query` 包装(仅 Windows 用)。返回 stdout;键不存在等查询失败按
   * 空 stdout 处理(reg.exe 对 not-found 返回非 0,包装层不抛)。
   */
  regQuery(keyPath: string, args?: string[]): Promise<string>;
  /** 应用图标 dataURL;实现方必须自带超时防护(app.getFileIcon 会挂死,见 fileThumbnail.ts)。 */
  getAppIcon(exePath: string): Promise<string | null>;
  /** detached + unref 起进程;不回传输出。 */
  spawnDetached(command: string, args: string[]): void | Promise<void>;
  /** macOS 的 NSWorkspace 查询，由 bootstrap 注入；不把应用路径暴露给 renderer。 */
  listMacApps?(filePath: string): Promise<ResolvedOpenWithApp[]>;
  usage?: OpenWithUsage;
  now?(): number;
  onUsageError?(): void;
}

export interface OpenWithHandlers {
  list(params: { filePath: string }): Promise<ListOpenWithAppsResult>;
  open(params: { filePath: string; appId: string }): Promise<void>;
}

/** 宿主/中转进程不作为「应用」列出(也避免被当作参数注入跳板)。 */
const HOST_EXE_DENYLIST = new Set([
  'rundll32.exe',
  'dllhost.exe',
  'openwith.exe',
  'explorer.exe',
  'cmd.exe',
  'powershell.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
]);

/** REG_EXPAND_SZ 的 `%SystemRoot%` 等环境变量引用展开;未定义的原样保留。 */
export function expandWindowsEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(
    /%([^%]+)%/g,
    (raw, name: string) => env[name] ?? env[name.toUpperCase()] ?? raw,
  );
}

/** `"C:\x\a.exe" %1` / `C:\x\a.exe %1` → exe 路径;解析不出回 null。 */
export function parseCommandLineExe(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : null;
  }
  // 无引号形态:exe 路径可能含空格(老注册表项),按 `.exe` 边界截。
  const m = trimmed.match(/^(.*?\.exe)(?=\s|$)/i);
  return m ? m[1] : (trimmed.split(/\s+/)[0] ?? null);
}

/**
 * Windows 控制台代码页 → WHATWG TextDecoder label。reg.exe 重定向输出用的是
 * 控制台代码页(中文系统 936/GBK)而非 UTF-8,直接按 UTF-8 解码会把中文应用名
 * 变成 U+FFFD。只映射 TextDecoder 支持的常见页;OEM 437/850 等西文页不在
 * TextDecoder 支持面内,回落 UTF-8(ASCII 部分不受影响)。
 */
const CODEPAGE_DECODER_LABELS: Record<number, string> = {
  932: 'shift_jis',
  936: 'gb18030',
  949: 'euc-kr',
  950: 'big5',
  866: 'ibm866',
  874: 'windows-874',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  65001: 'utf-8',
};

/** `chcp` 输出(如 `活动代码页: 936` / `Active code page: 437`)→ 代码页号。 */
export function parseChcpCodepage(stdout: string): number | null {
  const digits = stdout.match(/\d+/g)?.pop();
  return digits ? Number(digits) : null;
}

/** reg.exe 原始 stdout 字节 → 字符串;代码页未知或不支持时回落 UTF-8。 */
export function decodeRegOutput(data: Uint8Array, codepage: number | null): string {
  const label = (codepage != null && CODEPAGE_DECODER_LABELS[codepage]) || 'utf-8';
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

/** reg.exe query 输出 → 该键下的值列表(name + REG_SZ data)。 */
export function parseRegValues(stdout: string): Array<{ name: string; data: string }> {
  const out: Array<{ name: string; data: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    // 形如 `    a    REG_SZ    Excel.exe`(data 可含空格)。
    const m = line.match(/^\s{2,}(\S(?:.*?\S)?)\s+(REG_[A-Z_]+)\s+(.*)$/);
    if (m) out.push({ name: m[1], data: m[3].trim() });
  }
  return out;
}

/** reg.exe query 输出 → 子键名列表(完整行是键路径,取末段)。 */
export function parseRegSubkeys(stdout: string, parentKey: string): string[] {
  const prefix = parentKey.replace(/\\+$/, '').toLowerCase() + '\\';
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t.toLowerCase().startsWith(prefix)) out.push(t.slice(prefix.length));
  }
  return out;
}

/** 只采用 Windows 安装器明确提供的 InstallDate，不使用 exe mtime/birthtime。 */
export function parseWindowsInstalledApps(
  stdout: string,
): Array<{ location?: string; icon?: string; installedAt: number }> {
  const result: Array<{ location?: string; icon?: string; installedAt: number }> = [];
  const sections = stdout.split(/(?=^HKEY_)/m);
  for (const section of sections) {
    const values = new Map(parseRegValues(section).map((v) => [v.name.toLowerCase(), v.data]));
    const date = values.get('installdate');
    if (!date || !/^\d{8}$/.test(date)) continue;
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    const installedAt = Date.UTC(year, month - 1, day);
    const parsed = new Date(installedAt);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    )
      continue;
    const location = values.get('installlocation');
    const displayIcon = values.get('displayicon');
    const icon = displayIcon
      ? (parseCommandLineExe(displayIcon.replace(/,\s*-?\d+$/, '')) ?? undefined)
      : undefined;
    if (location || icon) result.push({ location, icon, installedAt });
  }
  return result;
}

export interface ResolvedOpenWithApp {
  /** Windows 可执行文件；macOS .app bundle。只在 main 内流转。 */
  exePath: string;
  label: string;
  lastUsedAt?: number;
  installedAt?: number;
  /** Windows MRU 仅给相对次序，不能伪装成最近使用时间。 */
  recentOrder?: number;
}

export function createOpenWithHandlers(deps: OpenWithDeps): OpenWithHandlers {
  // 该模块是可注入 platform 的纯函数,单测会在 Linux runner 模拟 win32。
  // 路径语义必须跟 deps.platform 走,不能跟测试宿主的 process.platform 走。
  const platformPath = deps.platform === 'win32' ? path.win32 : path.posix;
  // ext → (appId → exePath)。每次 list 整体重建该 ext 的映射;open 只认最近
  // 一次枚举写入的 id。进程内存态即可——菜单打开到点击是同进程短会话。
  const appCacheByExt = new Map<string, Map<string, string>>();
  const appKey = (appPath: string): string =>
    deps.platform === 'win32' ? appPath.toLowerCase() : appPath;

  function assertOpenableFile(filePath: string): void {
    if (typeof filePath !== 'string' || !platformPath.isAbsolute(filePath)) {
      throwIpcError('INVALID_PARAMS', 'filePath must be absolute');
    }
    if (!deps.isPathAllowed(filePath)) {
      throwIpcError('PERMISSION_DENIED', '不允许访问该路径');
    }
    if (!deps.fileExists(filePath)) {
      throwIpcError('NOT_FOUND', '文件不存在');
    }
  }

  /** exe 名引用(`Excel.exe`)→ 完整路径 + 友好名。 */
  async function resolveExeReference(exeName: string): Promise<ResolvedOpenWithApp | null> {
    const appKey = `HKCR\\Applications\\${exeName}`;
    const cmdOut = await deps.regQuery(`${appKey}\\shell\\open\\command`, ['/ve']);
    let exePath = parseCommandLineExe(parseRegValues(cmdOut)[0]?.data ?? '');
    if (!exePath) {
      const appPathsOut = await deps.regQuery(
        `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
        ['/ve'],
      );
      exePath = parseRegValues(appPathsOut)[0]?.data?.trim() || null;
    }
    if (exePath) exePath = expandWindowsEnv(exePath, process.env);
    if (!exePath || !deps.fileExists(exePath)) return null;

    const friendlyOut = await deps.regQuery(appKey, ['/v', 'FriendlyAppName']);
    const friendly = parseRegValues(friendlyOut)[0]?.data;
    // `@resource.dll,-123` 形态的本地化引用没有免原生的解法,回落 exe 名。
    const label =
      friendly && !friendly.startsWith('@')
        ? friendly
        : platformPath.basename(exePath, platformPath.extname(exePath));
    return { exePath, label };
  }

  /** ProgId 引用 → 完整路径 + 友好名。 */
  async function resolveProgIdReference(progId: string): Promise<ResolvedOpenWithApp | null> {
    const cmdOut = await deps.regQuery(`HKCR\\${progId}\\shell\\open\\command`, ['/ve']);
    const parsed = parseCommandLineExe(parseRegValues(cmdOut)[0]?.data ?? '');
    const exePath = parsed ? expandWindowsEnv(parsed, process.env) : null;
    if (!exePath || !deps.fileExists(exePath)) return null;

    const nameOut = await deps.regQuery(`HKCR\\${progId}`, ['/ve']);
    const friendly = parseRegValues(nameOut)[0]?.data;
    const label =
      friendly && !friendly.startsWith('@')
        ? friendly
        : platformPath.basename(exePath, platformPath.extname(exePath));
    return { exePath, label };
  }

  async function listWindowsApps(ext: string): Promise<ResolvedOpenWithApp[]> {
    const fileExtsKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}`;

    const exeNames = new Set<string>();
    const progIds = new Set<string>();

    const mruOut = await deps.regQuery(`${fileExtsKey}\\OpenWithList`);
    const mruValues = parseRegValues(mruOut);
    const mru = mruValues.find((v) => v.name.toLowerCase() === 'mrulist')?.data ?? '';
    const recentExeNames = [...mru]
      .map((key) => mruValues.find((v) => v.name === key)?.data)
      .filter((value): value is string => !!value && /\.exe$/i.test(value));
    for (const exe of recentExeNames) exeNames.add(exe);
    for (const v of mruValues) {
      if (v.name.toLowerCase() !== 'mrulist' && /\.exe$/i.test(v.data)) exeNames.add(v.data);
    }
    const hkcrListKey = `HKCR\\${ext}\\OpenWithList`;
    for (const sub of parseRegSubkeys(await deps.regQuery(hkcrListKey), hkcrListKey)) {
      if (/\.exe$/i.test(sub)) exeNames.add(sub);
    }
    for (const src of [`${fileExtsKey}\\OpenWithProgids`, `HKCR\\${ext}\\OpenWithProgids`]) {
      for (const v of parseRegValues(await deps.regQuery(src))) {
        if (v.name && v.name !== '(Default)') progIds.add(v.name);
      }
    }
    // 扩展名默认 ProgId 也入列(它对应的应用不一定出现在 OpenWith* 里)。
    const defaultProgId = parseRegValues(await deps.regQuery(`HKCR\\${ext}`, ['/ve']))[0]?.data;
    if (defaultProgId) progIds.add(defaultProgId);

    const seen = new Set<string>();
    const apps: ResolvedOpenWithApp[] = [];
    const push = (r: ResolvedOpenWithApp | null): void => {
      if (!r) return;
      if (HOST_EXE_DENYLIST.has(platformPath.basename(r.exePath).toLowerCase())) return;
      const key = appKey(r.exePath);
      if (seen.has(key)) return;
      seen.add(key);
      apps.push(r);
    };
    for (const exe of exeNames) {
      push(await resolveExeReference(exe));
    }
    for (const progId of progIds) {
      push(await resolveProgIdReference(progId));
    }
    // 系统 MRU 仅在没有可比较时间时作为排序依据；不拿扫描时间替代使用时间。
    for (const app of apps) {
      const index = recentExeNames.findIndex(
        (exe) => exe.toLowerCase() === platformPath.basename(app.exePath).toLowerCase(),
      );
      if (index >= 0) app.recentOrder = index;
    }
    const uninstallRoots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    const installData = await Promise.all(
      uninstallRoots.map((root) => deps.regQuery(root, ['/s'])),
    );
    for (const stdout of installData) {
      for (const entry of parseWindowsInstalledApps(stdout)) {
        for (const app of apps) {
          const appPath = appKey(platformPath.normalize(app.exePath));
          const location = entry.location
            ? appKey(platformPath.normalize(entry.location)).replace(/\\+$/, '')
            : '';
          const icon = entry.icon ? appKey(platformPath.normalize(entry.icon)) : '';
          if ((location && appPath.startsWith(location + '\\')) || icon === appPath) {
            app.installedAt = Math.max(app.installedAt ?? 0, entry.installedAt);
          }
        }
      }
    }
    return apps;
  }

  return {
    async list({ filePath }) {
      try {
        assertOpenableFile(filePath);
      } catch (err) {
        return {
          success: false,
          apps: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const ext = platformPath.extname(filePath).toLowerCase();
      if (!ext) return { success: true, apps: [] };
      try {
        const resolved =
          deps.platform === 'darwin'
            ? ((await deps.listMacApps?.(filePath)) ?? [])
            : deps.platform === 'win32'
              ? await listWindowsApps(ext)
              : [];
        const now = (deps.now ?? Date.now)();
        const timestamp = (value: number | undefined): number =>
          value !== undefined && Number.isFinite(value) && value > 0 && value <= now ? value : 0;
        const seen = new Set<string>();
        const ranked = resolved
          .filter((entry) => {
            if (!deps.fileExists(entry.exePath) || !platformPath.isAbsolute(entry.exePath))
              return false;
            const key = appKey(entry.exePath);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((entry) => ({
            entry,
            recency: Math.max(
              timestamp(entry.lastUsedAt),
              timestamp(entry.installedAt),
              timestamp(deps.usage?.getLastUsed(appKey(entry.exePath))),
            ),
          }));
        ranked.sort(
          (a, b) =>
            b.recency - a.recency ||
            (a.entry.recentOrder ?? Infinity) - (b.entry.recentOrder ?? Infinity) ||
            a.entry.label.localeCompare(b.entry.label) ||
            appKey(a.entry.exePath).localeCompare(appKey(b.entry.exePath)),
        );
        const idMap = new Map<string, string>();
        // 不截掉第 12 个以后的应用。图标查询由 bootstrap 的超时/缓存约束。
        const apps: OpenWithApp[] = await Promise.all(
          ranked.map(async ({ entry }) => {
            // ID 基于应用身份而非数组下标；重排不能让旧点击指向另一应用。
            const id = 'owa-' + createHash('sha256').update(appKey(entry.exePath)).digest('hex');
            idMap.set(id, entry.exePath);
            const iconDataUrl =
              (await deps.getAppIcon(entry.exePath).catch(() => null)) ?? undefined;
            return { id, label: entry.label, ...(iconDataUrl ? { iconDataUrl } : {}) };
          }),
        );
        appCacheByExt.set(ext, idMap);
        return { success: true, apps };
      } catch {
        return { success: false, apps: [], error: '无法查询可用应用' };
      }
    },

    async open({ filePath, appId }) {
      assertOpenableFile(filePath);
      if (typeof appId !== 'string' || !appId) throwIpcError('INVALID_PARAMS', 'appId required');
      const ext = platformPath.extname(filePath).toLowerCase();
      // 只认 main 侧最近一次枚举写入的映射——查不到一律拒绝,绝不把 renderer
      // 提供的任何字符串当路径执行。
      const exePath = appCacheByExt.get(ext)?.get(appId);
      if (!exePath) throwIpcError('NOT_FOUND', '应用引用已失效,请重新打开菜单');
      if (!deps.fileExists(exePath)) throwIpcError('NOT_FOUND', '应用不存在');
      if (deps.platform === 'darwin') {
        await deps.spawnDetached('/usr/bin/open', ['-a', exePath, '--', filePath]);
      } else {
        await deps.spawnDetached(exePath, [filePath]);
      }
      try {
        deps.usage?.recordUsed(appKey(exePath), (deps.now ?? Date.now)());
      } catch {
        deps.onUsageError?.();
      }
    },
  };
}
