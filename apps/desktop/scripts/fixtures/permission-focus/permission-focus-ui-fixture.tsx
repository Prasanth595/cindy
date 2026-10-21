import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ctx, forbid, mountPage } from '../../ui-page/harness';
import {
  SessionItem,
  hasSessionSelectionModifier,
  type SessionClickHandler,
} from '../../../src/renderer/features/cc-agent/sidebar/SessionItem';
import { SessionCard } from '../../../src/renderer/features/cc-agent/sidebar/SessionCard';
import { SessionEntryList, type SessionEntryListProps } from '../../../src/renderer/features/cc-agent/sidebar/SessionEntryList';
import { CardMasonry } from '../../../src/renderer/features/cc-agent/sidebar/CardMasonry';
import { PermissionPrompt } from '../../../src/renderer/components/new-chat/PermissionPrompt';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

// Synthetic host data and navigation shell; all subjects and focus hooks are real.
const sessions = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({
  id,
  title: `演示任务 ${id}`,
  status: 'active',
  agentKind: 'cc',
  source: 'desktop',
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z',
  workingDir: '/synthetic',
  pinnedAt: '2026-10-15T00:00:00Z',
  preview: '仅合成演示数据，未运行任何工具',
  _count: { messages: 1 },
}) as unknown as Session);
const emptyIds = new Set<string>();
const emptySchedules: SessionEntryListProps['scheduleSessionIndex'] = new Map();
const forbiddenAction = forbid('permission-focus: sidebar mutation');
const forbiddenReorder = forbid('permission-focus: reorder sessions');
const fromFiles = ctx.data.fromFiles === true;
const layout = String(ctx.data.layout);
const panelWidth = Number(ctx.data.panelWidth);
type Decision = Parameters<Parameters<typeof PermissionPrompt>[0]['onRespond']>[0];
interface ResponseRecord { session: string; request: string; decision: Decision }

function Fixture() {
  const [active, setActive] = useState('A');
  const [responses, setResponses] = useState<ResponseRecord[]>([]);
  const location = useLocation();
  const navigate = useNavigate();
  const routeReady = location.pathname === `/cc-agent/${active}`;
  const onSessionClick: SessionClickHandler = (id, modifiers) => {
    if (hasSessionSelectionModifier(modifiers)) return;
    setActive(id);
    navigate(`/cc-agent/${id}`);
  };
  const renderSession = (session: Session) => {
    const Component = layout === 'rows' ? SessionItem : SessionCard;
    return <Component key={session.id} session={session}
      isActive={active === session.id} isRunning={false} hasAttentionNotification={false}
      onClick={onSessionClick} onAction={forbiddenAction}
      onRename={forbiddenAction} onTogglePin={forbiddenAction} />;
  };
  return <div className="flex h-screen flex-col bg-content-area text-foreground">
    <p className="shrink-0 border-b border-sidebar-border px-4 py-2 text-12">
      #6135 · 合成数据与导航壳 · 真实组件 · 非完整客户端
    </p>
    <div className="relative flex min-h-0 flex-1">
      {layout === 'rail' && <nav data-fixture-rail className="w-16 shrink-0 border-r border-sidebar-border bg-sidebar p-4">C</nav>}
      <aside data-fixture-panel style={{ width: panelWidth }}
        className={`shrink-0 border-r border-sidebar-border bg-sidebar p-3 ${layout === 'rail' ? 'absolute left-16 top-3 z-10' : ''}`}>
        <p className="mb-2 text-12 text-muted-foreground">置顶</p>
        <div data-fixture-entries>
          {fromFiles ? <SessionEntryList sessions={sessions} activeSessionId={active}
            navigationActiveSessionId={routeReady ? active : null}
            sessionVariant={layout === 'rows' ? 'text' : 'list'}
            runningSessionIds={emptyIds} attachedSessionIds={emptyIds}
            notifications={emptyIds} scheduleSessionIndex={emptySchedules}
            onSessionClick={onSessionClick} onAction={forbiddenAction}
            onRename={forbiddenAction} onTogglePin={forbiddenAction} onScheduleAction={forbiddenAction} />
            : layout === 'rows' ? sessions.map(renderSession)
              : <CardMasonry items={sessions} getId={(session) => session.id}
                renderItem={renderSession} onReorder={forbiddenReorder} reducedMotion />}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto" style={layout === 'rail' ? { paddingLeft: panelWidth } : undefined}>
        <header className="border-b border-sidebar-border px-6 py-4">演示任务 {active}</header>
        <section className="flex flex-col gap-3 p-6">
          <p data-fixture-route data-active-session={active} className="text-12 text-muted-foreground">{location.pathname}</p>
          {['A', 'B'].map((id) => <div key={id} data-fixture-permission={id}>
            <p className="mb-1 text-12 text-muted-foreground">演示任务 {id}</p>
            <PermissionPrompt keyboardShortcutsEnabled={routeReady && id === active}
              permission={{
                requestId: `request-${id}`,
                toolName: 'Bash',
                input: { command: 'echo synthetic-demo' },
                description: '仅验证界面响应，不执行命令。',
                suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
                  behavior: 'allow', destination: 'session' }],
              }}
              onRespond={(decision) => setResponses((previous) => [...previous,
                { session: id, request: `request-${id}`, decision }])} />
          </div>)}
          <output data-fixture-responses={JSON.stringify(responses)} className="text-12 text-muted-foreground">
            合成响应记录：{responses.length}
          </output>
        </section>
      </main>
    </div>
  </div>;
}

void mountPage({
  route: fromFiles ? '/cc-agent/files/A' : '/cc-agent/A',
  render: () => <Fixture />,
});
