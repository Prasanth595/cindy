/**
 * InputHandoffCard (代输入)
 * ---------------------------------------------------------------------------
 * The Host reads one screen of the target UI and shows it here as standard
 * fields. Values the owner types stay in this component's local state and
 * leave only through makerTransport.submitInputHandoff — never the store, the
 * transcript or the model. Each new screen remounts the form, so a stale
 * draft can never be applied to a different screen.
 *
 * Password fields are plain `type="password"` + `autocomplete` hints so the
 * platform password manager (1Password, Passwords) can fill them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, KeyRound, MonitorPlay } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  InputHandoffAction,
  InputHandoffSnapshot,
  InputHandoffValues,
} from '@cindy/device-link';
import {
  inputHandoffHeldElsewhere,
  inputHandoffPresentation,
  inputHandoffStepKey,
} from '@cindy/device-link';
import { useOptionalAuthDeviceId } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { toast } from '@/lib/toast';
import { makerApiForSticky, submitInputHandoff } from '@/lib/makerTransport';
import { cn } from '@/lib/utils';
import {
  InputHandoffPictureStep,
  rememberInputHandoffPictureOpened,
} from './InputHandoffPictureStep';
import { InputHandoffDeviceCode } from './InputHandoffDeviceCode';
import { InputHandoffStepForm } from './InputHandoffStepForm';
import { changedValues } from './inputHandoffModel';

export interface InputHandoffCardProps {
  sessionId: string;
  snapshot: InputHandoffSnapshot;
  /** The task runs on another computer (values go through the signed relay). */
  remote?: boolean;
}

type Decision = 'done' | 'cancel' | 'stay' | 'refresh' | 'claim' | 'decline' | 'picture';

export function InputHandoffCard({ sessionId, snapshot, remote }: InputHandoffCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new screen clears any message about the previous one.
  const stepKey = inputHandoffStepKey(snapshot);
  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [stepKey]);

  const decide = useCallback(
    async (action: Decision) => {
      if (action === 'picture') rememberInputHandoffPictureOpened(snapshot.requestId);
      setBusy(true);
      setError(null);
      try {
        const result = await makerApiForSticky(sessionId).resolveInteraction(snapshot.requestId, {
          kind: 'input_handoff',
          action,
          expectedRevision: snapshot.revision,
        });
        if (!result.accepted) setError(t('inputHandoff.error.stale'));
      } catch {
        setError(t('inputHandoff.error.decision'));
      } finally {
        setBusy(false);
      }
    },
    [sessionId, snapshot.requestId, snapshot.revision, t],
  );

  const submit = useCallback(
    async (draft: InputHandoffValues, action: InputHandoffAction) => {
      setBusy(true);
      setError(null);
      try {
        const result = await submitInputHandoff(sessionId, {
          submission: {
            expectedRevision: snapshot.revision,
            values: changedValues(snapshot, draft),
            action,
          },
          presentation: inputHandoffPresentation(snapshot),
        });
        if (!result.accepted) setError(t('inputHandoff.error.stale'));
        return result.accepted;
      } catch {
        setError(t('inputHandoff.error.submit'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionId, snapshot, t],
  );

  // Starting to type on an unheld screen takes the handoff quietly, so other
  // devices show "being handled on …". It never blocks the field being typed in.
  const claimQuietly = useCallback(() => {
    if (snapshot.holder) return;
    void makerApiForSticky(sessionId)
      .resolveInteraction(snapshot.requestId, {
        kind: 'input_handoff',
        action: 'claim',
        expectedRevision: snapshot.revision,
      })
      .catch(() => undefined);
  }, [sessionId, snapshot.holder, snapshot.requestId, snapshot.revision]);

  const inputBlocked = remote === true && snapshot.remoteInput !== true;
  const selfDeviceId = useOptionalAuthDeviceId();
  const heldElsewhere = inputHandoffHeldElsewhere(
    snapshot,
    remote === true ? { deviceId: selfDeviceId } : { local: true },
  );

  return (
    <section
      aria-label={t('inputHandoff.title')}
      className={cn(
        'w-full max-w-[914px] rounded-[12px] border p-4',
        'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]',
      )}
    >
      <InputHandoffHeader snapshot={snapshot} />
      <InputHandoffSourceRow snapshot={snapshot} />
      <div className="mt-4">
        <InputHandoffBody
          sessionId={sessionId}
          remote={remote === true}
          onError={setError}
          snapshot={snapshot}
          busy={busy}
          inputBlocked={inputBlocked}
          heldElsewhere={heldElsewhere}
          onDecide={decide}
          onSubmit={submit}
          onStart={claimQuietly}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-12 text-[var(--error-fg)]">
          {error}
        </p>
      )}
      <InputHandoffLiveView sessionId={sessionId} snapshot={snapshot} />
    </section>
  );
}

