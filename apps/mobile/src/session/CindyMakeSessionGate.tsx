import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Redirect } from 'expo-router';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import { remoteSessionStore } from './remoteSessionStore';

/** Use the raw mirror to recognize hidden tasks opened by an old link. */
export function CindyMakeSessionGate({ sessionId, deviceId: routeDeviceId, children }: {
  sessionId: string;
  deviceId?: string;
  children: ReactNode;
}) {
  const { accountGeneration } = useAuth();
  const { openLink, connectionEpoch } = useDeviceLink();
  const sessions = useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getSessions);
  const deviceId = routeDeviceId ?? remoteSessionStore.getSessionDeviceId(sessionId) ?? '';
  const maker = useMobileMakerTransport(deviceId);
  const knownSession = sessions.find(session => session.id === sessionId
    && (!deviceId || session.deviceLinkDeviceId === deviceId));
  const knownSource = knownSession?.source;
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    deviceId: string;
    accountGeneration: number;
    source: string | null;
  } | null>(null);

  useEffect(() => {
    if (CINDY_MAKE_ENABLED || !sessionId || !deviceId || knownSource !== undefined) return;
    let cancelled = false;
    void openLink(deviceId)
      .then(() => cancelled ? null : maker.getSession(sessionId))
      .then(session => {
        if (!cancelled && session?.id === sessionId) {
          setLoaded({ sessionId, deviceId, accountGeneration, source: session.source ?? null });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, deviceId, accountGeneration, knownSource, maker, openLink, connectionEpoch]);

  const source = knownSource !== undefined ? knownSource : (
    loaded?.sessionId === sessionId && loaded.deviceId === deviceId
      && loaded.accountGeneration === accountGeneration ? loaded.source : undefined
  );
  if (!CINDY_MAKE_ENABLED && isCindyMakeSource(source)) return <Redirect href="/" />;
  if (!CINDY_MAKE_ENABLED && source === undefined) return null;
  return children;
}
