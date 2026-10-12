// @vitest-environment jsdom
/**
 * 另一台电脑上的供应商组(只读)：组所在电脑看它能用、这台电脑却连不上的组内电脑，不显示成能用
 * (provider-groups.md §10)。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupView } from '../../../../shared/providerGroup';
import { RemoteProviderGroupMembers } from '../RemoteProviderGroupMembers';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthDeviceId: () => 'self' }));
vi.mock('../../provider-share/providerShareNames', () => ({
  providerShareComputerName: (_t: unknown, name: string | null) => name ?? 'share',
  useProviderShareOwnerNameOf: () => () => null,
}));
vi.mock('../GroupMemberQuota', () => ({
  GroupMemberQuota: () => null,
  groupMemberQuotaTarget: () => null,
}));

const VM = {
  key: 'device:vm:anthropic',
  kind: 'device' as const,
  agentDeviceId: 'vm',
  providerId: 'anthropic',
  label: 'grok-bot-vm',
  limit: 4,
  weight: 1,
  paused: false,
};
const CONFIG: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [VM] };

function mountWith(status: Partial<ProviderGroupView['members'][number]>) {
  const view: ProviderGroupView = {
    providerId: 'anthropic',
    config: CONFIG,
    members: [{ key: VM.key, kind: 'device', label: VM.label, state: 'available', running: 2, limit: 4, weight: 1, paused: false, ...status }],
  };
  const command = vi.fn(async () => view);
  Object.assign(window, { electronAPI: { providerGroup: { command } } });
  render(<RemoteProviderGroupMembers deviceId="mini" providerId="anthropic" config={CONFIG} />);
  return command;
}

afterEach(() => {
  cleanup();
});

describe('RemoteProviderGroupMembers', () => {
  it('says this computer cannot reach a computer the group computer still sees as usable', async () => {
    mountWith({ unreachableHere: true });
    await waitFor(() => expect(screen.getByText('providerGroup.member.status.unreachableHere')).toBeTruthy());
    const row = screen.getByTestId('remote-provider-group-member');
    expect(row.getAttribute('data-unreachable-here')).toBe('true');
    // 运行数仍然列出，放在后面。
    expect(row.textContent).toContain('providerGroup.member.runningCount:{"count":2}');
  });

  it('shows the group computer’s status when this computer can reach it', async () => {
    mountWith({});
    await waitFor(() => expect(screen.getByText('providerGroup.member.runningCount:{"count":2}')).toBeTruthy());
    expect(screen.queryByText('providerGroup.member.status.unreachableHere')).toBeNull();
    expect(screen.getByTestId('remote-provider-group-member').getAttribute('data-unreachable-here')).toBeNull();
  });
});
