import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { ModelConfigFlyout } from '../../../src/renderer/components/new-chat/ModelConfigFlyout';
import { SpeedIcon } from '../../../src/renderer/components/new-chat/SpeedIcon';
import { useClaudeFastModeWarning } from '../../../src/renderer/components/new-chat/useClaudeFastModeWarning';
import { BUNDLED_CATALOG, resolveModelMetadata, type Effort, type UnifiedModelEntry } from '@cindy/model-providers';

function Fixture({ variant }: { variant: string }) {
  const isClaude = variant === 'claude';
  const agent = isClaude ? 'claude-code' : 'codex';
  const providerId = isClaude ? 'anthropic' : 'openai';
  const modelId = isClaude ? 'claude-opus-5' : variant === 'sol' ? 'gpt-6.1-sol' : 'gpt-6-astra';
  const metadata = resolveModelMetadata(BUNDLED_CATALOG.modelRegistry, providerId, modelId, undefined, undefined, agent);
  const capability = {
    agent, wireModelId: modelId, efforts: metadata.efforts ?? [],
    defaultEffort: metadata.defaultEffort ?? null, defaultEffortSource: 'catalog' as const,
    supportsFastMode: true, supportsUltrafastMode: !isClaude,
    contextWindow: metadata.contextWindow ?? 272000, contextWindowVerified: true,
  };
  const entry: UnifiedModelEntry = {
    providerId, modelId, displayName: metadata.name ?? modelId,
    candidates: [agent], recommended: agent, nativeAgent: agent, capabilities: { [agent]: capability },
  };
  const [fast, setFast] = useState<boolean | 'ultrafast'>(isClaude ? false : 'ultrafast');
  const [effort, setEffort] = useState<Effort>('high');
  const [pending, setPending] = useState(false);
  const confirmClaudeFast = useClaudeFastModeWarning(modelId, setPending);
  const changeFast = async (enabled: boolean | 'ultrafast') => {
    if (isClaude && enabled && !(await confirmClaudeFast())) return;
    setFast(enabled);
  };
  return (
    <main className="mx-auto w-full max-w-[360px] p-4">
      <div className="mb-5 flex items-center gap-2 text-[var(--text-primary)]">
        <SpeedIcon mode={fast} size={20}/><span>{entry.displayName}</span>
      </div>
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <ModelConfigFlyout entry={entry}
          config={{engine:isClaude ? 'cc' : 'codex', agent, efforts:capability.efforts, effort, fast,
            fastCapable:true, customized:true, capability, wireModelId:modelId}}
          state="customized" sourceLabel={isClaude ? 'Anthropic' : 'OpenAI'} price={null} disabled={pending}
          effortLabelOf={(_, value) => value === 'ultra' ? 'Ultra' : value}
          onEngineChange={()=>{}} onEffortChange={setEffort} onFastChange={changeFast}
          onResetToRecommended={()=>{ setFast(false); setEffort(capability.defaultEffort ?? 'medium'); }}
          onAddFavorite={()=>{}} onRemoveFavorite={()=>{}}/>
      </div>
    </main>
  );
}
void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({limit:272000,isCustomized:false}),
    onProvidersChanged: subscription('providersChanged'),
  } },
  render: ctx => <Fixture variant={ctx.case}/>,
});
