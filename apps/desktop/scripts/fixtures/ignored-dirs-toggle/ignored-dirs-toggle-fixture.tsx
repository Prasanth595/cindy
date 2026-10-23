import { mountPage, subscription } from '../../ui-page/harness';
import { useFileTree } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useFileTree';
import { FileTreeView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileTreeView';
import { FileTreeIgnoredDirsToggle } from '../../../src/renderer/features/cc-agent/workdir-browse/FileTreeIgnoredDirsToggle';
import { useFileBrowserPreference } from '../../../src/renderer/hooks/useFileBrowserPreference';
import type { DirEntry } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useFileTree';

// node_modules 与 .git 是「被忽略目录」:showIgnoredDirs=false 时 daemon/listDir 不返回。
const ROOT_HIDDEN: readonly DirEntry[] = [
  { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
  { name: 'package.json', relPath: 'package.json', type: 'file', size: 640, mtimeMs: 2 },
];
const ROOT_FULL: readonly DirEntry[] = [
  ...ROOT_HIDDEN,
  { name: 'node_modules', relPath: 'node_modules', type: 'directory', size: 0, mtimeMs: 3 },
  { name: '.git', relPath: '.git', type: 'directory', size: 0, mtimeMs: 4 },
];
const SRC: readonly DirEntry[] = [
  { name: 'main.ts', relPath: 'src/main.ts', type: 'file', size: 1024, mtimeMs: 5 },
];

function Fixture() {
  // 与开关同一条偏好链:点开关 → useFileTree 换 store 重拉,即被测的真实路径。
  const { showIgnoredDirs } = useFileBrowserPreference();
  const tree = useFileTree({ workdir: '/repo', showIgnoredDirs });
  return (
    <main className="mx-auto w-full max-w-[420px] p-3">
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-12 font-medium text-[var(--text-primary)]">资源管理器</span>
          <FileTreeIgnoredDirsToggle />
        </div>
        <FileTreeView tree={tree} selectedPath={null} active onSelectFile={() => {}} />
      </div>
    </main>
  );
}

void mountPage({
  host: {
    fileBrowser: {
      listDir: async (args: { relPath?: string; showIgnoredDirs?: boolean }) => {
        if ((args.relPath ?? '') === '') return args.showIgnoredDirs ? ROOT_FULL : ROOT_HIDDEN;
        if (args.relPath === 'src') return SRC;
        if (args.relPath === 'node_modules') return [{ name: '.pnpm', relPath: 'node_modules/.pnpm', type: 'directory', size: 0, mtimeMs: 6 }];
        return [];
      },
      startWatch: async () => ({ ok: true as const }),
      stopWatch: async () => ({ ok: true as const }),
      onEvent: (_cb: unknown) => () => {},
    },
    maker: { onProvidersChanged: subscription('providersChanged') },
  },
  render: () => <Fixture />,
});
