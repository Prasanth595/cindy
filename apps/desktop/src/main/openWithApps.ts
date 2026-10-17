/** Local application discovery and one-time opening for Desktop file references.
 * Windows reads explicit file association registrations; macOS asks NSWorkspace.
 * No filesystem application crawl, install-date scan, persisted usage or default
 * association changes. Renderer supplies an opaque application ID, never an exe.
 * IDs are bound to a validated real file and expire; file permissions are rechecked
 * before launching. Registry argv is preserved without invoking a shell.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

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
  regQuery(keyPath: string, args?: string[], signal?: AbortSignal): Promise<string>;
  /** 应用图标 dataURL;实现方必须自带超时防护(app.getFileIcon 会挂死,见 fileThumbnail.ts)。 */
  getAppIcon(exePath: string): Promise<string | null>;
  /** detached + unref 起进程;不回传输出。 */
  spawnDetached(command: string, args: string[]): void | Promise<void>;
  /** macOS 的 NSWorkspace 查询，由 bootstrap 注入；不把应用路径暴露给 renderer。 */
  listMacApps?(filePath: string): Promise<ResolvedOpenWithApp[]>;
  resolveFile(filePath: string): Promise<{ path: string; isFile: boolean }>;
  now?(): number;
  onDiscoveryError?(): void;
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
    (raw, name: string) =>
      env[name] ??
      Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ??
      raw,
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

/** Decode Windows quoting without a shell. Unknown/embedded document placeholders
 * and DDE-only commands are omitted rather than launched with a different contract. */
export function parseWindowsOpenCommand(
  command: string,
): { exePath: string; args: string[] } | null {
  if (!command || command.length > 32768 || /[\0\r\n]/.test(command)) return null;
  const tokens: string[] = [];
  let token = '',
    quoted = false,
    started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (!quoted && /\s/.test(ch)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    started = true;
    if (ch === '\\') {
      let count = 1;
      while (command[i + 1] === '\\') {
        count++;
        i++;
      }
      if (command[i + 1] === '"') {
        token += '\\'.repeat(Math.floor(count / 2));
        i++;
        if (count % 2) token += '"';
        else if (quoted && command[i + 1] === '"') {
          token += '"';
          i++;
        } else quoted = !quoted;
      } else token += '\\'.repeat(count);
    } else if (ch === '"') {
      if (quoted && command[i + 1] === '"') {
        token += '"';
        i++;
      } else quoted = !quoted;
    }
    else token += ch;
  }
  if (quoted) return null;
  if (started) tokens.push(token);
  const exePath = tokens.shift();
  if (!exePath || !/\.exe$/i.test(exePath)) return null;
  if (HOST_EXE_DENYLIST.has(path.win32.basename(exePath).toLowerCase())) return null;
  const args = tokens;
  if (!args.length) args.push('%1');
  if (!args.some((arg) => /^%(?:1|l|v|\*)$/i.test(arg))) return null;
  if (
    args.some((arg) => /%(?:[0-9*]|[lLvV](?![a-zA-Z_]))/.test(arg) && !/^%(?:1|l|v|\*)$/i.test(arg))
  )
    return null;
  return { exePath, args };
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
    const m = line.match(/^\s{2,}(\S(?:.*?\S)?)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/);
    if (m) out.push({ name: m[1], data: (m[3] ?? '').trim() });
  }
  return out;
}

/** reg.exe query 输出 → 子键名列表(完整行是键路径,取末段)。 */
export function normalizeRegistryKey(key: string): string {
  const hives: Record<string, string> = {
    hkcr: 'hkey_classes_root',
    hkcu: 'hkey_current_user',
    hklm: 'hkey_local_machine',
  };
  return key
    .replace(/\\+$/, '')
    .toLowerCase()
    .replace(/^[^\\]+/, (hive) => hives[hive] ?? hive);
}

export function parseRegSubkeys(stdout: string, parentKey: string): string[] {
  // reg.exe expands HKCR/HKCU/HKLM aliases in real output.
  const prefix = normalizeRegistryKey(parentKey) + '\\';
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    const key = normalizeRegistryKey(t);
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes('\\')) {
      out.push(t.slice(t.lastIndexOf('\\') + 1));
    }
  }
  return out;
}

