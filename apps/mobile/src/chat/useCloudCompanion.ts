import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ChatActor, ChatSetHomeResult } from './chatServerClient';
import { useChatClient } from './useChatServer';

const NO_ACTORS: ChatActor[] = [];

/**
 * Whether the account's Chat Server supports main computers (`/me` capabilities.companionHome),
 * and the account's companion actors with their main computers. Read on focus and foreground;
 * an older server, a missing chat endpoint or a failed read leaves the feature off (or the last answer).
 */
export function useCloudCompanionHome(enabled: boolean) {
  const api = useChatClient();
  const [state, setState] = useState({ owner: api.owner, supported: false, actors: NO_ACTORS });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled || !api.enabled) return;
    const run = ++generation.current;
    try {
      const { companionHome } = await api.client.capabilities();
      const actors = companionHome ? await api.client.actors() : NO_ACTORS;
      if (run !== generation.current || !api.current()) return;
      setState({ owner: api.owner, supported: companionHome, actors });
    } catch {
      // Keep the previous answer: rows simply behave as before when the server cannot be read.
    }
  }, [api, enabled]);
  useFocusEffect(useCallback(() => {
    if (!enabled || !api.enabled) return;
    void refresh();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') void refresh(); });
    return () => { generation.current += 1; foreground.remove(); };
  }, [api.enabled, enabled, refresh]));
  const own = state.owner === api.owner;
  const setHome = useCallback((actorId: string, homeDeviceId: string, expected: string | null): Promise<ChatSetHomeResult> =>
    api.client.setHome(actorId, homeDeviceId, expected), [api]);
  return { supported: own && state.supported, actors: own ? state.actors : NO_ACTORS, refresh, setHome };
}
