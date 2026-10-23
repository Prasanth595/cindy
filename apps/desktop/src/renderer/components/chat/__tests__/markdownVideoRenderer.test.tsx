// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ChatVideoView', () => ({
  ChatVideoView: ({
    src,
    filename,
  }: {
    src: string;
    filename: string;
    variant: string;
    sessionId?: string;
  }) => <video data-testid="markdown-video" data-src={src} aria-label={filename} />,
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const REMOTE_SESSION_FILE = {
  sessionId: 's1',
  workingDir: '/remote/proj',
  origin: { kind: 'device', deviceId: 'dev-1' },
} as const;
const sessionFile = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../ChatSessionFileContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ChatSessionFileContext')>()),
  useChatSessionFile: () => sessionFile.current ?? REMOTE_SESSION_FILE,
}));

import { parseRemoteMediaUrl } from '../../../../shared/remoteMediaUrl';
import { _clearSmartResolveCache, localFileUrlToAudioUrl, toLocalFileUrl } from '@/lib/localPathResolver';
import { MarkdownRenderer } from '../MarkdownRenderer';

afterEach(() => {
  sessionFile.current = null;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  _clearSmartResolveCache();
});

describe('MarkdownRenderer managed video targets', () => {
  it.each([
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4',
    'xdt-video://lizi-art-media-videos/generated.webm',
  ])('routes managed video %s in Markdown image syntax to the video preview', (src) => {

    render(
      <MarkdownRenderer
        workingDir="C:\workspace"
        content={'![Seedance 雪景版 KV 动态预览](' + src + ')'}
      />,
    );

    const video = screen.getByTestId('markdown-video');
    expect(video.getAttribute('data-src')).toBe(src);
    expect(video.getAttribute('aria-label')).toBe('Seedance 雪景版 KV 动态预览');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('rewrites the video source through the remote media origin in device-link sessions', () => {
    render(
      <MarkdownRenderer
        workingDir="/remote/proj"
        currentSessionId="s1"
        content="![clip](xdt-video://local/generated.mp4)"
      />,
    );

    const video = screen.getByTestId('markdown-video');
    const rewritten = parseRemoteMediaUrl(video.getAttribute('data-src') ?? '');
    // 远程会话里必须改写到 cindy-remote-media://，否则控制端拿自己的协议库取不到视频。
    expect(rewritten).not.toBeNull();
    expect(rewritten?.origUrl).toBe('xdt-video://local/generated.mp4');
    expect(rewritten?.origin).toEqual({ kind: 'device', deviceId: 'dev-1' });
  });
});

// Agent 进入任务目录的子文件夹工作后，常把媒体写成相对子文件夹的路径；直接拼到任务目录找不到，
// 嵌入的播放器和图片就是坏的（路径 chip 却能靠任务目录搜索点亮）。本机会话里媒体要复用同一套
// 解析：唯一命中换成真实文件，没有命中保持原拼接；远程会话不在本机搜索远端路径。
describe('MarkdownRenderer workspace-relative media in local sessions', () => {
  const richNode = (kind: 'video' | 'audio', src: string) => '```cindy-ui\n' + JSON.stringify({
    version: 1, seq: 1, op: 'create', id: 'm', kind, props: { src, alt: 'clip' },
  }) + '\n```';
  const richVideo = richNode('video', 'renders/out/clip.mp4');
  const mediaSrc = (container: HTMLElement) => {
    const el = container.querySelector('[data-testid="markdown-video"], img, audio');
    return el?.getAttribute('data-src') ?? el?.getAttribute('src') ?? null;
  };

  function mount(
    content: string,
    origin: object,
    batch: Record<string, unknown> | Promise<Record<string, unknown>>,
  ) {
    sessionFile.current = { sessionId: 's1', workingDir: '/task', origin };
    const resolvePathBatch = vi.fn(async () => batch);
    (window as unknown as { electronAPI: unknown }).electronAPI = { resolvePathBatch };
    const renderWith = (title?: string) => (
      <MarkdownRenderer workingDir="/task" currentSessionId="s1" currentSessionTitle={title} renderRichAnswers content={content} />
    );
    const view = render(renderWith());
    return { view, renderWith, resolvePathBatch };
  }
  const unique = (href: string) => ({ [href]: { status: 'unique', candidates: [`/task/film/${href}`], kind: 'file' } });

  it.each([
    ['cindy-ui video', richVideo, 'renders/out/clip.mp4', toLocalFileUrl],
    ['Markdown image', '![sheet](work/sheet.jpg)', 'work/sheet.jpg', toLocalFileUrl],
    // 本地音频要走 xdt-audio://，xdt-file:// 不放行音频。
    ['cindy-ui audio', richNode('audio', 'sfx/hit.wav'), 'sfx/hit.wav',
      (absPath: string) => localFileUrlToAudioUrl(toLocalFileUrl(absPath))],
  ])('plays the unique workspace match for a %s whose joined path is missing', async (_label, content, href, toUrl) => {
    const { view } = mount(content, { kind: 'local' }, unique(href));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toUrl(`/task/film/${href}`)));
  });

  // 解析结果晚到时，播放器不能先拿拼接出来的坏地址加载：那会先进入「视频不可用」。
  it('does not load the joined path before the workspace answer arrives', async () => {
    let answer!: (batch: Record<string, unknown>) => void;
    const { view } = mount(richVideo, { kind: 'local' }, new Promise((resolve) => { answer = resolve; }));
    await act(async () => {});
    expect(mediaSrc(view.container)).toBeNull();

    await act(async () => answer(unique('renders/out/clip.mp4')));
    expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4'));
  });

  // 共享解析缓存有容量上限；被其他引用挤掉后，已经找到的媒体不能退回拼接出来的坏地址。
  it('keeps a found file after the shared resolve cache drops it', async () => {
    const { view, renderWith, resolvePathBatch } = mount(richVideo, { kind: 'local' }, unique('renders/out/clip.mp4'));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));

    _clearSmartResolveCache();
    // 同一个播放器再次渲染(不重新挂载，所以不会重新解析)。
    view.rerender(renderWith('renamed task'));
    expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4'));
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
  });

  it('keeps the joined path when the workspace has no match', async () => {
    const { view } = mount(richVideo, { kind: 'local' }, { 'renders/out/clip.mp4': { status: 'none', candidates: [] } });
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/renders/out/clip.mp4')));
  });

  // `%` 可能是字面文件名；主进程查找前会解码，可能换成另一个文件，所以这类路径不搜索。
  it.each([
    ['a remote session', { kind: 'device', deviceId: 'dev-1' }, 'renders/out/clip.mp4'],
    ['a path containing %', { kind: 'local' }, 'renders/out/clip%20final.mp4'],
  ])('does not search the local disk for %s', async (_label, origin, href) => {
    const { view, resolvePathBatch } = mount(richNode('video', href), origin, {});
    // 搜索请求按微任务批量发出；先让它有机会发出再断言。
    await act(async () => {});
    const src = mediaSrc(view.container) ?? '';
    expect(parseRemoteMediaUrl(src)?.origUrl ?? src).toBe(toLocalFileUrl(`/task/${href}`));
    expect(resolvePathBatch).not.toHaveBeenCalled();
  });
});
