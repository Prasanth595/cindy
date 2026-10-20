/** Shared pure Pi path recognition for priority discovery and process monitoring. */
import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';

import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';

/**
 * pi 二进制路径 marker(与 claude/codex 的 marker 同构):生产二进制安装在
 * `<userData>/pi/<version>/`,dev/sandbox 则从仓库 `apps/pi-bin/` 启动。
 */
export function buildPiPathMarkers(dirNames: readonly string[]): string[] {
  return [
    'apps\\pi-bin\\',
    'apps/pi-bin/',
    ...dirNames.flatMap((dirName) => {
      const dir = dirName.toLowerCase();
      return [
        `appdata\\roaming\\${dir}\\pi\\`,
        `appdata/roaming/${dir}/pi/`,
        `/library/application support/${dir}/pi/`,
        `/.config/${dir}/pi/`,
      ];
    }),
  ];
}

const PI_MARKERS = buildPiPathMarkers(allUserDataDirNames(CURRENT_CINDY_REGION));

/**
 * 运行时 userData 派生的 pi marker(XDG_CONFIG_HOME / --user-data-dir 重定向
 * 场景)。优先级 watcher 与资源监视器共用，避免布局规则分叉。
 */
let runtimePiMarkers: string[] = [];

export function registerPiUserDataMarkers(userDataPath: string): void {
  const lower = userDataPath.trim().toLowerCase();
  if (!lower) {
    runtimePiMarkers = [];
    return;
  }
  const variants = new Set([lower.replace(/\\/g, '/'), lower.replace(/\//g, '\\')]);
  runtimePiMarkers = [...variants].map((v) => {
    const sep = v.includes('\\') ? '\\' : '/';
    return `${v}${sep}pi${sep}`;
  });
}

/** Command line is already lowercased by the process scanner. */
export function isManagedPiCommandLine(cmdLineLower: string): boolean {
  return (
    PI_MARKERS.some((marker) => cmdLineLower.includes(marker)) ||
    runtimePiMarkers.some((marker) => cmdLineLower.includes(marker))
  );
}
