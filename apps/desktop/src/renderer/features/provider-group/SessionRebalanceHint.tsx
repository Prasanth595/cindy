/**
 * 输入框上方的换号提示(provider-groups.md §6.2「任务进行中换号」，2026-10-22 用户裁决)：不打断发送。
 * 不操作就继续用当前账号；点「切换」下一条消息换过去(可撤销)；点 × 这一轮不再提醒。
 */
import { ArrowLeftRight, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';

import {
  armSessionRebalance,
  describeSessionRebalanceQuota,
  dismissSessionRebalance,
  type SessionRebalanceHintState,
} from './sessionRebalancePrompt';

export function SessionRebalanceHint({ sessionId, hostDeviceId, hint }: {
  sessionId: string;
  hostDeviceId?: string;
  hint: SessionRebalanceHintState;
}) {
  const { t } = useTranslation();
  const { suggestion, armed } = hint;
  const dismissLabel = t('providerGroup.rebalance.dismiss');
  const text = armed
    ? t('providerGroup.rebalance.armed', { label: suggestion.label })
    : t('providerGroup.rebalance.hint', { label: suggestion.label, quota: describeSessionRebalanceQuota(suggestion, t) });
  return (
    <div data-testid="session-rebalance-hint" data-armed={armed || undefined} className="flex min-w-0 select-none items-center gap-2 px-3 py-2">
      <ArrowLeftRight size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
      <span role="status" className="min-w-0 flex-1 text-13 text-[var(--text-secondary)]">{text}</span>
      <button
        type="button"
        onClick={() => armSessionRebalance(sessionId, hostDeviceId, !armed)}
        className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-2 text-13 font-medium text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        {armed ? t('providerGroup.rebalance.undo') : t('providerGroup.rebalance.switch')}
        {!armed && <ChevronRight size={12} aria-hidden />}
      </button>
      <Tip text={dismissLabel}>
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={() => void dismissSessionRebalance(sessionId, hostDeviceId)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <X size={12} />
        </button>
      </Tip>
    </div>
  );
}
