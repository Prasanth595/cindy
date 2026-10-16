/**
 * 伙伴设置里的「主力电脑」一行（docs/product-rules/cloud-companions.md §3.1）：本机是主力电脑时
 * 显示「这台电脑」，点开列出可接手的其他电脑；确认后交出去并打开那台电脑上的伙伴。
 * 服务器不支持云端伙伴时整行不出现。
 */
import { useRef, useState } from 'react';
import { ChevronRight, Monitor } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import type { CompanionCloudFailureCode, CompanionTransferTarget } from '../../../shared/companionCloud';
import { companionCloudApi, refreshCompanionCloud, useCompanionCloud } from './companionCloudStore';

const TRANSFER_ERROR_KEYS: Record<CompanionCloudFailureCode, string> = {
  HOME_CONFLICT: 'bots.cloud.transferConflict',
  OFFLINE: 'bots.cloud.transferOffline',
  NOT_ENABLED: 'bots.cloud.notEnabled',
  TARGET_UNAVAILABLE: 'bots.cloud.targetUnavailable',
  FAILED: 'bots.cloud.transferFailed',
  BUSY: 'bots.cloud.transferBusy',
};

export function BotHomeComputerSetting({ bot }: { bot: { id: string; name: string; status?: string } }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cloud = useCompanionCloud();
  const [targets, setTargets] = useState<CompanionTransferTarget[] | null>(null);
  const [targetsFailed, setTargetsFailed] = useState(false);
  const [pending, setPending] = useState<CompanionTransferTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const actor = cloud.enabled ? cloud.actors.find((candidate) => candidate.externalId === bot.id) : undefined;
  if (!actor || !cloud.selfDeviceId || actor.homeDeviceId !== cloud.selfDeviceId) return null;

  // Only a running companion syncs (and so can be handed over); a paused one is resumed first.
  const movable = bot.status === undefined || bot.status === 'active';
  const loadTargets = () => {
    if (!movable) return;
    setTargets(null);
    setTargetsFailed(false);
    const api = companionCloudApi();
    if (!api) { setTargetsFailed(true); return; }
    void api.listCompanionTransferTargets().then(setTargets, () => setTargetsFailed(true));
  };

  const transfer = async () => {
    if (!pending || inFlight.current) return;
    const api = companionCloudApi();
    if (!api) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const target = pending;
    try {
      const result = await api.transferCompanion(bot.id, target.deviceId);
      if (result.ok) {
        setPending(null);
        toast.info(t('bots.cloud.transferred', { name: bot.name, device: target.name }));
        navigate(`/bots/remote/${encodeURIComponent(target.deviceId)}/${encodeURIComponent(bot.id)}`);
        return;
      }
      setPending(null);
      setError(t(TRANSFER_ERROR_KEYS[result.code], { name: bot.name, device: target.name }));
      if (result.code === 'HOME_CONFLICT') refreshCompanionCloud();
    } catch {
      setPending(null);
      setError(t('bots.cloud.transferFailed', { name: bot.name, device: target.name }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <DropdownMenu onOpenChange={(open) => { if (open) loadTargets(); }}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="bot-home-computer-row"
              className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-14 text-[var(--text-primary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
            >
              <Monitor size={18} className="shrink-0 text-[var(--text-secondary)]" />
              <span className="min-w-0 flex-1">{t('bots.cloud.homeLabel')}</span>
              <span className="shrink-0 text-13 text-[var(--text-secondary)]">{t('bots.cloud.thisComputer')}</span>
              <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56 max-w-80">
            {!movable ? (
              <DropdownMenuItem disabled className="whitespace-normal">{t('bots.cloud.resumeToMove', { name: bot.name })}</DropdownMenuItem>
            ) : targetsFailed ? (
              <DropdownMenuItem disabled>{t('bots.cloud.devicesFailed')}</DropdownMenuItem>
            ) : targets === null ? (
              <DropdownMenuItem disabled>{t('bots.cloud.loadingDevices')}</DropdownMenuItem>
            ) : targets.length === 0 ? (
              <DropdownMenuItem disabled className="whitespace-normal">{t('bots.cloud.noTargets')}</DropdownMenuItem>
            ) : (
              targets.map((target) => (
                <DropdownMenuItem key={target.deviceId} onSelect={() => { setError(null); setPending(target); }}>
                  <span className="min-w-0 truncate">{t('bots.cloud.moveTo', { device: target.name })}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error ? (
        <p role="alert" className="mt-2 px-1 text-12 text-[var(--text-danger)]">{error}</p>
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        presentation="standard"
        cancelFirst
        onOpenChange={(open) => { if (!open && !inFlight.current) setPending(null); }}
        title={t('bots.cloud.transferTitle', { name: bot.name, device: pending?.name ?? '' })}
        description={t('bots.cloud.transferDescription', { name: bot.name, device: pending?.name ?? '' })}
        confirmText={t('bots.cloud.transferAction', { device: pending?.name ?? '' })}
        cancelText={t('bots.cancel')}
        loading={busy}
        onConfirm={() => void transfer()}
      />
    </div>
  );
}
