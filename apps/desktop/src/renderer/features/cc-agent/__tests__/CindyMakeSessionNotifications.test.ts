import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import { BOT_GROUP_LANE_SESSION, findSessionNotificationSession, isBackgroundTaskNotificationTarget } from '@/lib/sessionEventNotification';
import { isReviewSessionSource } from '../../../../shared/sessionSource';
import {
  formatOrcaWorkerNotificationTitle,
  shouldNotifyOrcaWorkerEvent,
} from '../lib/orcaLeadWorkerAttention';

const source = ts.createSourceFile('sidebar.tsx', readFileSync(resolve(
  process.cwd(), 'src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx',
), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expanded = source.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'ExpandedView',
)!;
const declarationNames = new Set([
  'sessions', 'visibleRemoteSessionsForNotification', 'sessionsRef',
  'allSessionsForNotificationRef', 'remoteSessionsForNotificationRef',
  'unnamedLabelRef', 'fireSessionNotification',
]);
const refNames = new Set([
  'sessionsRef', 'allSessionsForNotificationRef', 'remoteSessionsForNotificationRef', 'unnamedLabelRef',
]);
const statements = expanded.body!.statements.filter(statement => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declarationNames.has(declaration.name.text),
    );
  }
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
  const target = statement.expression.left;
  return ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)
    && refNames.has(target.expression.text);
});
const emitted = ts.transpileModule(
  statements.map(statement => statement.getText(source)).join('\n') + '\nreturn fireSessionNotification;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

type NotificationSession = {
  id: string;
  title: string;
  source: string;
  status?: 'active' | 'archived';
  deviceLinkDeviceId?: string;
  hiddenAt?: string | null;
  orcaRole?: 'lead' | 'worker';
};
const send = vi.fn();
const reviewTarget = vi.fn(async () => false);
const botTitle = vi.fn(async (): Promise<string | null> => null);
const leadOfWorker = vi.fn<(workerSessionId: string) => string | null>(() => null);
beforeEach(() => { vi.clearAllMocks(); });

function dispatcher(local: NotificationSession[], remote: NotificationSession[] = []) {
  const bindings = {
    useMemo: (factory: () => unknown) => factory(),
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    sessionsHook: { sessions: local.filter(session => session.status !== 'archived') },
    allSessionsForAttention: local.filter(session => !isCindyMakeSource(session.source)),
    allSessionsForNotification: local,
    remoteSessionsForNotification: remote,
    CINDY_MAKE_ENABLED: false,
    isCindyMakeSource,
    findSessionNotificationSession,
    isOrcaWorkerSession,
    isReviewSessionSource,
    projectDraftSessionTitle,
    sendSessionEventNotification: send,
    isReviewSessionNotificationTarget: reviewTarget,
    isBackgroundTaskNotificationTarget,
    botOwnedSessionNotificationTitle: botTitle,
    BOT_GROUP_LANE_SESSION,
    shouldNotifyOrcaWorkerEvent,
    formatOrcaWorkerNotificationTitle,
    findOrcaLeadSessionIdForWorker: leadOfWorker,
    t: () => 'Unnamed task',
  };
  return new Function(...Object.keys(bindings), emitted)(...Object.values(bindings)) as (
    sessionId: string, kind: 'done' | 'error' | 'needs-reply',
  ) => void;
}

describe('disabled Make notification dispatch', () => {
  it.each(['cindy-make', 'cindy-make-merge'].flatMap(source =>
    (['local', 'archived', 'remote'] as const).flatMap(location =>
      (['done', 'error', 'needs-reply'] as const).map(kind => ({ source, location, kind })),
    ),
  ))('suppresses $kind for $location $source metadata omitted from UI lists', async ({ source, location, kind }) => {
    const session: NotificationSession = {
      id: 'hidden', title: 'Hidden Make task', source,
      status: location === 'archived' ? 'archived' : 'active',
      ...(location === 'remote' ? { deviceLinkDeviceId: 'host' } : {}),
    };
    const fire = dispatcher(location === 'remote' ? [] : [session], location === 'remote' ? [session] : []);
    fire('hidden', kind);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(reviewTarget).not.toHaveBeenCalled();
    expect(botTitle).not.toHaveBeenCalled();
  });

  it('keeps ordinary local and remote notifications', () => {
    dispatcher([{ id: 'ordinary', title: 'Ordinary task', source: 'desktop' }])('ordinary', 'done');
    expect(send).toHaveBeenCalledWith('ordinary', 'Ordinary task', 'done', {
      remoteDevice: false, remoteDeviceId: undefined,
    });
    dispatcher([], [{ id: 'remote', title: 'Remote task', source: 'desktop', deviceLinkDeviceId: 'host' }])('remote', 'needs-reply');
    expect(send).toHaveBeenCalledWith('remote', 'Remote task', 'needs-reply', {
      remoteDevice: true, remoteDeviceId: 'host',
    });
  });

  it('suppresses plugin background tasks and notifies again once they are shown', () => {
    dispatcher([{ id: 'bg', title: 'Background', source: 'plugin', hiddenAt: '2026-10-15T00:00:00.000Z' }])('bg', 'done');
    expect(send).not.toHaveBeenCalled();
    expect(reviewTarget).not.toHaveBeenCalled();
    dispatcher([{ id: 'bg', title: 'Background', source: 'plugin', hiddenAt: null }])('bg', 'done');
    expect(send).toHaveBeenCalledWith('bg', 'Background', 'done', { remoteDevice: false, remoteDeviceId: undefined });
  });

  it('preserves the unknown-task fallback', async () => {
    dispatcher([])('unknown', 'error');
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith('unknown', 'Unnamed task', 'error');
  });

  it('passes unfiltered local and remote metadata to notification dispatch', () => {
    let rawRemote: string | undefined;
    const props = new Map<string, string>();
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'remoteProjectSessionsRaw' && !rawRemote) {
        rawRemote = node.initializer?.getText(source);
      }
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'ExpandedView') {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
            props.set(attribute.name.getText(source), attribute.initializer.expression?.getText(source) ?? '');
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(rawRemote).toContain('useSyncExternalStore');
    expect(rawRemote).toContain('remoteProjectsStore.getMergedRemoteSessions');
    expect(props.get('allSessionsForNotification')).toBe('allSessionsForAttentionRaw');
    expect(props.get('remoteSessionsForNotification')).toBe('remoteProjectSessionsRaw');
  });
});