/** Accept only explicit extension claims in these two Windows application contracts. */
export function parseWindowsApplicationClaims(
  stdout: string,
  ext: string,
): { exeNames: string[]; progIds: string[] } {
  const names = new Set<string>();
  const progIds = new Set<string>();
  for (const section of stdout.split(/(?=^HKEY_|^HK(?:CR|CU|LM)\\)/m)) {
    const key = normalizeRegistryKey(section.split(/\r?\n/)[0].trim());
    const match = key.match(
      /^hkey_classes_root\\applications\\([^\\]+\.exe)\\(?:capabilities\\fileassociations|supportedtypes)$/,
    );
    if (match && parseRegValues(section).some((v) => v.name.toLowerCase() === ext)) {
      names.add(match[1]);
      if (key.endsWith('capabilities\\fileassociations')) {
        for (const row of parseRegValues(section)) {
          if (row.name.toLowerCase() === ext && row.data) progIds.add(row.data);
        }
      }
    }
  }
  return { exeNames: [...names], progIds: [...progIds] };
}

/** Keep registry subprocess concurrency bounded even on hosts with many installed apps. */
async function mapRegistryItems<T, R>(items: T[], resolve: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await resolve(items[index]);
      }
    }),
  );
  return results;
}

export interface ResolvedOpenWithApp {
  /** Windows 可执行文件；macOS .app bundle。只在 main 内流转。 */
  exePath: string;
  label: string;
  args?: string[];
  /** Windows MRU 仅给相对次序，不能伪装成最近使用时间。 */
  recentOrder?: number;
}

