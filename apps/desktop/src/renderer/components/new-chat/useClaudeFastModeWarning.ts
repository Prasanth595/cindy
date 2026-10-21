import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';

/** Local UI preference, shared by Claude Fast switches on this installation. */
export const CLAUDE_FAST_MODE_WARNING_KEY = 'claude-fast-mode-billing';

export function useClaudeFastModeWarning(scope: string, onPendingChange?: (pending: boolean) => void) {
  const dialog = useOptionalConfirmDialog();
  const { t } = useTranslation();
  const pending = useRef<AbortController | null>(null);

  // A confirmation must not apply to a model/device that has since been left.
  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, [scope]);

  return async (): Promise<boolean> => {
    if (!dialog || pending.current) return false;
    const controller = new AbortController();
    pending.current = controller;
    onPendingChange?.(true);
    try {
      const accepted = await dialog.confirm({
        title: t('newChat.modelSelector.claudeFastWarning.title'),
        description: t('newChat.modelSelector.claudeFastWarning.description'),
        confirmText: t('newChat.modelSelector.claudeFastWarning.confirm'),
        cancelText: t('commonUi.confirmDialog.cancel'),
        dontShowAgainKey: CLAUDE_FAST_MODE_WARNING_KEY,
        dontShowAgainLabel: t('newChat.modelSelector.claudeFastWarning.dontShowAgain'),
      }, controller.signal);
      return accepted && !controller.signal.aborted;
    } finally {
      if (pending.current === controller) pending.current = null;
      onPendingChange?.(false);
    }
  };
}
