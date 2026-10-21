import { mountPage, forbid } from '../../ui-page/harness';
import { CompanionVoiceSettings } from '../../../src/renderer/features/bots/voice/CompanionVoiceSettings';
import type {
  SpeechProtocol,
  VoiceConversationPreference,
  VoiceConversationSelection,
} from '../../../src/shared/voiceConversation';

// The UI harness's custom origin lacks secure-context randomUUID. IDs below are
// fixture-only correlation tokens; the real app keeps its native crypto API.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

mountPage({
  host: (ctx) => {
    const protocol = (ctx.data.protocol ?? 'elevenlabs') as SpeechProtocol;
    const modelId = String(ctx.data.modelId ?? 'eleven_flash_v2_5');
    const initialVoice = ctx.data.manual ? 'custom-voice' : 'river';
    const pending = new Map<string, () => void>();
    const previews: Array<{ voice: string; speed?: number; previewId: string }> = [];
    const stops: string[] = [];
    ctx.data.previewRequests = previews;
    ctx.data.previewStops = stops;
    ctx.data.savedVoice = initialVoice;
    let preference: VoiceConversationPreference = {
      selection: {
        providerId: 'fixture',
        agent: 'codex',
        modelId,
        voice: initialVoice,
        ...(typeof ctx.data.speed === 'number' ? { speed: ctx.data.speed } : {}),
      },
      customized: ctx.data.speed !== undefined || !!ctx.data.manual,
      sentencePlayback: true,
    };
    return {
      onAuthStateChange: () => () => {},
      voiceInput: { onPowerStateChange: () => () => {} },
      maker: { refreshBuiltinProviderModels: async () => {} },
      voiceConversation: {
        models: async () =>
          ctx.data.empty
            ? []
            : [
                {
                  id: modelId,
                  name: modelId,
                  providerId: 'fixture',
                  providerName:
                    protocol === 'elevenlabs'
                      ? 'ElevenLabs'
                      : protocol === 'minimax'
                        ? 'MiniMax'
                        : 'OpenAI',
                  agent: 'codex',
                  protocol,
                  protocolLocked: true,
                  defaultVoice: 'river',
                },
              ],
        voices: async () => ({
          source: 'provider',
          voices: [
            { id: 'river', name: 'River — Relaxed, Neutral, Informative' },
            ...(ctx.data.menu
              ? [
                  { id: 'bella', name: 'Bella — Professional, Bright, Warm' },
                  { id: 'sarah', name: 'Sarah — Mature, Reassuring, Confident' },
                  { id: 'roger', name: 'Roger — Laid-Back, Casual, Resonant' },
                  { id: 'laura', name: 'Laura — Enthusiast, Quirky Attitude' },
                  { id: 'charlie', name: 'Charlie — Deep, Confident, Energetic' },
                  { id: 'george', name: 'George — Warm, Captivating Storyteller' },
                  { id: 'callum', name: 'Callum — Husky, Trickster' },
                ]
              : []),
          ],
        }),
        preference: async () => preference,
        setPreference: async (
          _botId: string,
          selection: VoiceConversationSelection | null | undefined,
          sentencePlayback?: boolean | null,
        ) => {
          preference = {
            selection: selection === undefined ? preference.selection : selection,
            customized: selection !== null || sentencePlayback != null,
            sentencePlayback:
              sentencePlayback === undefined
                ? preference.sentencePlayback
                : (sentencePlayback ?? true),
          };
          ctx.data.savedVoice = preference.selection?.voice;
          return preference;
        },
        // Controlled synthesis boundary: never contacts a provider or emits audio.
        stopPreview: async (id: string) => {
          stops.push(id);
          pending.get(id)?.();
          pending.delete(id);
        },
        preview: async (input: { voice: string; speed?: number; previewId: string }) => {
          previews.push(input);
          if (ctx.data.previewFailure) throw new Error('fixture preview unavailable');
          await new Promise<void>((resolve) => pending.set(input.previewId, resolve));
          return { sampleRate: 24000 };
        },
        readPreview: async () => ({ pcm: new ArrayBuffer(0), done: true }),
        start: forbid('microphone capture'),
      },
    };
  },
  render: () => (
    <main className="mx-auto min-h-screen max-w-[460px] p-5">
      <CompanionVoiceSettings
        botId="fixture-bot"
        sessionId="fixture-session"
        onOpenProviders={() => {}}
      />
    </main>
  ),
});
