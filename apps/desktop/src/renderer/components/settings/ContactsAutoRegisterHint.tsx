/**
 * 智能通讯录接线状态引导(Chris 2026-07-30: 通讯录关着时自动记人静默失效,
 * 没有任何引导 — 在群聊节明示状态, 关着给一键开启)。
 *
 * sides: Telegram(个人 bot / 官方 bot)与飞书共用同一段文案结构, 由 root 前缀
 * 决定具体 i18n 命名空间(contactsOn / contactsOff / contactsEnable)。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { contactsService } from '@/lib/contactsService';

export function ContactsAutoRegisterHint({ root }: { root: string }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void contactsService
      .settingsGet()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch(() => {
        /* 通讯录服务不可用时不渲染引导 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (enabled === null) return null;
  if (enabled) {
    return (
      <div className="text-11 leading-[1.5] text-[var(--text-secondary)]">
        {t(`${root}.contactsOn`)}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-11 leading-[1.5] text-[var(--settings-section-desc)]">
        {t(`${root}.contactsOff`)}
      </span>
      <Button
        variant="primary"
        size="sm"
        compact
        loading={busy}
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void contactsService
            .settingsSet(true)
            .then(() => setEnabled(true))
            .catch(() => {
              /* 失败保持关闭态, 用户可去通讯录设置页重试 */
            })
            .finally(() => setBusy(false));
        }}
      >
        {t(`${root}.contactsEnable`)}
      </Button>
    </div>
  );
}