export function createOpenWithHandlers(deps: OpenWithDeps): OpenWithHandlers {
  // 该模块是可注入 platform 的纯函数,单测会在 Linux runner 模拟 win32。
  // 路径语义必须跟 deps.platform 走,不能跟测试宿主的 process.platform 走。
  const platformPath = deps.platform === 'win32' ? path.win32 : path.posix;
  // 按真实文件保存短期、有界应用引用；其他窗口查询不会覆盖当前文件。
  const appCacheByFile = new Map<
    string,
    { expires: number; apps: Map<string, ResolvedOpenWithApp> }
  >();
  const pending = new Map<string, Promise<ListOpenWithAppsResult>>();
  let discoveryTail: Promise<unknown> = Promise.resolve();
  const now = deps.now ?? Date.now;
  const prune = () => {
    for (const [key, value] of appCacheByFile)
      if (value.expires <= now()) appCacheByFile.delete(key);
    while (appCacheByFile.size > 64) appCacheByFile.delete(appCacheByFile.keys().next().value!);
  };
  const appKey = (appPath: string): string =>
    deps.platform === 'win32' ? appPath.toLowerCase() : appPath;

  async function assertOpenableFile(filePath: string): Promise<string> {
    if (
      typeof filePath !== 'string' ||
      filePath.length > 32768 ||
      filePath.includes('\0') ||
      !platformPath.isAbsolute(filePath)
    ) {
      throwIpcError('INVALID_PARAMS', 'filePath must be absolute');
    }
    if (!deps.isPathAllowed(filePath)) {
      throwIpcError('PERMISSION_DENIED', '不允许访问该路径');
    }
    const resolved = await deps.resolveFile(filePath).catch(() => null);
    if (!resolved) throwIpcError('NOT_FOUND', '文件不存在');
    if (!resolved!.isFile) throwIpcError('INVALID_PARAMS', '目标必须是文件');
    if (!deps.isPathAllowed(resolved!.path)) throwIpcError('PERMISSION_DENIED', '不允许访问该路径');
    return platformPath.normalize(resolved!.path);
  }

  /** exe 名引用(`Excel.exe`)→ 完整路径 + 友好名。 */
  async function resolveExeReference(
    exeName: string,
    query = deps.regQuery,
  ): Promise<ResolvedOpenWithApp | null> {
    const appKey = `HKCR\\Applications\\${exeName}`;
    const cmdOut = await query(`${appKey}\\shell\\open\\command`, ['/ve']);
    const command = parseRegValues(cmdOut)[0]?.data;
    const parsedCommand = command ? parseWindowsOpenCommand(command) : null;
    if (command && !parsedCommand) return null;
    let exePath = parsedCommand?.exePath ?? null;
    if (exePath) exePath = expandWindowsEnv(exePath, process.env);
    if (!exePath || !platformPath.isAbsolute(exePath) || !deps.fileExists(exePath)) {
      exePath = null;
      for (const hive of ['HKCU', 'HKLM']) {
        const appPathsOut = await query(
          `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
          ['/ve'],
        );
        const parsed = parseCommandLineExe(parseRegValues(appPathsOut)[0]?.data ?? '');
        const candidate = parsed ? expandWindowsEnv(parsed, process.env) : null;
        if (candidate && platformPath.isAbsolute(candidate) && deps.fileExists(candidate)) {
          exePath = candidate;
          break;
        }
      }
    }
    if (!exePath || !/\.exe$/i.test(exePath) || !deps.fileExists(exePath)) return null;

    const friendlyOut = await query(appKey, ['/v', 'FriendlyAppName']);
    const friendly = parseRegValues(friendlyOut)[0]?.data;
    // `@resource.dll,-123` 形态的本地化引用没有免原生的解法,回落 exe 名。
    const label =
      friendly && !friendly.startsWith('@')
        ? friendly
        : platformPath.basename(exePath, platformPath.extname(exePath));
    return { exePath, label, args: parsedCommand?.args ?? ['%1'] };
  }

  /** ProgId 引用 → 完整路径 + 友好名。 */
  async function resolveProgIdReference(
    progId: string,
    query = deps.regQuery,
  ): Promise<ResolvedOpenWithApp | null> {
    const cmdOut = await query(`HKCR\\${progId}\\shell\\open\\command`, ['/ve']);
    const parsedCommand = parseWindowsOpenCommand(parseRegValues(cmdOut)[0]?.data ?? '');
    if (!parsedCommand) return null;
    const exePath = expandWindowsEnv(parsedCommand.exePath, process.env);
    if (!platformPath.isAbsolute(exePath) || !/\.exe$/i.test(exePath) || !deps.fileExists(exePath))
      return null;

    const nameOut = await query(`HKCR\\Applications\\${platformPath.basename(exePath)}`, [
      '/v',
      'FriendlyAppName',
    ]);
    const friendly = parseRegValues(nameOut)[0]?.data;
    const label =
      friendly && !friendly.startsWith('@')
        ? friendly
        : platformPath.basename(exePath, platformPath.extname(exePath));
    return { exePath, label, args: parsedCommand.args };
  }

  async function listWindowsApps(ext: string): Promise<ResolvedOpenWithApp[]> {
    // Bound the entire discovery, not just each individual reg.exe process.
    const deadline = Date.now() + 8000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const query: OpenWithDeps['regQuery'] = async (key, args) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Registry discovery timed out');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          deps.regQuery(key, args, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Registry discovery timed out')), remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      const fileExtsKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}`;

      const exeNames = new Set<string>();
      const progIds = new Set<string>();

      const mruOut = await query(`${fileExtsKey}\\OpenWithList`);
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
      for (const sub of parseRegSubkeys(await query(hkcrListKey), hkcrListKey)) {
        if (/\.exe$/i.test(sub)) exeNames.add(sub);
      }
      for (const src of [`${fileExtsKey}\\OpenWithProgids`, `HKCR\\${ext}\\OpenWithProgids`]) {
        for (const v of parseRegValues(await query(src))) {
          if (v.name && v.name !== '(Default)') progIds.add(v.name);
        }
      }
      // 扩展名默认 ProgId 也入列(它对应的应用不一定出现在 OpenWith* 里)。
      const defaultProgId = parseRegValues(await query(`HKCR\\${ext}`, ['/ve']))[0]?.data;
      if (defaultProgId) progIds.add(defaultProgId);

      // Editors such as VS Code often advertise Markdown through the Windows
      // RegisteredApplications/Capabilities contract instead of OpenWithList.
      const registrations = await Promise.all(
        ['HKCU', 'HKLM'].map(async (hive) => {
          const values = parseRegValues(await query(`${hive}\\Software\\RegisteredApplications`));
          // A relative Capabilities path belongs to the hive owning this registration.
          return values
            .filter((v) => v.data)
            .map((v) =>
              /^(?:HK(?:CU|LM|CR)|HKEY_(?:CURRENT_USER|LOCAL_MACHINE|CLASSES_ROOT))\\/i.test(v.data)
                ? v.data
                : `${hive}\\${v.data}`,
            );
        }),
      );
      const associations = await mapRegistryItems([...new Set(registrations.flat())], (key) =>
        query(`${key}\\FileAssociations`),
      );
      for (const stdout of associations) {
        for (const association of parseRegValues(stdout)) {
          if (association.name.toLowerCase() === ext && association.data)
            progIds.add(association.data);
        }
      }

      // Per-user installers may register Capabilities under Applications without
      // adding RegisteredApplications. Only accept an explicit extension claim.
      // One exact filtered recursive query replaces two processes per installed app.
      const claims = parseWindowsApplicationClaims(
        await query('HKCR\\Applications', ['/s', '/f', ext, '/e']),
        ext,
      );
      for (const exeName of claims.exeNames) exeNames.add(exeName);
      for (const progId of claims.progIds) progIds.add(progId);

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
      for (const app of await mapRegistryItems([...progIds], (name) =>
        resolveProgIdReference(name, query),
      ))
        push(app);
      for (const app of await mapRegistryItems([...exeNames], (name) =>
        resolveExeReference(name, query),
      ))
        push(app);
      // 系统 MRU 仅表示相对顺序；不与安装日期或伪造的绝对时间混排。
      for (const app of apps) {
        const index = recentExeNames.findIndex(
          (exe) => exe.toLowerCase() === platformPath.basename(app.exePath).toLowerCase(),
        );
        if (index >= 0) app.recentOrder = index;
      }
      return apps;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async function discover(filePath: string): Promise<ListOpenWithAppsResult> {
    const ext = platformPath.extname(filePath).toLowerCase();
    if (deps.platform !== 'darwin' && (!ext || !/^\.[\p{L}\p{N}_+-]{1,64}$/u.test(ext)))
      return { success: true, apps: [] };
    try {
      if (!deps.isPathAllowed(filePath)) throw new Error('permission revoked');
      const resolved =
        deps.platform === 'darwin'
          ? ((await deps.listMacApps?.(filePath)) ?? [])
          : deps.platform === 'win32'
            ? await listWindowsApps(ext)
            : [];
      const seen = new Set<string>();
      const ranked = resolved.filter((entry) => {
        if (!deps.fileExists(entry.exePath) || !platformPath.isAbsolute(entry.exePath))
          return false;
        const key = appKey(platformPath.normalize(entry.exePath));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      ranked.sort(
        (a, b) =>
          (a.recentOrder ?? Infinity) - (b.recentOrder ?? Infinity) ||
          a.label.localeCompare(b.label) ||
          appKey(a.exePath).localeCompare(appKey(b.exePath)),
      );
      const idMap = new Map<string, ResolvedOpenWithApp>();
      // 保留全部应用。仅前 32 项取原生图标，其余使用通用图标；最多四项并发。
      const apps: OpenWithApp[] = await mapRegistryItems(ranked, async (entry) => {
        // ID 基于应用身份而非数组下标；重排不能让旧点击指向另一应用。
        const id =
          'owa-' +
          createHash('sha256')
            .update(JSON.stringify([appKey(entry.exePath), entry.args ?? []]))
            .digest('hex');
        idMap.set(id, entry);
        const iconDataUrl =
          (ranked.indexOf(entry) < 32
            ? await deps.getAppIcon(entry.exePath).catch(() => null)
            : null) ?? undefined;
        return { id, label: entry.label, ...(iconDataUrl ? { iconDataUrl } : {}) };
      });
      appCacheByFile.delete(appKey(filePath));
      appCacheByFile.set(appKey(filePath), { expires: now() + 60000, apps: idMap });
      prune();
      return { success: true, apps };
    } catch {
      appCacheByFile.delete(appKey(filePath));
      deps.onDiscoveryError?.();
      return { success: false, apps: [], error: '无法查询可用应用' };
    }
  }
  return {
    async list(params) {
      try {
        const filePath = await assertOpenableFile(params?.filePath);
        const key = appKey(filePath);
        const existing = pending.get(key);
        if (existing) return existing;
        if (pending.size >= 8) return { success: false, apps: [], error: '无法查询可用应用' };
        const work = discoveryTail.then(() => discover(filePath));
        discoveryTail = work.catch(() => undefined);
        pending.set(key, work);
        try {
          return await work;
        } finally {
          pending.delete(key);
        }
      } catch {
        return { success: false, apps: [], error: '无法查询可用应用' };
      }
    },
    async open(params) {
      const filePath = await assertOpenableFile(params?.filePath);
      const appId = params?.appId;
      if (typeof appId !== 'string' || !/^owa-[a-f0-9]{64}$/.test(appId))
        throwIpcError('NOT_FOUND', '应用引用已失效');
      prune();
      const entry = appCacheByFile.get(appKey(filePath))?.apps.get(appId);
      if (!entry) throwIpcError('NOT_FOUND', '应用引用已失效,请重新打开菜单');
      if (!deps.fileExists(entry.exePath)) throwIpcError('NOT_FOUND', '应用不存在');
      if (deps.platform === 'darwin') {
        await deps.spawnDetached('/usr/bin/open', ['-a', entry.exePath, '--', filePath]);
      } else if (deps.platform === 'win32') {
        await deps.spawnDetached(
          entry.exePath,
          (entry.args ?? ['%1']).map((arg) =>
            /^%(?:1|l|v|\*)$/i.test(arg) ? filePath : expandWindowsEnv(arg, process.env),
          ),
        );
      } else throwIpcError('INVALID_PARAMS', '不支持的平台');
    },
  };
}
