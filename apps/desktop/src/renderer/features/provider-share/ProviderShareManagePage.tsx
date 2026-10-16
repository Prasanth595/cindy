/**
 * 「{供应商} · 远程与分享」页(供应商分享 §7.2；供应商组 §10)。从设置 → 模型供应商「允许被远程调用」一行的
 * 「远程与分享」入口进入，可返回。本机或同账号组所在电脑共用这一页，设置、分享与用量始终读取管理对象所在电脑。
 *
 * 打开期间每次 OWNED_CHANGED 都按当前时间段重读(main 因此保持快速拉取，申请能尽快出现)；
 * 关闭、恢复、删除、同意、拒绝都立即生效，结果以 toast 说明。
 */
import { ArrowLeft, ChevronRight, CircleMinus, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';

import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { useDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviders } from '@/hooks/useProviders';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ProviderGroupSection } from '@/features/provider-group/ProviderGroupSection';
import { providerManagementErrorKey, providerShareManagementCommand } from '@/features/provider-group/providerManagement';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProviderGroupConfig } from '../../../shared/providerGroup';

import type {
  ProviderOwnUsageView,
  ProviderShareMemberView,
  ProviderShareOwnerState,
  ProviderShareReshareView,
  ProviderShareUsageRange,
} from '../../../shared/providerShare';
import { ProviderShareLinkDialog } from './ProviderShareLinkDialog';
import { pendingResharesFromOwned, sharesClaudeLoginEmail, type ProviderShareGate, type ProviderSharePendingRequest } from './providerShareFormat';
import { ProviderUsageSection } from './ProviderUsageSection';
import { presentProviderShareApproval, publishProviderShareOwnerState, removeProviderSharePendingRequest } from './providerShareStore';
import { ShareAvatar } from './ShareAvatar';
import { useShareTimeFormat } from './useShareTimeFormat';

export type { ProviderShareGate };

