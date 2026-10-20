import { useEffect } from 'react';
import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { CrossAgentConvertDialog } from '../../../src/renderer/components/ui/cross-agent-convert-dialog';
import { MigrationPromptSection } from '../../../src/renderer/components/settings/MigrationPromptSection';
import { useCrossAgentMigrationDialog } from '../../../src/renderer/hooks/useCrossAgentConvertPrompt';

const instruction: CrossAgentMigrationItem = {
  id: 'agents-md:0', kind: 'agents-md', direction: 'to-claude', label: 'AGENTS.md → CLAUDE.md',
  source: 'C:\\Workspace\\project\\AGENTS.md', target: 'C:\\Workspace\\project\\CLAUDE.md',
};
const hooks: CrossAgentMigrationItem = { ...instruction, id: 'hooks:0', kind: 'hooks', label: 'Codex hooks → Claude hooks' };
function Prompt({ mixed }: { mixed: boolean }) {
  const dialog = useCrossAgentMigrationDialog();
  const run = dialog.runMigrationFlow;
  useEffect(() => { void run(mixed ? [instruction, hooks] : [instruction], 'C:\\Workspace\\project'); }, [mixed, run]);
  return <CrossAgentConvertDialog {...dialog} />;
}
void mountPage({
  host: (ctx) => {
    let suppressed = ['C:\\Workspace\\project', 'D:\\Projects\\a-long-project-directory-for-checking-wrapping'];
    return { maker: { crossAgent: {
      listSuppressedWorkspaces: async () => [...suppressed],
      restoreAgentsMdPrompt: async (workingDir: string) => {
        suppressed = suppressed.filter((entry) => entry !== workingDir);
        return [...suppressed];
      },
      suppressAgentsMdPrompt: async () => ctx.data.failure ? Promise.reject(new Error('Fixture save error')) : ['C:\\Workspace\\project'],
      convert: forbid('convert workspace files'),
      onStep: subscription('migration-step'),
    } } };
  },
  render: (ctx) => ctx.data.recovery
    ? <main className="mx-auto max-w-[720px] p-4"><MigrationPromptSection /></main>
    : <Prompt mixed={Boolean(ctx.data.mixed)} />,
});
