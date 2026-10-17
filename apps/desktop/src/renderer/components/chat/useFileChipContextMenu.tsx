import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import { isDangerousAttachmentName } from '../../../shared/attachmentSafety';
/** Shared flat menus for message file references. HTML exposes page/source actions;
 * other files retain file operations. Local reveal and remote download occupy
 * the same slot. Path resolution stays lazy until an action is selected. */

import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  AppWindow,
  ClipboardCopy,
  Copy,
  Download,
  FileCode,
  FolderOpen,
  FolderTree,
  Globe,
  PanelRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { formatFileLocation, type FileLocation } from '@/lib/fileLocation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  openDirInSidebarFileBrowser,
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from '@/features/right-sidebar/lib/openInSidebarFileBrowser';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import {
  copyRemoteChatFile,
  downloadRemoteChatEntry,
  openRemoteChatFile,
} from '@/lib/remoteFileOpen';
import { toWorkdirRel } from '../../../shared/workdirPath';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import { openHtmlFileByPreference } from './useOpenWithMenu';
import { useChatSessionFile } from './ChatSessionFileContext';
import { OpenWithAppDialog, type AppChoice } from './OpenWithAppDialog';
import { isSeparateLinkActivation, linkMenuPosition } from './linkInteraction';

// Load source preview only when requested; TextLightbox itself renders Markdown links.
const SourcePreview = lazy(() =>
  import('./TextLightbox').then((module) => ({ default: module.TextLightbox })),
);

export interface UseFileChipContextMenu {
  onContextMenu: (e: React.MouseEvent) => void;
  openAt: (x: number, y: number, trigger: HTMLElement) => void;
  onActivate: (
    event: React.MouseEvent<HTMLElement>,
    openDefault: () => void | Promise<void>,
  ) => void;
  menu: ReactElement;
}

/** sidebarOpenSessionId overrides the browser target, never the file origin.
 * onViewSource reuses a caller's preview; other HTML references use TextLightbox. */
