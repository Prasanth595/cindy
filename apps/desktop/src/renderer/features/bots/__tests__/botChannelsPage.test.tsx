// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BotImConnectionListPayload,
  BotImConnectionView,
} from '../../../../shared/botImConnection';
import type { BotProfile } from '../botStore';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

import { BotChannelsPage } from '../BotChannelsPage';

function profile(id: string, name: string): BotProfile {
  return {
    id,
    name,
    description: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {} as BotProfile['capabilities'],
    createdAt: 1,
    sessions: [],
  } as BotProfile;
}

const mia = profile('bot-1', 'Mia');

function connection(overrides: Partial<BotImConnectionView> = {}): BotImConnectionView {
  return {
    id: 'a1b2c3d4e5f6',
    botId: 'bot-1',
    channel: 'telegram',
    createdAt: 1,
    botContextId: '111',
    status: { kind: 'connected', appId: '111' },
    identity: { username: 'mia_bot', ownerUserId: '42' },
    ...overrides,
  };
}

function installApi(payload: BotImConnectionListPayload) {
  const api = {
    list: vi.fn(async () => payload),
    add: vi.fn(async () => ({
      connections: [...payload.connections, connection({ id: 'ffffffffffff', botContextId: '222' })],
      connection: connection({ id: 'ffffffffffff', botContextId: '222' }),
    })),
    remove: vi.fn(async () => ({ connections: [], archivedSessionIds: ['lane-1'] })),
    onChanged: vi.fn(() => () => undefined),
  };
  Object.assign(window, { electronAPI: { botImConnection: api } });
  return api;
}

beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe('BotChannelsPage', () => {
  it('shows the empty state and the external / shared-memory notes', async () => {
    installApi({ connections: [] });
    render(<BotChannelsPage bot={mia} />);

    expect(await screen.findByText('bots.channels.empty:{"name":"Mia"}')).toBeTruthy();
    expect(screen.getByText('bots.channels.externalNote:{"name":"Mia"}')).toBeTruthy();
    expect(screen.getByText('bots.channels.sharedMemoryNote:{"name":"Mia"}')).toBeTruthy();
  });

  it('lists only this teammate’s connections with identity and status, and removes after confirmation', async () => {
    const api = installApi({
      connections: [
        connection(),
        connection({
          id: 'b2c3d4e5f6a1',
          botId: 'bot-2',
          channel: 'feishu',
          service: 'lark',
          botContextId: 'cli_other',
          status: { kind: 'idle' },
          identity: { username: null, ownerUserId: null },
        }),
        connection({
          id: 'c3d4e5f6a1b2',
          channel: 'feishu',
          service: 'lark',
          botContextId: 'cli_a1b2c3d4e5f6',
          status: { kind: 'error', reason: 'app secret rejected' },
          identity: { username: null, ownerUserId: null },
        }),
      ],
    });
    render(<BotChannelsPage bot={mia} />);

    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('bots.channels.platform.telegram')).toBeTruthy();
    expect(within(rows[0]!).getByText('@mia_bot')).toBeTruthy();
    expect(within(rows[0]!).getByText(/bots\.channels\.status\.connected/)).toBeTruthy();
    expect(within(rows[1]!).getByText('bots.channels.platform.lark')).toBeTruthy();
    expect(within(rows[1]!).getByText('cli_a1b2••••e5f6')).toBeTruthy();
    expect(within(rows[1]!).getByText(/bots\.channels\.status\.error · app secret rejected/)).toBeTruthy();

    fireEvent.click(within(rows[0]!).getByRole('button', { name: /bots\.channels\.removeAria/ }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ id: 'a1b2c3d4e5f6' }));
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'bots.channels.removeConfirm.description:{"name":"Mia"}' }),
    );
    expect(await screen.findByText('bots.channels.empty:{"name":"Mia"}')).toBeTruthy();
  });

  it('adds a Telegram bot from its token and owner id', async () => {
    const api = installApi({ connections: [] });
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.tokenLabel'), {
      target: { value: 'not a token' },
    });
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.ownerLabel'), {
      target: { value: '4242' },
    });
    fireEvent.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'bots.channels.add.errors.invalidToken',
    );
    expect(api.add).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.tokenLabel'), {
      target: { value: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith({
        botId: 'bot-1',
        channel: 'telegram',
        token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        ownerUserId: '4242',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(await screen.findByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('switches to the Feishu form and explains a connect failure in place', async () => {
    const api = installApi({ connections: [] });
    api.add.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'botImConnection:add': Error: [PRECONDITION_FAILED] CONNECT_FAILED: invalid app secret",
      ),
    );
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /bots\.channels\.platform\.feishu/ }));
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.feishu.appIdLabel'), {
      target: { value: 'cli_abc' },
    });
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.feishu.appSecretLabel'), {
      target: { value: 'secret' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' }));

    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith({
        botId: 'bot-1',
        channel: 'feishu',
        appId: 'cli_abc',
        appSecret: 'secret',
        service: 'feishu',
      }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'bots.channels.add.errors.connectFailed:{"reason":"invalid app secret"}',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('tells the user when the same bot is already connected on this computer', async () => {
    const api = installApi({ connections: [] });
    api.add.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'botImConnection:add': Error: [PRECONDITION_FAILED] TOKEN_IN_USE: already connected",
      ),
    );
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.tokenLabel'), {
      target: { value: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    });
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.ownerLabel'), {
      target: { value: '4242' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'bots.channels.add.errors.conflict',
    );
  });
});
