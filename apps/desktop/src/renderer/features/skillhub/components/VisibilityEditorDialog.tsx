import { DepartmentAudienceField } from './DepartmentAudienceField';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
/**
 * VisibilityEditorDialog — 「管理可见性」弹窗,对齐 SkillHub 工作台同名能力。
 *
 * 归属由新服务根据当前 membership 固定：个人 Skill 只允许
 * public/private，组织 Skill 只允许 public/shared。客户端不再提供归属转移。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { Globe, Lock, Users, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import { useSkillhubIdentityPolicy } from '../hooks/useSkillhubIdentityPolicy';

import { VisibilityCard } from '../PublishDialog';
import { marketActionErrorMessage } from '../lib/marketErrors';

export type VisibilityTier = 'public' | 'team' | 'private';

type VisibilityEditorDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已发布 skill 的 slug */
  skillName: string;
  /** 当前可见档位(回显「当前」徽标) */
  currentTier: VisibilityTier;
  /** 当前归属:org = 团队归属 */
  currentOwnerType?: string;
  publicReview?: { status: 'pending' | 'rejected'; reason?: string };
  /** 保存成功后回调(父组件刷新详情) */
  onSaved: () => void;
  /** viewer 等无写权限时:弹窗只读打开(控件禁用 + 顶部提示),不能保存。 */
  readOnly?: boolean;
};

