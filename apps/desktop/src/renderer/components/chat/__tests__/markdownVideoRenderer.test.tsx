// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
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
import { _clearSmartResolveCache, toLocalFileUrl } from '@/lib/localPathResolver';
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
  const richVideo = '```cindy-ui\n' + JSON.stringify({
    version: 1, seq: 1, op: 'create', id: 'v', kind: 'video',
    props: { src: 'renders/out/clip.mp4', alt: 'clip' },
  }) + '\n```';

  function mount(content: string, origin: object, batch: Record<string, unknown>) {
    sessionFile.current = { sessionId: 's1', workingDir: '/task', origin };
    const resolvePathBatch = vi.fn(async () => batch);
    (window as unknown as { electronAPI: unknown }).electronAPI = { resolvePathBatch };
    const view = render(
      <MarkdownRenderer workingDir="/task" currentSessionId="s1" renderRichAnswers content={content} />,
    );
    return { view, resolvePathBatch };
  }

  it.each([
    ['cindy-ui video', richVideo, 'renders/out/clip.mp4'],
    ['Markdown image', '![sheet](work/sheet.jpg)', 'work/sheet.jpg'],
  ])('plays the unique workspace match for a %s whose joined path is missing', async (_label, content, href) => {
    const { view } = mount(content, { kind: 'local' }, {
      [href]: { status: 'unique', candidates: [`/task/film/${href}`], kind: 'file' },
    });
    const media = () => view.container.querySelector('[data-testid="markdown-video"], img');
    await waitFor(() => {
      const src = media()?.getAttribute('data-src') ?? media()?.getAttribute('src');
      expect(src).toBe(toLocalFileUrl(`/task/film/${href}`));
    });
  });

  it('keeps the joined path when the workspace has no match', async () => {
    const { resolvePathBatch } = mount(richVideo, { kind: 'local' }, {
      'renders/out/clip.mp4': { status: 'none', candidates: [] },
    });
    await waitFor(() => expect(resolvePathBatch).toHaveBeenCalled());
    expect(screen.getByTestId('markdown-video').getAttribute('data-src')).toBe(
      toLocalFileUrl('/task/renders/out/clip.mp4'),
    );
  });

  it('does not search the local disk for a remote session', () => {
    const { resolvePathBatch } = mount(richVideo, { kind: 'device', deviceId: 'dev-1' }, {});
    expect(parseRemoteMediaUrl(screen.getByTestId('markdown-video').getAttribute('data-src') ?? '')?.origUrl)
      .toBe(toLocalFileUrl('/task/renders/out/clip.mp4'));
    expect(resolvePathBatch).not.toHaveBeenCalled();
  });
});