describe('Orca Worker notification dispatch', () => {
  const lead: NotificationSession = { id: 'lead', title: '重构登录', source: 'desktop', orcaRole: 'lead' };
  const worker: NotificationSession = {
    id: 'worker', title: 'Worker · developer', source: 'desktop', orcaRole: 'worker',
  };

  it('Worker 的完成仍不单独通知', () => {
    leadOfWorker.mockReturnValue('lead');
    dispatcher([lead, worker])('worker', 'done');
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['error', 'needs-reply'] as const)('Worker 的 %s 以「Lead 标题 · Worker 标题」单独通知', (kind) => {
    leadOfWorker.mockReturnValue('lead');
    dispatcher([lead, worker])('worker', kind);
    expect(leadOfWorker).toHaveBeenCalledWith('worker');
    expect(send).toHaveBeenCalledWith('worker', '重构登录 · Worker · developer', kind);
  });

  it('找不到 Lead 时退回 Worker 标题', () => {
    leadOfWorker.mockReturnValue(null);
    dispatcher([worker])('worker', 'error');
    expect(send).toHaveBeenCalledWith('worker', 'Worker · developer', 'error');
  });

  it('远程控制另一台电脑的 Worker 不在范围内', () => {
    leadOfWorker.mockReturnValue('lead');
    dispatcher([], [{ ...worker, deviceLinkDeviceId: 'host' }])('worker', 'error');
    expect(send).not.toHaveBeenCalled();
  });
});
