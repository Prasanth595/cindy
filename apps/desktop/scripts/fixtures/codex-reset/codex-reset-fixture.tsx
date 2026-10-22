import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { CodexResetCredits } from '../../../src/renderer/components/status/CodexResetCredits';
import { DEFAULT_CODEX_RESET_AUTO_USE } from '../../../src/main/usage/codexResetAutoUse';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

const now = Date.now();
let snapshot: MobileCodexRateLimitsResult = {
  providerId: 'openai', account: { email: 'ch***@example.com', accountId: '…123456', planType: 'plus' },
  rateLimits: { secondary: { usedPercent: 77, windowMinutes: 10080, resetsAt: now / 1000 + 4 * 86400 } },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: { availableCount: 2, credits: [1, 2].map(n => ({
    status: 'available', resetType: 'codexRateLimits', grantedAt: 1, expiresAt: now / 1000 + n * 86400,
    title: null, description: null, resetOffer: { idempotencyKey: `fixture-${n}`, expiresAt: now / 1000 + n * 86400, validUntil: now + 600_000 },
  })) },
  resetOffer: { idempotencyKey: 'fixture-1', expiresAt: now / 1000 + 86400, validUntil: now + 600_000 },
  autoUse: { accountKey: 'fixture-account', settings: { ...DEFAULT_CODEX_RESET_AUTO_USE }, customized: false, lastUsedAt: null },
};
function Fixture({ embedded }: { embedded: boolean }) {
  const [value, setValue] = useState(snapshot);
  return <main className="mx-auto w-full max-w-[580px] p-4"><div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
    <CodexResetCredits variant={embedded ? 'embedded' : 'dialog'} snapshot={value} busy={false} canReset onReset={() => {}}
      onChanged={() => setValue({ ...snapshot })} />
  </div></main>;
}
void mountPage({
  host: { maker: { usage: { setCodexResetAutoUse: async (patch: object | null) => {
    snapshot = { ...snapshot, autoUse: { ...snapshot.autoUse!, customized: patch !== null,
      settings: patch === null ? { ...DEFAULT_CODEX_RESET_AUTO_USE } : { ...snapshot.autoUse!.settings, ...patch } } };
    return snapshot;
  } } } },
  render: ctx => <Fixture embedded={ctx.case === 'embedded'} />,
});
