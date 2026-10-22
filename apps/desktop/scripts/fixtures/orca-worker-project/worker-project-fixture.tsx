import { RolePillDropdown } from '../../../src/renderer/features/cc-agent/RolePillDropdown';
import type { WorkerInfo } from '../../../src/renderer/features/cc-agent/hooks/useWorkers';
import { mountPage } from '../../ui-page/harness';
import {
  WorkerProjectField,
  useWorkerProjectSelection,
} from '../../../src/renderer/features/cc-agent/WorkerProjectField';
import type {
  WorkerProjectContext,
  WorkerProjectInfo,
} from '../../../src/shared/orca-worker-project';

const inherited: WorkerProjectInfo = {
  directory: '/projects/cindy/.cindy-worktrees/worker-picker',
  baseRepo: '/projects/cindy',
  branch: 'feat/worker-project-picker',
  headState: 'branch',
  exists: true,
  dirty: true,
  isWorktree: true,
};
const projects = [
  'cindy',
  'design-system',
  'mobile-app',
  'website',
  'notes',
  'missing-project',
].map((name) => ({
  path: `/projects/${name}`,
  name,
  description: `/projects/${name}`,
  missing: name === 'missing-project',
}));
function Fixture() {
  const selection = useWorkerProjectSelection(true, 'fixture-lead', true);
  return (
    <main className="mx-auto w-full max-w-[440px] p-4">
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <WorkerProjectField selection={selection} disabled={false} />
      </div>
    </main>
  );
}
const workers: WorkerInfo[] = ['frontend', 'reviewer'].map((role, index) => ({
  workerId: role,
  sessionId: role,
  role,
  agent: 'codex',
  model: 'gpt-5',
  effort: 'high',
  label: null,
  status: 'idle',
  focused: index === 0,
  idleSince: null,
}));
function WorkersFixture() {
  return (
    <main className="mx-auto w-full max-w-[440px] p-4">
      <RolePillDropdown
        worker={workers[0]}
        workers={workers}
        selectedWorkerId="frontend"
        activeWorkerCount={2}
        onSwitchFocus={() => {}}
        onArchiveWorker={() => {}}
      />
    </main>
  );
}
void mountPage({
  host: (ctx) => ({
    showOpenDirectoryDialog: async () => {
      if (ctx.case === 'same-repo') return { canceled: false, path: '/projects/cindy' };
      throw new Error('fixture dialog unavailable');
    },
    localDb: {
      orcaWorkflows: {
        projectLabel: async (id: string) =>
          id === 'frontend' ? { name: 'design-system', path: '/projects/design-system' } : null,
        projectContext: async (
          _id: string,
          directory?: string,
        ): Promise<WorkerProjectContext | WorkerProjectInfo> => {
          const lead =
            ctx.case === 'missing'
              ? {
                  ...inherited,
                  directory: '/projects/missing-project',
                  baseRepo: null,
                  branch: null,
                  exists: false,
                  isWorktree: false,
                  dirty: false,
                }
              : ctx.case === 'dialogue'
                ? {
                    ...inherited,
                    baseRepo: null,
                    branch: null,
                    directory: '/tasks/dialogue',
                    isWorktree: false,
                  }
                : ctx.case === 'empty'
                  ? {
                      ...inherited,
                      directory: '/projects/cindy',
                      branch: null,
                      headState: 'unborn' as const,
                      isWorktree: false,
                    }
                  : ctx.case === 'detached'
                    ? {
                        ...inherited,
                        branch: 'abcdef0123456789abcdef0123456789abcdef0123',
                        headState: 'detached' as const,
                      }
                    : inherited;
          const selected = directory
            ? {
                ...inherited,
                directory,
                baseRepo: directory,
                branch: ctx.case === 'detached' ? lead.branch : 'main',
                headState: ctx.case === 'detached' ? lead.headState : ('branch' as const),
                isWorktree: false,
              }
            : lead;
          if (directory) return selected;
          return {
            recordedDirectory: ctx.case === 'dialogue' ? lead.directory : '/projects/cindy',
            inherited: lead,
            selected,
            dialogue: ctx.case === 'dialogue',
            projects,
          };
        },
      },
    },
    worktreeListBranches: async () => ({
      branches: ['main', 'feat/worker-project-picker', 'release/v2'],
    }),
  }),
  render: (ctx) => (ctx.case === 'workers' ? <WorkersFixture /> : <Fixture />),
});
