// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

import { UnifiedModelList } from '@/components/settings/UnifiedModelList';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import {
  __resetForTest,
  isModelEnabled,
  setModelVisibility,
  setModelVisibilityOwner,
} from '@/state/modelVisibilityPrefs';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'zh-CN', language: 'zh-CN' } }) }));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 100_000,
    efforts: [],
    defaultEffort: null,
    defaultEnabled: false,
    ...extra,
  } as CatalogModel;
}

const provider = {
  id: 'gateway',
  name: 'Gateway',
  source: 'user',
  connected: true,
  agents: ['claude-code', 'codex', 'pi'],
  auth: { method: 'api-key' },
  routing: {},
  models: {
    'claude-code': [
      model('already'),
      model('closed'),
      model('stopped', { disabled: true }),
      model('locked', { availability: 'requires_payment' }),
      model('old'),
    ],
    codex: [
      model('already'),
      model('closed'),
      model('stopped', { disabled: true }),
      model('locked', { availability: 'requires_payment' }),
      model('old', { status: 'retired' }),
    ],
    pi: [
      model('already'),
      model('closed'),
      model('stopped', { disabled: true }),
      model('locked', { availability: 'requires_payment' }),
      model('old'),
    ],
  },
} as ProviderView;

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        claimLegacyModelVisibilityOwner: () => ({
          dataOwnerId: 'test-owner',
          ownerGeneration: 1,
          canWriteOwnerScoped: true,
          claimed: true,
          claimedByOtherOwner: false,
          canInitialize: true,
          profileOrigin: 'new',
        }),
        syncModelVisibility: async () => undefined,
      },
    },
  });
  setModelVisibilityOwner('test-owner', 1, 'cloud');
});

afterEach(() => {
  cleanup();
  __resetForTest();
});

describe('manage menu enables one existing engine and keeps it after reload', () => {
  it('writes only the chosen engine for operable models and reads it back after owner reload', async () => {
    expect(await setModelVisibility('claude-code', provider.id, 'already', true)).toBe(true);
    render(
      <ConfirmDialogProvider>
        <UnifiedModelList provider={provider} />
      </ConfirmDialogProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.manage.enableEngine.codex' }));
    await waitFor(() => {
      expect(isModelEnabled('codex', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    });

    expect(isModelEnabled('claude-code', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('pi', provider.id, { id: 'already', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('codex', provider.id, { id: 'closed', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'stopped', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('codex', provider.id, { id: 'locked', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('codex', provider.id, { id: 'old', defaultEnabled: false })).toBe(false);
    expect(isModelEnabled('pi', provider.id, { id: 'old', defaultEnabled: false })).toBe(false);

    await setModelVisibilityOwner('test-owner', 2, 'cloud');
    expect(isModelEnabled('codex', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('codex', provider.id, { id: 'closed', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('claude-code', provider.id, { id: 'already', defaultEnabled: false })).toBe(true);
  });
});