export function useFileChipContextMenu({
  fileName,
  getAbsPath,
  canOpenInBrowser = false,
  sidebarFileBrowserKind = 'file',
  sidebarOpenSessionId,
  onViewSource,
  location,
}: {
  /** Menu eligibility only; remote opening also checks the resolved path. */
  fileName: string;
  getAbsPath: () => Promise<string> | string;
  canOpenInBrowser?: boolean;
  sidebarFileBrowserKind?: 'file' | 'directory';
  sidebarOpenSessionId?: string;
  onViewSource?: () => void | Promise<void>;
  /** Only supplied by resolved Markdown references; existing path-copy stays absolute. */
  location?: FileLocation;
}): UseFileChipContextMenu {
  const { t } = useTranslation();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [appPicker, setAppPicker] = useState<{ filePath: string; apps: AppChoice[] } | null>(null);
  const requestRef = useRef(0);
  const queryingRef = useRef(false);
  const pickerOpeningRef = useRef(false);
  const resolverRef = useRef(getAbsPath);
  resolverRef.current = getAbsPath;
  const triggerRef = useRef<HTMLElement | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  // 远程会话(device-link / SSH):文件字节在远端机器,「复制文件 / 定位」改走
  // 取回缓存副本;「复制路径」保留远端原始路径;HTML 使用远程预览服务。
  // 聊天流外 context 是 local 默认值。
  const sessionFileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(sessionFileCtx.origin) ? sessionFileCtx.origin : null;
  const sidebarFileTargetSessionId = useSidebarTargetSessionId(sessionFileCtx.sessionId);
  const sidebarBrowserTargetSessionId = useSidebarTargetSessionId(
    sidebarOpenSessionId ?? sessionFileCtx.sessionId,
  );
  const copyLocation =
    location && sidebarFileBrowserKind === 'file'
      ? formatFileLocation(sessionFileCtx.workingDir, location)
      : null;

  const fileIdentity = JSON.stringify([fileName, location, sessionFileCtx]);
  useEffect(() => {
    requestRef.current++;
    queryingRef.current = false;
    setAppPicker(null);
    return () => {
      requestRef.current++;
    };
  }, [fileIdentity]);

  function closePicker(): void {
    setAppPicker(null);
    pickerOpeningRef.current = false;
    if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
  }

  async function handleChooseApplication(): Promise<void> {
    if (
      remoteOrigin ||
      canOpenInBrowser ||
      sidebarFileBrowserKind !== 'file' ||
      queryingRef.current
    )
      return;
    const request = ++requestRef.current;
    queryingRef.current = true;
    const resolve = getAbsPath;
    try {
      const filePath = await resolve();
      if (request !== requestRef.current) return;
      const result = await window.electronAPI.listOpenWithApps({ filePath });
      if (request !== requestRef.current) return;
      // Inline resolvers may be recreated on every render. Compare the resolved
      // file, not callback identity, while still rejecting a changed same-name chip.
      const currentPath = await resolverRef.current();
      if (request !== requestRef.current || currentPath !== filePath) return;
      if (!result.success) {
        toast.error(t('chat.markdownRenderer.appPicker.failed'));
        return;
      }
      pickerOpeningRef.current = true;
      setAppPicker({ filePath, apps: result.apps });
      setMenuPos(null);
    } catch {
      if (request === requestRef.current) toast.error(t('chat.markdownRenderer.appPicker.failed'));
    } finally {
      if (request === requestRef.current) queryingRef.current = false;
    }
  }

  async function handleOpenWithApplication(appId: string): Promise<void> {
    const choice = appPicker;
    const request = requestRef.current;
    closePicker();
    if (!choice || remoteOrigin) return;
    // A same-name chip may have changed path while the picker was open.
    const current = await resolverRef.current();
    if (request !== requestRef.current) return;
    if (current !== choice.filePath) {
      toast.error(t('chat.markdownRenderer.appPicker.changed'));
      return;
    }
    await window.electronAPI.openFileWithApp({ filePath: current, appId });
  }

  async function handleCopyLocation(): Promise<void> {
    setMenuPos(null);
    if (!copyLocation) return;
    try {
      await navigator.clipboard.writeText(copyLocation);
      toast.success(t('chat.markdownRenderer.locationCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  async function handleCopyFile(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    if (remoteOrigin) {
      await copyRemoteChatFile(remoteOrigin, sessionFileCtx.workingDir, abs);
      return;
    }
    const res = await window.electronAPI.copyMediaToClipboard({ filePath: abs });
    if (res.success) toast.success(t('chat.markdownRenderer.fileCopied'));
    else toast.error(res.error ?? t('chat.media.copyFailed'));
  }

  async function handleCopyPath(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    try {
      await navigator.clipboard.writeText(abs);
      toast.success(t('chat.markdownRenderer.pathCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  async function handleReveal(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    if (remoteOrigin) {
      // 远端路径本机不存在:文件 / 文件夹下载到系统下载文件夹后再定位。
      await downloadRemoteChatEntry(remoteOrigin, sessionFileCtx.workingDir, abs);
      return;
    }
    const res = await window.electronAPI.showItemInFolder({ filePath: abs });
    if (!res.success) toast.error(res.error ?? t('chat.media.openFolderFailed'));
  }

  async function handleOpenInBrowser(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    await openHtmlFileByPreference(
      sidebarBrowserTargetSessionId ?? sidebarFileTargetSessionId ?? '',
      abs,
      t,
      sessionFileCtx,
      'external',
    );
  }

  async function handleOpenInSidebar(): Promise<void> {
    setMenuPos(null);
    if (!sidebarBrowserTargetSessionId) return;
    const abs = await getAbsPath();
    await openHtmlFileByPreference(
      sidebarBrowserTargetSessionId,
      abs,
      t,
      sessionFileCtx,
      'sidebar',
    );
  }

  async function handleOpenInSidebarFileBrowser(): Promise<void> {
    setMenuPos(null);
    const sessionId = sidebarFileTargetSessionId;
    if (!sessionId) return;
    const abs = await getAbsPath();
    const rel = toWorkdirRel(sessionFileCtx.workingDir, abs);
    try {
      if (sidebarFileBrowserKind === 'directory') {
        if (!rel) {
          toast.error(t('chat.markdownRenderer.openInSidebarFileBrowserOutsideWorkdir'));
          return;
        }
        await openDirInSidebarFileBrowser(sessionId, rel);
        return;
      }
      if (rel) {
        await openFileInSidebarFileBrowser(sessionId, rel);
        return;
      }
      // 远程来源的绝对路径位于远端机器，不能按“本机外部拖入”读取；本地来源则
      // 复用文件浏览器的外部文件拖入语义，以只读方式预览 workdir 外文件。
      if (remoteOrigin) {
        toast.error(t('chat.markdownRenderer.openInSidebarFileBrowserOutsideWorkdir'));
        return;
      }
      await openExternalFileInSidebarFileBrowser(sessionId, abs);
    } catch {
      toast.error(t('chat.markdownRenderer.openInSidebarFileBrowserFailed'));
    }
  }

  async function handleViewSource(): Promise<void> {
    setMenuPos(null);
    if (onViewSource) await onViewSource();
    else setSourcePath(await getAbsPath());
  }

  async function handleOpenWithDefault(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    if (remoteOrigin) {
      if (sidebarFileBrowserKind === 'directory') {
        await downloadRemoteChatEntry(remoteOrigin, sessionFileCtx.workingDir, abs);
      } else {
        await openRemoteChatFile(remoteOrigin, sessionFileCtx.workingDir, abs);
      }
      return;
    }
    const res = await window.electronAPI.openPath(abs);
    if (shouldShowOpenPathError(res))
      toast.error(res.error ?? t('chat.markdownRenderer.openWithAppFailed'));
  }

  const openAt: UseFileChipContextMenu['openAt'] = (x, y, trigger) => {
    requestRef.current++;
    queryingRef.current = false;
    triggerRef.current = trigger;
    setMenuPos({ x, y });
  };

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = linkMenuPosition(e as React.MouseEvent<HTMLElement>);
    openAt(x, y, e.currentTarget as HTMLElement);
  };
  const onActivate: UseFileChipContextMenu['onActivate'] = (event, openDefault) => {
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      if (!isSeparateLinkActivation(event)) await openDefault();
      else if (canOpenInBrowser) await handleOpenInBrowser();
      else await handleOpenWithDefault();
    })().catch(() => toast.error(t('chat.markdownRenderer.openWithAppFailed')));
  };

  const run = (action: () => Promise<void>) => () => {
    void action().catch(() => toast.error(t('chat.markdownRenderer.openLinkFailed')));
  };
  const canLocateInSidebar = Boolean(sidebarFileTargetSessionId && sessionFileCtx.workingDir);
  const canOpenWithDefault =
    sidebarFileBrowserKind === 'file' && !(remoteOrigin && isDangerousAttachmentName(fileName));
  const hasOpenActions = canOpenInBrowser || canLocateInSidebar || canOpenWithDefault;
  const menu = (
    <>
      <DropdownMenu
        open={menuPos !== null}
        onOpenChange={(open) => {
          if (!open) {
            requestRef.current++;
            queryingRef.current = false;
            setMenuPos(null);
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            data-fixed-menu-anchor
            style={{
              position: 'fixed',
              left: menuPos?.x ?? 0,
              top: menuPos?.y ?? 0,
              width: 0,
              height: 0,
              pointerEvents: 'none',
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!pickerOpeningRef.current && triggerRef.current?.isConnected)
              triggerRef.current.focus({ preventScroll: true });
          }}
        >
          {canOpenInBrowser ? (
            <>
              {sidebarBrowserTargetSessionId ? (
                <DropdownMenuItem onClick={run(handleOpenInSidebar)}>
                  <PanelRight className="mr-2 h-4 w-4" />
                  {t('chat.markdownRenderer.openInSidebarBrowser')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={run(handleOpenInBrowser)}>
                <Globe className="mr-2 h-4 w-4" />
                {t('chat.markdownRenderer.openInDefaultBrowser')}
                <DropdownMenuShortcut aria-hidden>
                  {t('chat.markdownRenderer.shiftClick')}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={run(handleViewSource)}>
                <FileCode className="mr-2 h-4 w-4" />
                {t('chat.markdownRenderer.viewSourceFile')}
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {canLocateInSidebar ? (
                <DropdownMenuItem onClick={run(handleOpenInSidebarFileBrowser)}>
                  <FolderTree className="mr-2 h-4 w-4" />
                  {t('chat.markdownRenderer.openInSidebarFileBrowser')}
                </DropdownMenuItem>
              ) : null}
              {canOpenWithDefault ? (
                <DropdownMenuItem onClick={run(handleOpenWithDefault)}>
                  <AppWindow className="mr-2 h-4 w-4" />
                  {t('chat.media.openWithApp')}
                  <DropdownMenuShortcut aria-hidden>
                    {t('chat.markdownRenderer.shiftClick')}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              ) : null}
              {!remoteOrigin &&
              sidebarFileBrowserKind === 'file' &&
              ['win32', 'darwin'].includes(window.electronAPI.platform) ? (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleChooseApplication();
                  }}
                >
                  <AppWindow className="mr-2 h-4 w-4" />
                  {t('chat.markdownRenderer.appPicker.title')}
                </DropdownMenuItem>
              ) : null}
            </>
          )}
          {hasOpenActions ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onClick={run(handleReveal)}>
            {remoteOrigin ? (
              <Download className="mr-2 h-4 w-4" />
            ) : (
              <FolderOpen className="mr-2 h-4 w-4" />
            )}
            {remoteOrigin
              ? t('chat.remoteFile.downloadToLocal')
              : t('chat.markdownRenderer.revealFile')}
          </DropdownMenuItem>
          {!canOpenInBrowser && !(remoteOrigin && sidebarFileBrowserKind === 'directory') ? (
            <DropdownMenuItem onClick={run(handleCopyFile)}>
              <Copy className="mr-2 h-4 w-4" />
              {t('chat.markdownRenderer.copyFile')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={run(handleCopyPath)}>
            <ClipboardCopy className="mr-2 h-4 w-4" />
            {t('chat.markdownRenderer.copyFilePath')}
          </DropdownMenuItem>
          {copyLocation ? (
            <DropdownMenuItem onClick={run(handleCopyLocation)}>
              <ClipboardCopy className="mr-2 h-4 w-4" />
              {t('chat.markdownRenderer.copyLocation')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {appPicker ? (
        <OpenWithAppDialog
          apps={appPicker.apps}
          onClose={closePicker}
          onRestoreFocus={() => {
            if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
          }}
          onChoose={(id) => {
            void handleOpenWithApplication(id).catch(() =>
              toast.error(t('chat.markdownRenderer.openWithAppFailed')),
            );
          }}
        />
      ) : null}
      {sourcePath ? (
        <Suspense fallback={null}>
          <SourcePreview
            filePath={sourcePath}
            initialLine={location?.line}
            triggerRef={triggerRef}
            onClose={() => setSourcePath(null)}
          />
        </Suspense>
      ) : null}
    </>
  );

  return { onContextMenu, onActivate, openAt, menu };
}
