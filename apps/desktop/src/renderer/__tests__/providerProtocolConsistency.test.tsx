// @vitest-environment jsdom
// Regression coverage: real form, serialization, provider projection and drawer.
// IPC is replaced with an in-memory store; no real credentials or network calls.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildUserProvider, modelProtocolComparison } from '@cindy/model-providers';
import type { CustomProviderConfig, ProviderRuntimeModelConfig, ProviderView } from '@cindy/model-providers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' },
}) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/useModelContextLimit', () => ({ useModelContextLimit: () => ({
  limit: null, isCustomized: false, loading: false, error: false, setLimit: vi.fn(), reset: vi.fn(),
}) }));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  useModelVisibilityVersion: () => 0, isModelEnabled: () => true,
  isModelVisibilityCustomized: () => false, setModelVisibility: vi.fn(), resetModelVisibilities: vi.fn(),
}));
vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0, getProviderModelEffort: () => undefined,
  setProviderModelEffort: vi.fn(), clearProviderModelEffort: vi.fn(),
}));
vi.mock('@/components/settings/ModelPriceOverrideDialog', () => ({ ModelPriceOverrideDialog: () => null }));

import { ProviderConnectionDialog } from '@/components/settings/ProviderConnectionDialog';
import { ModelAdvancedDrawer } from '@/components/settings/ModelAdvancedDrawer';
import { providerViewToCustomProviderConfig } from '@/lib/customProviders';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('issue #6015: saved connection protocol versus model protocol', () => {
  it('also distinguishes a mixed-protocol catalog default from a stored user override', () => {
    const config: CustomProviderConfig = {
      id: 'issue-6015-catalog', name: 'Catalog-only diagnostic fixture',
      runtimes: { codex: {
        baseUrl: 'https://api.individual.githubcopilot.com', wireProtocol: 'openai-chat',
        models: [{ id: 'gpt-5-mini', name: 'GPT-5 mini' }],
      } },
    };
    const projected = buildUserProvider(config);
    const model = projected.models.codex![0]!;
    expect(model.userModelConfig?.api).toBeUndefined();
    expect(model.userModelConfig?.route).toBeUndefined();
    expect(modelProtocolComparison(projected, { codex: model }).forAgent('codex')?.outbound)
      .toBe('openai-responses');
    expect(model.route?.wireProtocol).toBe('openai-responses');
  });

  it.each([
    { name: 'no model override', extra: {}, expectedApi: 'openai-completions', label: 'Chat Completions' },
    { name: 'model API override', extra: { api: 'openai-responses' }, expectedApi: 'openai-responses', label: 'Responses' },
    { name: 'model route override', extra: { route: { baseUrl: 'http://127.0.0.1:4000/v1', wireProtocol: 'openai-responses' } }, expectedApi: 'openai-responses', label: 'Responses' },
  ] as const)('$name', async ({ name, extra, expectedApi, label }) => {
    let saved: CustomProviderConfig = {
      id: 'issue-6015', name: 'Issue 6015 diagnostic fixture', auth: { method: 'none' },
      runtimes: { codex: {
        baseUrl: 'http://127.0.0.1:4000/v1', wireProtocol: 'openai-responses',
        models: [{ id: 'fixture-model', name: 'Fixture model', contextWindow: 32768, ...extra } as ProviderRuntimeModelConfig],
      } },
    };
    const originalModel = structuredClone(saved.runtimes.codex!.models[0]);
    const previousAPI = window.electronAPI;
    const update = vi.fn(async (config: CustomProviderConfig) => {
      saved = structuredClone(config);
      return { ok: true };
    });
    const probe = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      safeStorageRead: vi.fn(async () => null),
      maker: { updateCustomProvider: update, listProviderPresets: vi.fn(async () => ({ presets: [] })),
        fetchProviderModels: probe, testCustomProvider: probe },
    } });
    try {
      const source = { ...buildUserProvider(saved), connected: true } as ProviderView;
      const dialog = render(<ProviderConnectionDialog
        initial={providerViewToCustomProviderConfig(source)} focusAgent="codex"
        onSaved={vi.fn()} onClose={vi.fn()} />);
      const chat = screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.chat' });
      expect(screen.getByText('settings.providers.custom.wireProtocol.defaultLabel')).toBeTruthy();
      fireEvent.click(chat);
      expect(chat.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
      await waitFor(() => expect(update).toHaveBeenCalledOnce());
      expect(saved.runtimes.codex!.wireProtocol).toBe('openai-chat');
      expect(saved.runtimes.codex!.models[0]).toMatchObject(originalModel!);
      // Simulate the main process rebuilding the provider snapshot after Save.
      const refreshed = { ...buildUserProvider(saved), connected: true } as ProviderView;
      const model = refreshed.models.codex![0]!;
      const protocol = modelProtocolComparison(refreshed, { codex: model }).forAgent('codex');
      expect(protocol?.outbound).toBe(expectedApi);
      expect(protocol?.harness).toBe('openai-responses');
      dialog.unmount();
      const reopened = render(<ProviderConnectionDialog
        initial={providerViewToCustomProviderConfig(refreshed)} focusAgent="codex"
        onSaved={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'settings.providers.custom.wireProtocol.chat' })
        .getAttribute('aria-pressed')).toBe('true');
      reopened.unmount();
      render(<ModelAdvancedDrawer provider={refreshed}
        row={{ id: model.id, name: model.name, avail: ['codex'], byAgent: { codex: model } }}
        open onOpenChange={vi.fn()} pricePresentationOf={() => null}
        onDisable={vi.fn()} disabled={false} paymentRequired={false} />);
      expect(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }).textContent)
        .toContain(label);
      expect(screen.getByText(`settings.providers.models.advanced.protocol.source${name === 'no model override' ? 'Connection' : 'Model'}`)).toBeTruthy();
      if (name !== 'no model override') {
        fireEvent.keyDown(screen.getByRole('button', { name: 'Codex · settings.providers.custom.fields.wireProtocol' }), { key: 'ArrowDown' });
        fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.providers.models.advanced.protocol.restoreRoute' }));
        await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
        const restored = saved.runtimes.codex!.models[0]!;
        expect(restored.api).toBeUndefined();
        expect(restored.route).toBeUndefined();
        expect(restored.id).toBe(originalModel!.id);
        expect(restored.contextWindow).toBe(32768);
        const afterReset = buildUserProvider(saved);
        expect(modelProtocolComparison(afterReset, { codex: afterReset.models.codex![0]! }).forAgent('codex'))
          .toMatchObject({ outbound: 'openai-completions', source: 'connection' });
      }
      expect(probe).not.toHaveBeenCalled();
    } finally {
      cleanup();
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: previousAPI });
    }
  });
});
