import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type MailMessage } from '@cindy/maker-shared/mail-message';
import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { registerTabKind } from '../../registry';
import type { TabKindBodyProps, TabKindPlugin } from '../../types';
import { readMailPreview } from '../../lib/mailPreview';
import { MailCardBody } from './MailCardBody';
import { MailConversationView } from './MailConversationView';

type State = { url: string; callId?: string };
export function MailPreviewBody({ state, ctx, active: tabActive = true, shellVisible = true }: TabKindBodyProps<State>) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ binding: string; message?: MailMessage; error?: boolean }>();
  const owner = getDataOwnerGeneration();
  const binding = JSON.stringify([owner, ctx.sessionId, ctx.deviceLinkDeviceId, state.url, attempt]);
  const visible = tabActive && shellVisible;
  useEffect(() => {
    let active = true;
    if (!visible || ctx.deviceLinkDeviceId === undefined) return;
    void readMailPreview(ctx.sessionId, state.url, true, ctx.deviceLinkDeviceId, true).then(r => {
      if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, message: r.message ?? undefined, error: !r.message });
    }).catch(() => { if (active && isDataOwnerGenerationCurrent(owner)) setResult({ binding, error: true }); });
    return () => { active = false; };
  }, [binding, visible]);
  const current = result?.binding === binding ? result : undefined;
  const mail = current?.message;
  const read = useCallback(async (url: string, opened = false) => {
    const response = await readMailPreview(ctx.sessionId, url || state.url, true, ctx.deviceLinkDeviceId, opened && visible);
    return isDataOwnerGenerationCurrent(owner) ? response : { message: null };
  }, [owner, ctx.sessionId, ctx.deviceLinkDeviceId, state.url, visible]);
  const openMailbox = <Button tone="quiet" compact size="sm" aria-label={t('mailReader.openMailbox')} title={t('mailReader.openMailbox')}
    onClick={() => { void window.electronAPI.openExternal(state.url); }}><ExternalLink className="h-4 w-4" /></Button>;
  return <div className="h-full min-h-0">
    {mail ? <ChatSessionFileProvider value={{ sessionId: ctx.sessionId, workingDir: ctx.workdir, origin: ctx.deviceLinkDeviceId ? { kind: 'device', deviceId: ctx.deviceLinkDeviceId } : { kind: 'local' } }}>
      <MailConversationView key={binding} mail={mail} openMailbox={openMailbox} read={read} retry={() => setAttempt(n => n + 1)} />
    </ChatSessionFileProvider> : <div className="p-4 text-13 text-muted-foreground" role="status">
      <div className="mb-3 flex justify-end">{openMailbox}</div>
      {t(current?.error ? 'mailReader.failed' : 'mailReader.loading')}
      {current?.error && <div className="mt-3"><Button variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>{t('mailReader.retry')}</Button></div>}
    </div>}
  </div>;
}
const plugin: TabKindPlugin<State> = {
  kind: 'mail-preview', menu: { kind: 'mail-preview', labelKey: 'mailReader.title', icon: Mail, order: 20, enabled: true, hiddenFromMenu: true, singleton: true },
  TabPillTitle: ({ t }) => <>{t('mailReader.title')}</>, TabPillIcon: () => <Mail size={13} />,
  TabBody: (props: TabKindBodyProps<State>) => props.state.callId ? <MailCardBody {...props} state={{ callId: props.state.callId }} /> : <MailPreviewBody {...props} />,
  defaultState: () => ({ url: '' }),
  hydrateState: raw => ({ url: typeof (raw as State)?.url === 'string' ? (raw as State).url : '',
    ...(typeof (raw as State)?.callId === 'string' && (raw as State).callId!.length <= 128 ? { callId: (raw as State).callId } : {}) }),
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
