import { execFile } from 'node:child_process';
import path from 'node:path';

import type { ResolvedOpenWithApp } from './openWithApps.js';

// 系统自带 JXA 直接调用 NSWorkspace；不依赖 Swift、第三方原生模块，
// 不通过 System Events 自动操作，不扫描文档内容。文件路径只作为 argv 数据传入。
export const MAC_OPEN_WITH_SCRIPT = [
  'function run(argv) {',
  "  ObjC.import('AppKit');",
  "  ObjC.import('Foundation');",
  '  const fileURL = $.NSURL.fileURLWithPath(argv[0]);',
  '  const apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(fileURL);',
  '  const ext = String(ObjC.unwrap(fileURL.pathExtension)).toLowerCase();',
  '  const markdown = /^(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|mdoc)$/.test(ext);',
  '  const result = [];',
  '  function unwrap(value) { return value.isNil() ? null : ObjC.deepUnwrap(value); }',
  '  for (let i = 0; i < Number(apps.count); i++) {',
  '    const url = apps.objectAtIndex(i);',
  '    try {',
  '      const bundle = $.NSBundle.bundleWithURL(url);',
  '      if (bundle.isNil()) continue;',
  "      const docs = unwrap(bundle.objectForInfoDictionaryKey('CFBundleDocumentTypes')) || [];",
  "      const urls = unwrap(bundle.objectForInfoDictionaryKey('CFBundleURLTypes')) || [];",
  '      const browser = urls.some(function(t) { return (t.CFBundleURLSchemes || []).some(function(s) { return /^(http|https)$/i.test(s); }); });',
  '      if (markdown && !docs.some(function(doc) {',
  "        if (doc.CFBundleTypeRole !== 'Editor' && doc.CFBundleTypeRole !== 'Viewer') return false;",
  '        const extensions = doc.CFBundleTypeExtensions || [];',
  '        const types = doc.LSItemContentTypes || [];',
  '        return extensions.some(function(e) {',
  "          return String(e).toLowerCase() === ext || (e === '*' && doc.CFBundleTypeRole === 'Editor');",
  '        }) || types.some(function(t) {',
  "          return /markdown/i.test(t) || ((!browser || doc.CFBundleTypeRole === 'Editor') && /^public\\.(text|plain-text|utf8-plain-text|utf16-plain-text)$/.test(t))",
  "            || (t === 'public.data' && doc.CFBundleTypeRole === 'Editor');",
  '        });',
  '      })) continue;',
  '      const appPath = ObjC.unwrap(url.path);',
  "      const label = String(ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(appPath))).replace(/\\.app$/i, '');",
  '      result.push({ exePath: appPath, label: label });',
  '    } catch (_) { /* 单个损坏/已卸载 bundle 不阻止其他应用显示。 */ }',
  '  }',
  '  return JSON.stringify(result);',
  '}',
].join('\n');

export function parseMacOpenWithApps(stdout: string): ResolvedOpenWithApp[] {
  const raw: unknown = JSON.parse(stdout);
  if (!Array.isArray(raw)) return [];
  const apps: ResolvedOpenWithApp[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.exePath !== 'string' ||
      !path.posix.isAbsolute(entry.exePath) ||
      !entry.exePath.endsWith('.app') ||
      entry.exePath.includes('\0') ||
      typeof entry.label !== 'string' ||
      !entry.label.trim()
    )
      continue;
    const app: ResolvedOpenWithApp = { exePath: entry.exePath, label: entry.label.trim() };
    apps.push(app);
  }
  return apps;
}

export async function listMacOpenWithApps(filePath: string): Promise<ResolvedOpenWithApp[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', MAC_OPEN_WITH_SCRIPT, '--', filePath],
      { timeout: 6000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  return parseMacOpenWithApps(stdout);
}
