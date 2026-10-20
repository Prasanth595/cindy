import assert from 'node:assert/strict';

const host = {
  config: {
    id: 'example-host',
    displayName: 'SSH example',
    hostname: 'ssh.example.com',
    port: 2222,
    user: 'deploy',
    authMethod: 'agent',
    identityFileConfigured: true,
    identityFileName: 'id_ed25519',
    source: 'manual',
    managedByCindy: true,
  },
  status: 'disconnected',
  statusChangedAt: 0,
  autoConnect: false,
  agentProxy: null,
  agentProxyTunnel: null,
};
const cause = 'All configured authentication methods failed';
const identities = ['~/.ssh/id_ed25519', 'backup/id_rsa'];

function scenario(kind, messageKey, extra = {}) {
  const initial = kind === 'key-rejected'
    ? { ...host, config: { ...host.config, authMethod: 'key' } }
    : host;
  const authFailure = {
    kind, user: host.config.user, hostname: host.config.hostname, identities, cause, ...extra,
  };
  return {
    host: initial,
    failed: { ...initial, status: 'failed', lastError: cause, authFailure },
    messageKey,
  };
}

/**
 * #4201 / DESIGN.md §4 Toast, §10 dual-mode gate, §11.1–11.3.
 * UI/e2e coverage: the formatter unit tests do not exercise RemoteSection's
 * status-push → connect-rejection → localized toast and host-row flow.
 * Minimal input: one host, one failed snapshot, one SSH_AUTH_FAILED rejection.
 * Host transport is simulated; the components, formatter and catalogs are real.
 */
export default {
  name: 'remote-ssh-auth',
  entry: './remote-ssh-auth-fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'RemoteSection host row and connect handler, formatRemoteAuthFailure, ToastContainer, themes, fonts and five locale catalogs',
  notCovered: 'Real SSH authentication, main/preload IPC ordering, credential resolution/redaction, host editing and key management; host APIs use synthetic data',
  cases: {
    default: {
      about: 'Agent signed but authentication did not complete; two identity files and underlying cause',
      data: scenario('agent-signed-not-accepted', 'agentSignedNotAccepted'),
    },
    'not-loaded': {
      about: 'No pinned identity loaded in ssh-agent; local action hint',
      data: scenario('agent-not-loaded', 'agentNotLoaded'),
    },
    'key-rejected': {
      about: 'Identity-file failure keeps the copyable ssh-copy-id command',
      data: scenario('key-rejected', 'keyRejected', {
        command: 'ssh-copy-id -p 2222 -i <public-key-file> deploy@ssh.example.com',
      }),
    },
    'legacy-fallback': {
      about: 'Missing structured detail keeps the original IPC error message',
      data: { host, failed: { ...host, status: 'failed', lastError: cause } },
    },
  },
  async ready(page) {
    await page.getByText('SSH example', { exact: true }).waitFor();
  },
  async check(page, ui) {
    const detail = ui.data.failed.authFailure;
    let expected = cause;
    if (detail) {
      const joined = identities.join(await ui.t('settings.remote.authFailure.identitySeparator'));
      const identitySet = await ui.t('settings.remote.authFailure.identitySet', { identities: joined });
      expected = await ui.t(`settings.remote.authFailure.${ui.data.messageKey}`, {
        target: 'deploy@ssh.example.com', identitySet, command: detail.command ?? '',
      });
      expected += await ui.t('settings.remote.authFailure.cause', { cause });
    }
    await page.getByRole('button', {
      name: await ui.t('settings.remote.button.connect'), exact: true,
    }).click();
    const notice = page.getByRole('alert');
    await notice.waitFor();
    assert.ok((await notice.innerText()).includes(expected), 'connect failure toast uses the active locale');
    const subtitle = page.locator('span[title]').filter({ hasText: expected });
    assert.equal(await subtitle.getAttribute('title'), expected, 'host row retains the full diagnostic');
    assert.equal(await subtitle.textContent(), expected, 'host row and toast agree');
    await ui.capture('authentication-failed');
  },
};
