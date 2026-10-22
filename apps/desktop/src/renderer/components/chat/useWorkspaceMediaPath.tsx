/**
 * useWorkspaceMediaPath —— 回复里嵌入的本地图片 / 视频 / 音频，相对路径按「任务目录 + 路径」
 * 找不到时，换成任务目录里唯一匹配的真实文件。
 *
 * 背景:
 *   Agent 常先进入任务目录下的子文件夹工作，交付时写相对子文件夹的路径（如
 *   `renders/out/clip.mp4`，文件实际在 `<任务目录>/film/renders/out/clip.mp4`）。正文里的
 *   路径 chip 早已用 fs:resolve-path（直接拼接 → 任务目录内按后缀搜索，唯一命中才采用）兜住
 *   这种写法；嵌入媒体此前只做直接拼接，于是同一条回复里路径能点、播放器却是坏的。
 *
 * 行为:
 *   复用路径 chip 的同一套解析与缓存。直接拼接能找到、没有命中或命中多个时都保持原路径（原
 *   行为），只有唯一命中且位置与直接拼接不同才替换成绝对路径。
 *
 * 范围:
 *   只用于本机会话。远程会话的路径解析不在远端搜索（见 MarkdownRenderer 的
 *   useResolvedMarkdownTarget），调用方传 enabled=false 时原样返回。
 */

import { useEffect, useState, type ReactNode } from 'react';

import {
  peekResolveLocalPathSmart,
  resolveLocalPath,
  resolveLocalPathSmartCached,
} from '@/lib/localPathResolver';

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[a-zA-Z][\w+.-]*:/;

/** 相对任务目录书写的本地路径：既不是 URL / 受管媒体地址，也不是绝对路径。 */
function isRelativeLocalPath(src: string): boolean {
  // 盘符路径要先判：`C:/x.png` 在形状上也匹配 URL scheme。
  if (WIN_ABS_RE.test(src)) return false;
  if (URL_SCHEME_RE.test(src)) return false;
  return !src.startsWith('/') && !src.startsWith('\\');
}

function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}

export function useWorkspaceMediaPath(
  src: string | undefined,
  workingDir: string,
  enabled: boolean,
): string | undefined {
  const href = enabled && src && workingDir && isRelativeLocalPath(src) ? src : null;
  // 结论只存在 localPathResolver 的模块缓存里；这里只在异步解析落缓存后触发一次重渲染，
  // 渲染时统一从缓存派生，换 src / 换会话都不会读到上一条路径的结论。
  const [, setResolvedGeneration] = useState(0);
  useEffect(() => {
    if (!href || peekResolveLocalPathSmart(href, workingDir)) return;
    let cancelled = false;
    void resolveLocalPathSmartCached(href, workingDir).then(() => {
      if (!cancelled) setResolvedGeneration((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [href, workingDir]);

  if (!href) return src;
  const result = peekResolveLocalPathSmart(href, workingDir);
  if (result?.status !== 'unique' || result.kind === 'directory') return src;
  // 直接拼接本来就能找到时保持原写法，避免播放器因地址写法不同而重新加载。
  return isSamePath(result.absPath, resolveLocalPath(href, workingDir)) ? src : result.absPath;
}

/** render-prop 形态，供 react-markdown 的 `img` 组件映射等不能直接调用 hook 的位置使用。 */
export function WorkspaceMediaSrc({
  src,
  workingDir,
  enabled,
  children,
}: {
  src: string | undefined;
  workingDir: string;
  enabled: boolean;
  children: (src: string | undefined) => ReactNode;
}) {
  return <>{children(useWorkspaceMediaPath(src, workingDir, enabled))}</>;
}
