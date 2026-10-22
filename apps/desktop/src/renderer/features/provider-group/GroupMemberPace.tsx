/**
 * 组内电脑行里的配额进度条(docs/product-rules/provider-groups.md §10，2026-10-21 用户要求：一眼看出各账号
 * 是不是在平均地用)：已用多少、按时间这时候该用到哪(竖线)、多久后重置。数字是组所在电脑选电脑时排序用的
 * 同一个窗口，不另读那台电脑。
 *
 * 这一行整个是展开详情的按钮：按钮里只能放行内元素，所以条用 span 画、对读屏隐藏，数字由旁边的文字说出来。
 * 颜色与 QuotaBar 同一套额度条 token 和预警分级。
 */
import { useTranslation } from 'react-i18next';

import { quotaSeverity } from '@/components/status/QuotaBar';
import { formatQuotaResetCountdown } from '@/components/status/usageCardModel';
import { cn } from '@/lib/utils';

import type { ProviderGroupMemberQuota } from '../../../shared/providerGroup';

const FILL = {
  normal: 'bg-[var(--quota-bar-fill)]',
  warn: 'bg-[var(--quota-bar-warn)]',
  crit: 'bg-[var(--quota-bar-crit)]',
} as const;

/** 跟在状态行后面(前面由调用方放分隔点)；几段各自换行，窄的时候不撑破这一行。 */
export function GroupMemberPace({ quota, nowMs = Date.now() }: { quota: ProviderGroupMemberQuota; nowMs?: number }) {
  const { t } = useTranslation();
  const used = Math.round(quota.usedPercent);
  // 还没开始计时的窗口没有「该用到哪」，也没有重置时间。
  const expected = quota.resetAtMs === null
    ? null
    : Math.round(Math.min(100, Math.max(0, (1 - (quota.resetAtMs - nowMs) / quota.windowMs) * 100)));
  const reset = quota.resetAtMs === null ? null : formatQuotaResetCountdown(quota.resetAtMs / 1000, nowMs, t);
  const text = expected === null
    ? t('providerGroup.member.pace.used', { used })
    : t('providerGroup.member.pace.usedExpected', { used, expected });
  return (
    <>
      <span data-testid="provider-group-member-pace" className="inline-flex items-center gap-1.5 [font-variant-numeric:tabular-nums]">
        <span aria-hidden="true" className="relative inline-flex items-center">
          <span className="inline-flex h-[5px] w-12 overflow-hidden rounded-full bg-[var(--quota-bar-track)]">
            <span
              data-testid="provider-group-member-pace-fill"
              className={cn('h-full rounded-full', used > 0 && 'min-w-[4px]', FILL[quotaSeverity(quota.usedPercent)])}
              style={{ width: `${quota.usedPercent}%` }}
            />
          </span>
          {expected !== null && (
            // 竖线比条高出上下各 2px，落在已用部分里也看得见。
            <span
              data-testid="provider-group-member-pace-marker"
              className="pointer-events-none absolute top-1/2 h-[9px] w-[2px] -translate-x-1/2 -translate-y-1/2 bg-[var(--text-primary)]"
              style={{ left: `${expected}%` }}
            />
          )}
        </span>
        <span>{text}</span>
      </span>
      {reset && (
        <>
          <span aria-hidden="true">·</span>
          <span className="[font-variant-numeric:tabular-nums]">{reset}</span>
        </>
      )}
    </>
  );
}
