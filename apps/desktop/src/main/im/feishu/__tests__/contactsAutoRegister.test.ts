import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const createContact = vi.fn();
  const resolve = vi.fn();
  return {
    enabled: true,
    createContact,
    emitLocalContactsChanged: vi.fn(),
    resolve,
    // manager 在进程内复用同一个 store; 模块靠它的实例变化感知账号切换。
    store: { createContact, resolve },
  };
});

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../maker-host/maker-contacts-host.js', () => ({
  getDesktopContactsManager: () => ({
    getStore: () => harness.store,
  }),
}));

vi.mock('../../../maker-host/contacts-settings-store.js', () => ({
  readContactsSettingsState: () => ({ value: { enabled: harness.enabled } }),
}));

vi.mock('../../../maker-host/contacts-change-events.js', () => ({
  emitLocalContactsChanged: harness.emitLocalContactsChanged,
}));

import {
  autoRegisterFeishuSpeakers,
  resetFeishuSpeakerRegistrationCache,
} from '../contactsAutoRegister.js';

describe('Feishu contacts auto-register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.enabled = true;
    harness.resolve.mockReturnValue([]);
    resetFeishuSpeakerRegistrationCache();
  });

  it('registers a non-owner group speaker once with an app-scoped open_id', () => {
    const speaker = { openId: 'ou_alice', name: 'Alice' };
    autoRegisterFeishuSpeakers([speaker], { chatName: 'Ops', appId: 'cli_abc' });
    autoRegisterFeishuSpeakers([speaker], { chatName: 'Ops', appId: 'cli_abc' });

    expect(harness.resolve).toHaveBeenCalledOnce();
    expect(harness.createContact).toHaveBeenCalledOnce();
    expect(harness.createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Alice',
        summary: '飞书群「Ops」成员(bot 自动登记)',
        identities: [{ platform: 'feishu', value: 'ou_alice', note: 'app:cli_abc' }],
      }),
    );
    expect(harness.emitLocalContactsChanged).toHaveBeenCalledOnce();
  });

  it('falls back to open_id when the group history carries no display name', () => {
    autoRegisterFeishuSpeakers([{ openId: 'ou_noname', name: '' }], {
      chatName: null,
      appId: 'cli_abc',
    });

    expect(harness.createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'ou_noname',
        summary: '飞书群成员(bot 自动登记)',
      }),
    );
  });

  it('skips owner, bots, disabled settings, and already-known identities', () => {
    autoRegisterFeishuSpeakers([{ openId: 'ou_owner', name: 'Owner', isOwner: true }], {
      appId: 'cli_abc',
    });
    autoRegisterFeishuSpeakers([{ openId: 'ou_bot', name: 'Bot', isBot: true }], {
      appId: 'cli_abc',
    });

    harness.enabled = false;
    autoRegisterFeishuSpeakers([{ openId: 'ou_disabled', name: 'Disabled' }], {
      appId: 'cli_abc',
    });

    harness.enabled = true;
    harness.resolve.mockReturnValue([{ matchType: 'identity' }]);
    autoRegisterFeishuSpeakers([{ openId: 'ou_known', name: 'Known' }], {
      appId: 'cli_abc',
    });

    expect(harness.createContact).not.toHaveBeenCalled();
    expect(harness.emitLocalContactsChanged).not.toHaveBeenCalled();
    expect(harness.resolve).toHaveBeenCalledOnce();
  });

  it('does not emit a change event when contact creation fails', () => {
    harness.createContact.mockImplementationOnce(() => {
      throw new Error('database busy');
    });

    autoRegisterFeishuSpeakers([{ openId: 'ou_bob', name: 'Bob' }], {
      chatName: '项目群',
      appId: 'cli_abc',
    });

    expect(harness.emitLocalContactsChanged).not.toHaveBeenCalled();
  });
});