export function ProviderShareManagePage({
  providerId,
  providerName,
  providerIcon,
  gate,
  deviceId,
  deviceName,
  initialGroup,
  remoteProvider,
  onBack,
}: {
  providerId: string;
  providerName: string;
  providerIcon: ReactNode;
  gate: ProviderShareGate;
  deviceId?: string;
  deviceName?: string;
  initialGroup?: ProviderGroupConfig;
  remoteProvider?: ProviderView;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const time = useShareTimeFormat();
  const devices = useDeviceLinkDeviceList();
  const { providers } = useProviders();
  const remoteCatalog = useDeviceProviders(deviceId);
  const selfDeviceName = deviceId ? deviceName ?? devices?.find((device) => device.deviceId === deviceId)?.name ?? null
    : devices?.find((device) => device.isSelf)?.name ?? null;
  const [remoteGroup, setRemoteGroup] = useState<ProviderGroupConfig | null>(initialGroup ?? null);
  const [range, setRange] = useState<ProviderShareUsageRange>('month');
  const [state, setState] = useState<ProviderShareOwnerState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadErrorKey, setLoadErrorKey] = useState<string | null>(null);
  const [own, setOwn] = useState<ProviderOwnUsageView | null>(null);
  const [ownFailed, setOwnFailed] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [approvalRequestId, setApprovalRequestId] = useState<string | null>(null);
  const approvalTriggerRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const loadSeq = useRef(0);
  const remoteLoadRange = useRef<ProviderShareUsageRange | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = useCallback(async () => {
    const range = rangeRef.current;
    if (deviceId && remoteLoadRange.current === range) return;
    remoteLoadRange.current = range;
    const seq = ++loadSeq.current;
    const owner = getDataOwnerGeneration();
    // 本机与我的其他电脑的用量读这台电脑自己的账本，不依赖分享服务，与分享的成员一起按同一个时间段读。
    const [owned, ownUsage] = await Promise.allSettled([
      providerShareManagementCommand({ action: 'owned', range }, deviceId),
      providerShareManagementCommand({ action: 'own-usage', providerId, range }, deviceId),
    ]);
    if (seq !== loadSeq.current) return;
    remoteLoadRange.current = null;
    if (!isDataOwnerGenerationCurrent(owner)) return;
    if (owned.status === 'fulfilled') {
      setState(owned.value);
      setLoadFailed(false);
      setLoadErrorKey(null);
      if (!deviceId) publishProviderShareOwnerState(owned.value);
    } else {
      setLoadFailed(true);
      setLoadErrorKey(providerManagementErrorKey(owned.reason, Boolean(deviceId)));
    }
    if (ownUsage.status === 'fulfilled') {
      setOwn(ownUsage.value);
      setOwnFailed(false);
    } else {
      setOwnFailed(true);
    }
  }, [providerId, deviceId]);

  useEffect(() => {
    void load();
  }, [load, range]);

  useEffect(() => {
    const off = window.electronAPI.providerShare.onOwnedChanged(() => void load());
    return () => {
      off();
      loadSeq.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!deviceId) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [deviceId, load]);

  // 同一个供应商在这台电脑上只应有一条分享；稳妥起见合并同供应商的全部记录。
  const { members, requests, reshares } = useMemo(() => {
    const shares = state?.ready ? state.shares.filter((share) => share.providerId === providerId) : [];
    const pending: ProviderSharePendingRequest[] = [];
    for (const share of shares) {
      for (const request of share.requests) {
        pending.push({
          request,
          share: { shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel },
          ...(deviceId ? { hostDeviceId: deviceId } : {}),
        });
      }
    }
    pending.sort((a, b) => Date.parse(a.request.createdAt) - Date.parse(b.request.createdAt));
    return {
      members: shares.flatMap((share) => share.members),
      requests: pending,
      // 转分享请求(provider-sharing.md §4.3)：成员想经自己的供应商组把这里分享的供应商转给别人用。
      reshares: pendingResharesFromOwned(shares),
    };
  }, [providerId, deviceId, state]);

  const approvalItem = requests.find((item) => item.request.requestId === approvalRequestId);
  const closeApproval = useCallback(() => {
    setApprovalRequestId(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!approvalItem) {
      setApprovalRequestId(null);
      return;
    }
    return presentProviderShareApproval(approvalItem, closeApproval, approvalTriggerRef.current);
  }, [approvalItem, closeApproval]);

  const withBusy = useCallback(async (key: string, run: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(key));
    try {
      await run();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const reject = useCallback(
    (item: ProviderSharePendingRequest) =>
      withBusy(item.request.requestId, async () => {
        try {
          await providerShareManagementCommand({ action: 'reject', requestId: item.request.requestId }, deviceId);
          // 远程管理时，本机生成链接带来的申请也在待审批里(由本机弹窗)，一并移除。
          removeProviderSharePendingRequest(item.request.requestId);
          toast.success(t('providerShare.toast.rejected', { name: item.request.displayName }));
        } catch (error) {
          toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
        }
        void load();
      }),
    [load, deviceId, t, withBusy],
  );

  const setMember = useCallback(
    (member: ProviderShareMemberView, status: 'pause' | 'resume' | 'remove') =>
      withBusy(member.memberId, async () => {
        try {
          await providerShareManagementCommand({ action: 'set-member', memberId: member.memberId, status }, deviceId);
          toast.success(
            t(
              status === 'pause'
                ? 'providerShare.toast.paused'
                : status === 'resume'
                  ? 'providerShare.toast.resumed'
                  : 'providerShare.toast.removed',
              { name: member.displayName },
            ),
          );
        } catch (error) {
          toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
        }
        void load();
      }),
    [load, deviceId, t, withBusy],
  );

  /** 转分享：同意、拒绝，或撤回已同意的；记录与运行中的任务都由供应商所在电脑处理。 */
  const decideReshare = useCallback(
    (reshare: ProviderShareReshareView, owner: string, decision: 'approve' | 'reject') =>
      withBusy(reshare.id, async () => {
        try {
          await providerShareManagementCommand({ action: 'reshare-decide', id: reshare.id, decision }, deviceId);
          toast.success(
            decision === 'approve'
              ? t('providerShare.manage.reshare.toastApproved', { name: reshare.name, owner, provider: providerName })
              : reshare.state === 'approved'
                ? t('providerShare.manage.reshare.toastRevoked', { name: reshare.name })
                : t('providerShare.manage.reshare.toastRejected', { name: reshare.name }),
          );
        } catch (error) {
          toast.error(t(providerManagementErrorKey(error, Boolean(deviceId))));
        }
        void load();
      }),
    [load, providerName, deviceId, t, withBusy],
  );

  const removeMember = useCallback(
    async (member: ProviderShareMemberView) => {
      const ok = await confirm({
        presentation: 'standard',
        title: t('providerShare.manage.removeConfirm.title', { name: member.displayName }),
        description: t('providerShare.manage.removeConfirm.description', {
          name: member.displayName,
          provider: providerName,
        }),
        confirmText: t('providerShare.manage.removeConfirm.confirm'),
        confirmVariant: 'destructive',
      });
      if (ok) await setMember(member, 'remove');
    },
    [confirm, providerName, setMember, t],
  );

  const ready = state?.ready === true;
  const canCreateLink = gate === 'on' && ready && !loadFailed;
  const providerForApproval = (deviceId ? remoteCatalog.providers : providers).find((provider) => provider.id === providerId);
  const sharesClaudeEmail = sharesClaudeLoginEmail(providerForApproval);
  // 审批只用当前目录中的目标供应商分类；进入管理页时的旧投影不能证明它仍然存在。
  const providerClassificationReady = providerForApproval !== undefined
    && (!deviceId || (!remoteCatalog.loading && remoteCatalog.error === null));

  return (
    // 这一页自己滚动(设置页外层在「模型供应商」分区不滚)。始终预留滚动条槽位：展开组内电脑的配额、
    // 加载出已分享的人等让内容超过一屏时，滚动条出现不再把整页挤窄 12px(2026-10-11 用户反馈宽度跳变)。
    // 槽位用 -mr-3 挪进外层右侧留白，内容宽度与「模型供应商」卡片保持一致。
    <div
      className="-mr-3 flex h-full min-h-0 flex-col overflow-y-auto pb-8 [scrollbar-gutter:stable]"
      data-testid="provider-share-manage"
    >
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex h-8 shrink-0 items-center gap-2 self-start rounded-full px-2 text-13 font-medium text-[var(--settings-section-sublabel)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--settings-section-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <ArrowLeft size={16} aria-hidden />
        {t('settings.providers.title')}
      </button>

      {/* 标题已经说明这页是什么；这台电脑的名字由组里本机那一行承载，不在这里重复一遍。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--settings-integration-avatar-border)] bg-[var(--settings-integration-avatar-bg)] text-[var(--settings-integration-avatar-icon)]"
        >
          {providerIcon}
        </div>
        <h2 className="min-w-0 flex-1 text-16 font-medium leading-[1.3] text-[var(--settings-section-title)]">
          {t('providerGroup.page.title', { provider: providerName })}
        </h2>
        <Button variant="cta" size="md" disabled={!canCreateLink} onClick={() => setLinkOpen(true)}>
          {t('providerShare.manage.createLink')}
        </Button>
      </div>

      {deviceId && (
        <p className="mt-2 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('providerGroup.management.note', { device: selfDeviceName ?? deviceId })}
        </p>
      )}
      {(gate !== 'on' || (state && !ready) || loadFailed) && (
        <p
          role="status"
          className="mt-4 shrink-0 rounded-lg bg-[var(--surface-chip)] px-3 py-2.5 text-12 leading-[1.5] text-[var(--text-secondary)]"
        >
          {gate === 'remote-off'
            ? t('providerShare.manage.gateRemoteControl')
            : gate === 'invocation-off'
              ? t('providerShare.manage.gateInvocation')
              : loadFailed
                ? t(deviceId && loadErrorKey ? loadErrorKey : 'providerShare.manage.loadFailed')
                : t('providerShare.manage.notReady')}
        </p>
      )}

      {(requests.length > 0 || reshares.length > 0) && (
        <section className="mt-6 shrink-0" aria-labelledby="provider-share-pending-title">
          <h3 id="provider-share-pending-title" className="mb-2 text-13 font-medium text-[var(--settings-section-title)]">
            {t('providerShare.manage.pending.title')}
          </h3>
          <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
            {requests.map((item, index) => (
              <div
                key={item.request.requestId}
                data-testid="provider-share-pending-row"
                className={cn(
                  'flex flex-wrap items-center gap-3 px-4 py-3',
                  index > 0 && 'border-t border-[var(--settings-theme-card-border)]',
                )}
              >
                <ShareAvatar displayName={item.request.displayName} avatarUrl={item.request.avatarUrl} />
                <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-2 text-13">
                    <span className="font-medium text-[var(--text-primary)]">{item.request.displayName}</span>
                    <span className="text-12 text-[var(--text-secondary)]">{t('providerShare.manage.pending.applying')}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]">
                    <span>
                      {t('providerShare.pairing.label')}{' '}
                      <span className="select-text font-medium tracking-[0.06em] text-[var(--text-primary)] [font-variant-numeric:tabular-nums]">
                        {item.request.pairingCode}
                      </span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{t('providerShare.manage.pending.requestedAt', { time: time.relative(Date.parse(item.request.createdAt)) })}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t('providerShare.manage.pending.expiresHint')}</span>
                  </div>
                  {sharesClaudeEmail && (
                    <p data-testid="provider-share-claude-email-callout" className="text-12 leading-[1.5] text-[var(--text-secondary)]">
                      {t('providerShare.approve.calloutClaudeEmail', { name: item.request.displayName })}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    disabled={loadFailed || busy.has(item.request.requestId)}
                    onClick={() => void reject(item)}
                  >
                    {t('providerShare.approve.reject')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    compact
                    disabled={loadFailed || !providerClassificationReady || busy.has(item.request.requestId)}
                    onClick={(event) => {
                      approvalTriggerRef.current = event.currentTarget;
                      setApprovalRequestId(item.request.requestId);
                    }}
                  >
                    {t('providerShare.approve.approve')}
                  </Button>
                </div>
              </div>
            ))}
            {reshares.map((item, index) => (
              <div
                key={item.reshare.id}
                data-testid="provider-share-reshare-row"
                className={cn(
                  'flex flex-wrap items-center gap-3 px-4 py-3',
                  (requests.length > 0 || index > 0) && 'border-t border-[var(--settings-theme-card-border)]',
                )}
              >
                <ShareAvatar displayName={item.reshare.name} avatarUrl={item.reshare.avatarUrl} />
                <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-2 text-13">
                    <span className="font-medium text-[var(--text-primary)]">{item.reshare.name}</span>
                    <span className="text-12 text-[var(--text-secondary)]">
                      {t('providerShare.manage.reshare.applying', { owner: item.owner.displayName })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]">
                    <span>{t('providerShare.manage.reshare.requestedAt', { time: time.relative(item.reshare.requestedAt) })}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t('providerShare.manage.reshare.usageHint', { name: item.reshare.name, owner: item.owner.displayName })}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    compact
                    disabled={loadFailed || busy.has(item.reshare.id)}
                    onClick={() => void decideReshare(item.reshare, item.owner.displayName, 'reject')}
                  >
                    {t('providerShare.manage.reshare.reject')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    compact
                    disabled={loadFailed || !providerClassificationReady || busy.has(item.reshare.id)}
                    onClick={() => void decideReshare(item.reshare, item.owner.displayName, 'approve')}
                  >
                    {t('providerShare.manage.reshare.approve')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <ProviderGroupSection
        providerId={providerId} providerName={providerName} deviceId={deviceId} deviceName={deviceName}
        initialConfig={initialGroup} remoteProvider={remoteProvider} onConfigChange={setRemoteGroup}
      />

      <ProviderUsageSection
        providerId={providerId}
        providerName={providerName}
        own={own}
        ownFailed={ownFailed}
        members={members}
        membersLoading={!state && !loadFailed}
        selfDeviceName={selfDeviceName}
        ownerDeviceId={deviceId}
        groupConfig={deviceId ? remoteGroup : undefined}
        range={range}
        onRangeChange={setRange}
        time={time}
      />

      <section className="mt-6 shrink-0" aria-labelledby="provider-share-members-title">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 id="provider-share-members-title" className="text-13 font-medium text-[var(--settings-section-title)]">
            {t('providerShare.manage.members.title')}
          </h3>
          {members.length > 0 && <span className="text-13 text-[var(--text-tertiary)]">{members.length}</span>}
        </div>
        <div className="overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
          {members.length === 0 ? (
            <p className="px-4 py-7 text-center text-13 leading-[1.5] text-[var(--text-secondary)]">
              {/* 分享服务未就绪时列表为空不代表没分享给任何人：上方提示已说明原因。 */}
              {state?.ready
                ? t('providerShare.manage.members.empty')
                : state || loadFailed
                  ? '—'
                  : t('providerShare.manage.loading')}
            </p>
          ) : (
            members.map((member, index) => (
              <MemberRow
                key={member.memberId}
                member={member}
                first={index === 0}
                busy={loadFailed || busy.has(member.memberId)}
                time={time}
                onPause={() => void setMember(member, member.status === 'paused' ? 'resume' : 'pause')}
                onRemove={() => void removeMember(member)}
                reshareBusy={(id) => loadFailed || busy.has(id)}
                canApproveReshare={providerClassificationReady}
                onReshare={(reshare, decision) => void decideReshare(reshare, member.displayName, decision)}
              />
            ))
          )}
        </div>
      </section>

      {linkOpen && (
        <ProviderShareLinkDialog
          deviceId={deviceId}
          providerId={providerId}
          providerLabel={providerName}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  first,
  busy,
  time,
  onPause,
  onRemove,
  reshareBusy,
  canApproveReshare,
  onReshare,
}: {
  member: ProviderShareMemberView;
  first: boolean;
  busy: boolean;
  time: ReturnType<typeof useShareTimeFormat>;
  onPause: () => void;
  onRemove: () => void;
  reshareBusy: (id: string) => boolean;
  canApproveReshare: boolean;
  onReshare: (reshare: ProviderShareReshareView, decision: 'approve' | 'reject') => void;
}) {
  const { t } = useTranslation();
  const paused = member.status === 'paused';
  // 转分享里已处理过的人(待处理的在上方「待处理」一栏)：可以撤回已同意的，或改为同意。
  const decided = (member.reshares ?? []).filter((reshare) => reshare.state !== 'pending');
  const approvedCount = decided.filter((reshare) => reshare.state === 'approved').length;
  const declinedCount = decided.length - approvedCount;
  // 这些人默认收起成一行摘要，点开才逐人列出(2026-10-16 用户要求可折叠)。
  const [reshareOpen, setReshareOpen] = useState(false);
  const reshareListId = useId();
  const statusText = paused
    ? t('providerShare.manage.members.statusPaused')
    : member.runningTasks > 0
      ? t('providerShare.manage.members.statusRunning', { count: member.runningTasks })
      : t('providerShare.manage.members.statusActive');
  const moreLabel = t('providerGroup.member.moreAria', { name: member.displayName });
  // 用量在上方「用量」块里按人列出(供应商组 §10)，这里只管分享本身。
  return (
    <div className={cn(!first && 'border-t border-[var(--settings-theme-card-border)]')}>
      {/* 有转分享摘要时信息列多一行，头像和操作贴着第一行；没有时保持居中。 */}
      <div
        data-testid="provider-share-member-row"
        className={cn('flex flex-wrap gap-3 px-4 py-3', decided.length > 0 ? 'items-start' : 'items-center')}
      >
        <ShareAvatar
          displayName={member.displayName}
          avatarUrl={member.avatarUrl}
          className={cn(paused && 'opacity-70')}
        />
        <div className="flex min-w-[180px] flex-1 flex-col gap-0.5">
          <div className={cn('flex flex-wrap items-center gap-2 text-13', paused && 'opacity-70')}>
            <span className="font-medium text-[var(--text-primary)]">{member.displayName}</span>
            <span className="inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  paused ? 'bg-[var(--remote-status-disconnected)]' : 'bg-[var(--remote-status-ready)]',
                )}
              />
              {statusText}
            </span>
          </div>
          <div className={cn('flex flex-wrap gap-1.5 text-12 text-[var(--text-secondary)]', paused && 'opacity-70')}>
            <span>{t('providerShare.manage.members.joined', { date: time.date(Date.parse(member.joinedAt)) })}</span>
            <span aria-hidden="true">·</span>
            <span>
              {member.lastUsedAt
                ? t('providerShare.manage.members.lastUsed', { time: time.relative(member.lastUsedAt) })
                : t('providerShare.manage.members.neverUsed')}
            </span>
          </div>
          {decided.length > 0 && (
            // 经这个成员的供应商组转给别人用的人(provider-sharing.md §4.3)：收起时只是一行摘要，挂在这个成员名下。
            <button
              type="button"
              data-testid="provider-share-reshare-toggle"
              aria-expanded={reshareOpen}
              aria-controls={reshareOpen ? reshareListId : undefined}
              onClick={() => setReshareOpen((open) => !open)}
              className="group -ml-1 mt-1.5 flex w-fit max-w-full items-center gap-2 rounded-full py-0.5 pl-1 pr-2 text-left text-12 text-[var(--text-secondary)] transition-colors motion-reduce:transition-none hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <ChevronRight
                size={14}
                aria-hidden="true"
                className={cn(
                  'shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 motion-reduce:transition-none group-hover:text-[var(--text-secondary)]',
                  reshareOpen && 'rotate-90',
                )}
              />
              <span aria-hidden="true" className="flex shrink-0">
                {decided.slice(0, 3).map((reshare, index) => (
                  <ShareAvatar
                    key={reshare.id}
                    displayName={reshare.name}
                    avatarUrl={reshare.avatarUrl}
                    size="xs"
                    className={cn('ring-2 ring-[var(--settings-theme-card-bg)]', index > 0 && '-ml-1.5')}
                  />
                ))}
              </span>
              <span className="min-w-0 truncate">
                {approvedCount > 0
                  ? t('providerShare.manage.reshare.summaryUsing', { count: approvedCount, owner: member.displayName })
                  : t('providerShare.manage.reshare.summaryOwner', { owner: member.displayName })}
                {declinedCount > 0 && ` · ${t('providerShare.manage.reshare.summaryDeclined', { count: declinedCount })}`}
              </span>
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" compact disabled={busy} onClick={onPause}>
            {t(paused ? 'providerShare.manage.members.resume' : 'providerShare.manage.members.pause')}
          </Button>
          {/* 删除不可撤销且要二次确认：收进「⋯」，与供应商组里移除电脑同一写法，行内不再挂红字。 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Tip text={moreLabel}>
                <button
                  type="button"
                  aria-label={moreLabel}
                  disabled={busy}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                >
                  <MoreHorizontal size={18} />
                </button>
              </Tip>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="danger"
                disabled={busy}
                aria-label={t('providerShare.manage.members.removeAria', { name: member.displayName })}
                onClick={onRemove}
              >
                <CircleMinus size={18} className="mr-2.5" />
                {t('providerShare.manage.members.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {decided.length > 0 && (
        <Collapse open={reshareOpen} id={reshareListId}>
          {/* 与昵称一列左对齐(px-4 + 头像 32 + gap-3 = ml-11 之后)，浅底小框把这几个人圈成一组。 */}
          <div className="px-4 pb-3">
            <div
              data-testid="provider-share-reshare-list"
              className="ml-11 overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface)]"
            >
              {decided.map((reshare, index) => {
                const approved = reshare.state === 'approved';
                return (
                  <div
                    key={reshare.id}
                    data-testid="provider-share-reshare-item"
                    className={cn(
                      'flex items-center gap-2.5 py-2 pl-3 pr-2',
                      index > 0 && 'border-t border-[var(--border-default)]',
                    )}
                  >
                    <ShareAvatar
                      displayName={reshare.name}
                      avatarUrl={reshare.avatarUrl}
                      size="sm"
                      className={cn(!approved && 'opacity-70')}
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-2 text-13">
                      <span className={cn('truncate text-[var(--text-primary)]', !approved && 'opacity-70')}>
                        {reshare.name}
                      </span>
                      <span className="shrink-0 text-12 text-[var(--text-secondary)]">
                        {t(approved ? 'providerShare.manage.reshare.stateApproved' : 'providerShare.manage.reshare.stateRejected')}
                      </span>
                    </span>
                    {/* 撤回后还能改回同意，不是破坏性操作：用安静按钮，红色只留给删除分享。 */}
                    <Button
                      variant="secondary"
                      tone="quiet"
                      size="sm"
                      compact
                      disabled={reshareBusy(reshare.id) || (!approved && !canApproveReshare)}
                      aria-label={t(
                        approved ? 'providerShare.manage.reshare.revokeAria' : 'providerShare.manage.reshare.approveAria',
                        { name: reshare.name },
                      )}
                      onClick={() => onReshare(reshare, approved ? 'reject' : 'approve')}
                    >
                      {t(approved ? 'providerShare.manage.reshare.revoke' : 'providerShare.manage.reshare.approve')}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </Collapse>
      )}
    </div>
  );
}
