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
 *   - 复用路径 chip 的同一套解析与缓存。直接拼接能找到、没有命中或命中多个时都保持原路径
 *     （原行为），只有唯一命中且位置与直接拼接不同才替换成绝对路径。
 *   - 解析完成前不交出地址（pending）：先拿拼接地址加载会让播放器进入失败态，解析结果晚到
 *     时界面已经显示过「不可用」。缓存命中时同步给出结论，没有等待。
 *   - 含 `%` 的路径不搜索：主进程查找前会先做 URL 解码，任务目录同时有 `a%20b.jpg` 与
 *     `a b.jpg` 时会换成另一个文件，违背「直接拼接能找到时保持原地址」。
 *   - 结论在组件里另存一份：共享缓存有容量上限，被其他引用挤掉后不能退回坏地址。
 *   - 没有命中 / 命中多个不是最终结论：回复可能先引用产物、文件后写出。新挂载、流式结束、
 *     窗口重新聚焦时重查一次（与图片加载失败的自然重试时机一致），重查期间照常显示拼接
 *     地址；唯一命中不重查。流式结束 / 聚焦时若有更早发出的查找还在进行，它回来仍未命中
 *     就再补查一次。
 *
 * 范围:
 *   只用于本机会话。远程会话的路径解析不在远端搜索（见 MarkdownRenderer 的
 *   useResolvedMarkdownTarget），调用方传 enabled=false 时原样返回。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  peekResolveLocalPathSmart,
  resolveLocalPath,
  resolveLocalPathSmartCached,
  revalidateNegativeLocalPathSmart,
  type SmartResolveResult,
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

export interface WorkspaceMediaPath {
  /** 用于加载的路径；pending 时为 undefined。 */
  src: string | undefined;
  /** 相对路径还在任务目录里解析，调用方此时不应加载媒体。 */
  pending: boolean;
}

export function useWorkspaceMediaPath(
  src: string | undefined,
  workingDir: string,
  enabled: boolean,
  streaming = false,
): WorkspaceMediaPath {
  const href =
    enabled && src && workingDir && isRelativeLocalPath(src) && !src.includes('%') ? src : null;
  const key = href ? `${workingDir}::${href}` : null;
  const [settled, setSettled] = useState<{ key: string; result: SmartResolveResult } | null>(null);
  // 重查时机：窗口重新聚焦、所在消息流式结束(挂载本身由下面的 effect 覆盖)。记下发生的
  // 时刻：那之前已发出、还没回来的查找可能已经错过新写出的文件，回来仍未命中时要再查一次。
  const [boundary, setBoundary] = useState<{ at: number } | null>(null);
  const handledBoundary = useRef<{ at: number } | null>(null);
  useEffect(() => {
    if (!href) return;
    const onFocus = () => setBoundary({ at: Date.now() });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [href]);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) setBoundary({ at: Date.now() });
    wasStreaming.current = streaming;
  }, [streaming]);

  useEffect(() => {
    if (!href || !key) return;
    let cancelled = false;
    const apply = (result: SmartResolveResult) => {
      if (cancelled) return;
      setSettled((current) =>
        current?.key === key && current.result === result ? current : { key, result },
      );
    };
    // 只有这次运行由新的时机触发时才按时机重查；挂载 / 路径变化走普通重查。
    const boundaryAt =
      boundary && boundary !== handledBoundary.current ? boundary.at : undefined;
    handledBoundary.current = boundary;
    const cached = peekResolveLocalPathSmart(href, workingDir);
    if (cached) {
      apply(cached);
      void revalidateNegativeLocalPathSmart(href, workingDir, boundaryAt)?.then(apply);
    } else {
      const recheck =
        boundaryAt === undefined ? null : revalidateNegativeLocalPathSmart(href, workingDir, boundaryAt);
      void (recheck ?? resolveLocalPathSmartCached(href, workingDir)).then(apply);
    }
    return () => {
      cancelled = true;
    };
  }, [href, key, workingDir, boundary]);

  if (!href) return { src, pending: false };
  const result =
    peekResolveLocalPathSmart(href, workingDir) ??
    (settled?.key === key ? settled.result : undefined);
  if (!result) return { src: undefined, pending: true };
  if (result.status !== 'unique' || result.kind === 'directory') return { src, pending: false };
  // 直接拼接本来就能找到时保持原写法，避免播放器因地址写法不同而重新加载。
  return {
    src: isSamePath(result.absPath, resolveLocalPath(href, workingDir)) ? src : result.absPath,
    pending: false,
  };
}

/**
 * render-prop 形态，供 react-markdown 的 `img` 组件映射等不能直接调用 hook 的位置使用。
 * 解析中不渲染媒体，结论出来后再交给 children。
 */
export function WorkspaceMediaSrc({
  src,
  workingDir,
  enabled,
  streaming,
  children,
}: {
  src: string | undefined;
  workingDir: string;
  enabled: boolean;
  /** 所在消息仍在流式输出；结束时重查没有命中的路径。 */
  streaming?: boolean;
  children: (src: string | undefined) => ReactNode;
}) {
  const resolved = useWorkspaceMediaPath(src, workingDir, enabled, streaming);
  return resolved.pending ? null : <>{children(resolved.src)}</>;
}
