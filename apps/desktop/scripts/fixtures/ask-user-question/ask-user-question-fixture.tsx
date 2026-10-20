import { useState } from 'react';
import { mountPage, forbid } from '../../ui-page/harness';
import { AskUserQuestionPrompt } from '../../../src/renderer/components/new-chat/AskUserQuestionPrompt';
import type { AskUserDraft, AskUserViewerState } from '../../../src/renderer/lib/makerChatStore';

function Fixture({ question }: { question: string }) {
  const [draft, setDraft] = useState<AskUserDraft | null>(null);
  const [viewerState, setViewerState] = useState<AskUserViewerState>('expanded');
  return <main className="mx-auto w-full max-w-[720px] min-w-0 p-4">
    <AskUserQuestionPrompt sessionId="question-evidence" workingDir="/project"
      pending={{ requestId: 'review', questions: [{ header: '确认原型', question, options: [
        { label: '可以，按这版实现' }, { label: '还需要调整' },
      ] }] }}
      onAnswer={forbid('answer question')}
      draft={draft} onDraftChange={setDraft} viewerState={viewerState} onViewerStateChange={setViewerState} />
  </main>;
}

void mountPage({
  host: {
    resolvePathBatch: async ({ hrefs }: { hrefs: string[] }) => Object.fromEntries(hrefs.map((href) => [href,
      href === 'missing.html' ? { status: 'none', candidates: [] }
        : href === 'ambiguous.html' ? { status: 'multiple', candidates: ['/project/a/ambiguous.html', '/project/b/ambiguous.html'] }
        : { status: 'unique', candidates: [href.startsWith('/') ? href : '/project/' + href], kind: 'file' },
    ])),
  },
  render: (ctx) => <Fixture question={String(ctx.data.question)} />,
});