export function VisibilityEditorDialog({
  open,
  onOpenChange,
  skillName,
  currentTier,
  currentOwnerType,
  publicReview,
  onSaved,
  readOnly = false,
}: VisibilityEditorDialogProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const dialogOwner = useMemo(() => getDataOwnerGeneration(), [open]);
  const isDialogOwnerCurrent = isDataOwnerGenerationCurrent(dialogOwner);
  useEffect(() => {
    if (open && !isDialogOwnerCurrent) onOpenChange(false);
  }, [open, isDialogOwnerCurrent, onOpenChange]);
  const identityPolicy = useSkillhubIdentityPolicy(user);
  const currentOwnerIsTeam = currentOwnerType === 'org' || currentOwnerType === 'organization'
    || currentTier === 'team' || identityPolicy.ownerType === 'organization';

  // loading 初始为 true,且关闭时复位 —— Dialog 在数据就绪前不挂载,
  // 避免"先弹出矮窗再撑开"的跳变(设计规范:拿到数据后一次成型)。
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [audienceMode, setAudienceMode] = useState<'all' | 'departments'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [audienceValid, setAudienceValid] = useState(false);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string>();
  const [reload, setReload] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [tier, setTier] = useState<VisibilityTier>(currentTier);

  useEffect(() => {
    if (!open) { setLoading(true); return; }
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    setTier(currentTier); setLoadError(null); setConflict(false); setLoading(true); setExpectedUpdatedAt(undefined);
    void window.electronAPI.skillhub.getPublishedVisibility(skillName).then(result => {
      if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
      if (!result.success || (currentOwnerIsTeam && (!result.audienceSupported || !result.updatedAt))) {
        setLoadError(t('skillhub.audience.loadError')); return;
      }
      setExpectedUpdatedAt(result.updatedAt);
      setSelected(result.visibleDepts ?? []);
      setAudienceMode(result.visibleDepts?.length ? 'departments' : 'all');
      if (result.visibility) setTier(result.visibility === 'shared' ? 'team' : result.visibility);
    }).catch(() => { if (!cancelled && isDataOwnerGenerationCurrent(owner)) setLoadError(t('skillhub.audience.loadError')); })
      .finally(() => { if (!cancelled && isDataOwnerGenerationCurrent(owner)) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, currentTier, currentOwnerIsTeam, skillName, reload, t]);

  // ── 校验(对齐 SkillHub StepMeta/管理弹窗规则) ──────────────────────────
  // ── 影响提示(SkillHub origin/main 同款文案) ───────────────────────────
  const tierChanged = tier !== currentTier;
  const leavingMarket = currentTier === 'public' && tier !== 'public';
  const teamOwnedToPrivate = currentOwnerIsTeam && tier === 'private';
  const tierAllowed = identityPolicy.allowedVisibilities.includes(
    tier === 'team' ? 'DEPARTMENT_SCOPED' : tier.toUpperCase() as 'PUBLIC' | 'PRIVATE',
  );
  const impactText = useMemo(() => {
    if (tier === 'private') {
      if (teamOwnedToPrivate) {
        return leavingMarket
          ? t('skillhub.visibilityEditor.impactPrivateTeamLeavingMarket')
          : t('skillhub.visibilityEditor.impactPrivateTeam');
      }
      if (leavingMarket) return t('skillhub.visibilityEditor.impactPrivateLeavingMarket');
      return tierChanged ? t('skillhub.visibilityEditor.impactPrivate') : null;
    }
    if (tier === 'team') {
      if (leavingMarket) return t('skillhub.visibilityEditor.impactTeamLeavingMarket');
      return tierChanged ? t('skillhub.visibilityEditor.impactTeam') : null;
    }
    return tierChanged ? t('skillhub.visibilityEditor.impactPublic') : null;
  }, [tier, tierChanged, leavingMarket, teamOwnedToPrivate, t]);

  const chooseTier = (next: VisibilityTier) => {
    setTier(next);
  };

  const handleSave = async () => {
    if (!isDataOwnerGenerationCurrent(dialogOwner)) return;
    const publishVisibility = tier === 'team' ? 'DEPARTMENT_SCOPED' : tier.toUpperCase();
    if (!identityPolicy.allowedVisibilities.includes(publishVisibility as 'PUBLIC' | 'DEPARTMENT_SCOPED' | 'PRIVATE')) return;
    setSaving(true);
    try {
      const visibility = tier === 'team' ? 'shared' as const : tier;
      const previousCatalogScope = currentTier === 'public'
        ? 'market' as const
        : currentTier === 'team'
          ? 'team' as const
          : undefined;
      // 归属由服务端根据当前 membership 固定，客户端只修改可见性。
      const visRes = await window.electronAPI.skillhub.setPublishedVisibility({
        name: skillName,
        visibility,
        previousCatalogScope,
        ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        ...(tier === 'team' ? { audienceMode, visibilityDepartmentIds: audienceMode === 'all' ? [] : selected } : {}),
      });
      if (!isDataOwnerGenerationCurrent(dialogOwner)) return;
      if (!visRes.success) {
        if (visRes.errorCode === 'SKILL_DISTRIBUTION_CONFLICT') setConflict(true);
        toast.error(marketActionErrorMessage(visRes.error, visRes.errorCode));
        return;
      }
      toast.success(visRes.result?.reviewStatus === 'pending'
        ? t('skillhub.visibilityEditor.publicReviewSubmitted')
        : t('skillhub.visibilityEditor.saved'));
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open && !loading} onOpenChange={(v) => { if (!saving) onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="modal-scrim fixed inset-0 z-[10000]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[480px]',
            'max-h-[85vh] flex flex-col overflow-hidden',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-describedby={undefined}
        >
          <div className="flex shrink-0 items-start justify-between px-5 pt-5">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-lg font-medium text-[var(--msg-assistant-text)]">
                {t('skillhub.visibilityEditor.title')}
              </Dialog.Title>
              <span className="text-xs text-[var(--cmd-palette-item-meta)]">{skillName}</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full',
                'text-[var(--settings-theme-icon)] hover:bg-[var(--confirm-btn-secondary-hover)]',
                'transition-colors',
              )}
              aria-label={t('skillhub.publishDialog.closeAria')}
            >
              <X size={15} />
            </button>
          </div>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pt-4 pb-1">
            {loading ? <p role="status">{t('skillhub.audience.loading')}</p> : loadError ? (
              <div role="alert">{loadError}<Button type="button" variant="secondary" size="sm" onClick={() => setReload(n => n + 1)}>{t('skillhub.audience.retry')}</Button></div>
            ) : (
              <>
                {readOnly ? (
                  <div className="rounded-lg px-3 py-2 text-xs bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]">
                    {t('skillhub.market.noManagePermission')}
                  </div>
                ) : null}
                {publicReview ? (
                  <div className="rounded-lg px-3 py-2 text-xs bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]">
                    {publicReview.status === 'pending'
                      ? t('skillhub.visibilityEditor.publicReviewPending')
                      : t('skillhub.visibilityEditor.publicReviewRejected', { reason: publicReview.reason || '—' })}
                  </div>
                ) : null}
                {/* 可见范围三卡(与发布弹窗共用 VisibilityCard) */}
                <div className="flex flex-col gap-1.5">
                  <span className="block px-0.5 text-13 font-medium text-[var(--settings-section-desc)]">
                    {t('skillhub.visibilityEditor.tierLabel')}
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    <VisibilityCard
                      value="PUBLIC"
                      label={t('skillhub.visibilityEditor.tierPublic')}
                      description={t('skillhub.visibilityEditor.tierPublicDesc')}
                      icon={<Globe size={14} strokeWidth={1.75} />}
                      disabled={readOnly}
                      selected={tier === 'public'}
                      onSelect={() => chooseTier('public')}
                    />
                    {identityPolicy.ownerType === 'organization' ? (
                      <VisibilityCard
                        value="DEPARTMENT_SCOPED"
                        label={t('skillhub.visibilityEditor.tierTeam')}
                        description={t('skillhub.visibilityEditor.tierTeamDesc')}
                        icon={<Users size={14} strokeWidth={1.75} />}
                        disabled={readOnly}
                        selected={tier === 'team'}
                        onSelect={() => chooseTier('team')}
                      />
                    ) : (
                      <VisibilityCard
                        value="PRIVATE"
                        label={t('skillhub.visibilityEditor.tierPrivate')}
                        description={t('skillhub.visibilityEditor.tierPrivateDesc')}
                        icon={<Lock size={14} strokeWidth={1.75} />}
                        disabled={readOnly}
                        selected={tier === 'private'}
                        onSelect={() => chooseTier('private')}
                      />
                    )}
                  </div>
                </div>

                {tier === 'team' && <DepartmentAudienceField mode={audienceMode} selected={selected}
                  disabled={readOnly || saving} onValidityChange={setAudienceValid}
                  onChange={(mode, ids) => { setAudienceMode(mode); setSelected(ids); }} />}
                {conflict && <div role="alert">{t('skillhub.audience.conflict')}<Button variant="secondary" size="sm" type="button" onClick={() => setReload(n => n + 1)}>{t('skillhub.audience.reload')}</Button></div>}
                {/* 影响提示 */}
                {impactText ? (
                  <div
                    className={cn(
                      'rounded-xl px-3.5 py-3 text-xs leading-[1.6]',
                      teamOwnedToPrivate
                        ? 'bg-[var(--error-bg)] text-[var(--error-fg)]'
                        : 'bg-[var(--chat-input-chip-bg)] text-[var(--settings-source-meta)]',
                    )}
                  >
                    {impactText}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 p-4">
            <Button
              variant="secondary"
              size="md"
              compact
              type="button"
              onClick={() => onOpenChange(false)}
            >
              {t('skillhub.publishDialog.cancel')}
            </Button>
            <Button
              variant="cta"
              size="md"
              compact
              loading={saving}
              type="button"
              disabled={!isDataOwnerGenerationCurrent(dialogOwner) || loading || saving || (tier === 'team' && !audienceValid) || Boolean(loadError) || !tierAllowed || readOnly
                || (tier === 'public' && currentTier !== 'public' && publicReview?.status === 'pending')}
              onClick={() => void handleSave()}
            >
              { tier === 'public' && currentTier !== 'public'
                  ? publicReview?.status === 'pending'
                    ? t('skillhub.visibilityEditor.waitingReview')
                    : t('skillhub.visibilityEditor.submitReview')
                  : t('skillhub.visibilityEditor.save')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
