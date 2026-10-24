import { useState } from 'react';
import { BranchWorktreeChip } from '../../../src/renderer/components/new-chat/WorktreeChipsRow';
import { mountPage, type UiPageContext } from '../../ui-page/harness';
import type { BranchSyncRequest, BranchSyncStatus } from '../../../src/shared/worktreeBranchSync';
const branches = ['main', 'feature/search', 'origin/main'];
function Fixture({ ctx }: { ctx: UiPageContext }) {
  const [branch, setBranch] = useState('main');
  const [checked, setChecked] = useState(ctx.case !== 'unchecked');
  return (
    <main className="p-6 pt-16">
      <BranchWorktreeChip
        baseRepo="/projects/cindy"
        branchLabel={branch}
        deviceId={ctx.case === 'old-host' ? 'old-pc' : undefined}
        remoteDefaultBranch={ctx.case === 'old-host' ? undefined : 'refs/remotes/origin/main'}
        branches={branches}
        branchesLoading={false}
        branchesFailed={false}
        onRetryBranches={() => {}}
        checked={checked}
        branchSourceSelected
        branchInteractive
        onPick={setBranch}
        onOpenRequested={() => {}}
        onToggle={setChecked}
        compact={ctx.case === 'worker'}
        branchOnly={ctx.case === 'worker'}
      />
    </main>
  );
}
mountPage({
  host: (ctx) => {
    const read = (req: BranchSyncRequest): BranchSyncStatus => ({
      branch: req.branch,
      remote: 'origin',
      remoteBranch: 'main',
      remoteOnly: req.branch.startsWith('refs/'),
      ahead: ctx.case === 'diverged' ? 2 : 0,
      behind: 3,
      dirtyFiles: 3,
      checkoutPath: '/projects/cindy',
      ...(ctx.case === 'diverged' || ctx.case === 'conflict' ? { blocked: ctx.case } : {}),
    });
    return {
      deviceLink: {
        invoke: async () => {
          throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Old host');
        },
      },
      worktreeBranchSyncStatus: async (req: BranchSyncRequest) => read(req),
      worktreeSyncBranch: async (req: BranchSyncRequest) => ({
        status: { ...read(req), behind: 0 },
        updated: 3,
      }),
    };
  },
  render: (ctx) => <Fixture ctx={ctx} />,
});