function InputHandoffHeader({ snapshot }: { snapshot: InputHandoffSnapshot }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <KeyRound size={16} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
        <div className="min-w-0">
          <p className="text-15 font-semibold leading-tight">{t('inputHandoff.title')}</p>
          <p className="mt-1 text-13 leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {snapshot.purpose}
          </p>
          {snapshot.note && (
            <p className="mt-1 text-13 leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">
              {t('inputHandoff.agentNote', { note: snapshot.note })}
            </p>
          )}
          {snapshot.requester && (
            <p className="mt-0.5 text-12 text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
              {t('inputHandoff.requester', { name: snapshot.requester })}
            </p>
          )}
        </div>
      </div>
      {!snapshot.terminal && (
        <span className="shrink-0 rounded-[6px] border border-[var(--border-default)] px-2 py-1 text-12 font-medium text-[var(--text-secondary)]">
          {t('inputHandoff.step', { count: snapshot.stepNumber })}
        </span>
      )}
    </div>
  );
}

function InputHandoffSourceRow({ snapshot }: { snapshot: InputHandoffSnapshot }) {
  const { t } = useTranslation();
  const { source } = snapshot;
  const where = [source.app, source.window].filter(Boolean).join(' · ');
  return (
    <div className="mt-3 space-y-1.5 text-12">
      <p className="text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
        {where}
        {source.origin && (
          <span className="ml-1.5 font-mono text-[var(--text-secondary)]">{source.origin}</span>
        )}
      </p>
      {snapshot.command && (
        <p className="text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
          {t('inputHandoff.command')}{' '}
          <span className="font-mono text-[var(--text-secondary)]">{snapshot.command}</span>
        </p>
      )}
      {source.warning && <Warning text={t(`inputHandoff.originWarning.${source.warning}`)} />}
      {snapshot.agentControlled && <Warning text={t('inputHandoff.agentControlled')} />}
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 rounded-[8px] bg-[var(--warning-bg-soft)] px-2.5 py-1.5 text-[var(--text-primary)]">
      <AlertTriangle size={14} className="mt-px shrink-0 text-[var(--warning-fg)]" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

interface BodyProps {
  sessionId: string;
  remote: boolean;
  onError: (message: string | null) => void;
  snapshot: InputHandoffSnapshot;
  busy: boolean;
  inputBlocked: boolean;
  heldElsewhere: boolean;
  onDecide: (action: Decision) => void;
  onSubmit: (draft: InputHandoffValues, action: InputHandoffAction) => Promise<boolean>;
  onStart: () => void;
}

function InputHandoffBody({
  sessionId,
  remote,
  onError,
  snapshot,
  busy,
  inputBlocked,
  heldElsewhere,
  onDecide,
  onSubmit,
  onStart,
}: BodyProps) {
  const { t } = useTranslation();
  if (snapshot.terminal) {
    const key =
      snapshot.phase === 'failed' && snapshot.failure
        ? `inputHandoff.failure.${snapshot.failure}`
        : `inputHandoff.terminal.${snapshot.phase}`;
    return <p className="text-13 text-[var(--text-secondary)]">{t(key)}</p>;
  }
  const failure = snapshot.failure ? (
    <p role="alert" className="mb-3 text-12 text-[var(--error-fg)]">
      {t(`inputHandoff.failure.${snapshot.failure}`)}
    </p>
  ) : null;
  if (snapshot.phase === 'ready' && heldElsewhere) {
    return (
      <>
        <p className="text-13 text-[var(--text-secondary)]" role="status">
          {t('inputHandoff.holder.elsewhere', { device: holderLabel(snapshot, t) })}
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            tone="quiet"
            disabled={busy}
            onClick={() => onDecide('cancel')}
          >
            {t('inputHandoff.action.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide('claim')}>
            {t('inputHandoff.action.claim')}
          </Button>
        </div>
      </>
    );
  }
  if (snapshot.phase === 'ready' && snapshot.picture) {
    // A screenshot belongs to exactly one revision: never claim quietly here
    // (that bumps the revision), and remount so the picture is fetched afresh.
    return (
      <>
        {failure}
        <InputHandoffPictureStep
          key={`${snapshot.requestId}:${snapshot.revision}`}
          sessionId={sessionId}
          snapshot={snapshot}
          remote={remote}
          busy={busy}
          inputBlocked={inputBlocked}
          onDecide={onDecide}
          onError={onError}
        />
      </>
    );
  }
  if (snapshot.phase === 'ready') {
    return (
      <>
        {failure}
        <InputHandoffDeviceCode snapshot={snapshot} />
        <InputHandoffStepForm
          key={inputHandoffStepKey(snapshot)}
          snapshot={snapshot}
          busy={busy}
          inputBlocked={inputBlocked}
          onDecide={onDecide}
          onSubmit={onSubmit}
          onStart={onStart}
        />
      </>
    );
  }
  if (snapshot.phase === 'finishing') {
    return (
      <>
        {failure}
        <FinishingCountdown until={snapshot.finishingUntil} />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDecide('stay')}>
            {t('inputHandoff.action.stay')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide('done')}>
            {t('inputHandoff.action.done')}
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      {failure}
      <p className="flex items-center gap-2 text-13 text-[var(--text-secondary)]" role="status">
        <Spinner size={14} />
        {t(
          snapshot.phase === 'working'
            ? 'inputHandoff.phase.working'
            : 'inputHandoff.phase.reading',
        )}
      </p>
      <div className="mt-3 flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          tone="quiet"
          disabled={busy}
          onClick={() => onDecide('cancel')}
        >
          {t('inputHandoff.action.cancel')}
        </Button>
      </div>
    </>
  );
}

/**
 * The host offers a live view of just the target window (remote desktop is on
 * there). Navigation only: the host picks the window from the request id and
 * keeps input inside it; this device never names a window.
 */
function InputHandoffLiveView({
  sessionId,
  snapshot,
}: {
  sessionId: string;
  snapshot: InputHandoffSnapshot;
}) {
  const deviceId = getStickySessionDeviceId(sessionId);
  if (!deviceId || !snapshot.liveView || snapshot.terminal) return null;
  return <LiveViewButton deviceId={deviceId} requestId={snapshot.requestId} />;
}

function LiveViewButton({ deviceId, requestId }: { deviceId: string; requestId: string }) {
  const { t } = useTranslation();
  const devices = useDeviceLinkDeviceList();
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const name = devices?.find((device) => device.deviceId === deviceId)?.name || deviceId;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--border-default)] pt-3">
      <p className="min-w-0 text-12 leading-relaxed text-[var(--text-tertiary)]">
        {t('inputHandoff.liveViewHint')}
      </p>
      <Button
        variant="secondary"
        size="sm"
        tone="quiet"
        className="shrink-0"
        loading={opening}
        disabled={opening}
        onClick={() => {
          setOpening(true);
          void window.electronAPI
            .openRemoteDesktop({ deviceId, name, handoff: requestId })
            .catch(() => toast.error(t('remoteDesktop.connectionError')))
            .finally(() => {
              if (mounted.current) setOpening(false);
            });
        }}
      >
        <MonitorPlay size={14} aria-hidden />
        {t('inputHandoff.action.liveView')}
      </Button>
    </div>
  );
}

function holderLabel(snapshot: InputHandoffSnapshot, t: (key: string) => string): string {
  const holder = snapshot.holder;
  if (holder?.local) return t('inputHandoff.holder.host');
  if (holder?.name) return holder.name;
  return t(
    holder?.platform === 'mobile' ? 'inputHandoff.holder.phone' : 'inputHandoff.holder.otherDevice',
  );
}

function FinishingCountdown({ until }: { until?: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [until]);
  const seconds = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return (
    <p className="text-13 text-[var(--text-secondary)]" role="status">
      {until
        ? t('inputHandoff.phase.finishing', { count: seconds })
        : t('inputHandoff.phase.finishingNow')}
    </p>
  );
}
