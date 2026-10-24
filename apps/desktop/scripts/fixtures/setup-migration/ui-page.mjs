import assert from 'node:assert/strict';

// Fixture data only: device and plugin names are generic examples, never real user data.
const sources = [
  { deviceId: 'mbp', name: 'MacBook Pro', platform: 'darwin', online: true, lastSeenAt: null },
  { deviceId: 'office', name: 'Office PC', platform: 'win32', online: true, lastSeenAt: null, unavailable: 'remote-control-off' },
  { deviceId: 'old', name: 'Mac mini (old)', platform: 'darwin', online: false, lastSeenAt: null, unavailable: 'offline' },
];

const consent = (ghostId, name, hosts) => ({
  kind: 'install',
  ghostId,
  name,
  version: '2.1.0',
  permissions: hosts.map((host) => ({ key: `network:${host}`, kind: 'network', labelKey: 'networkHost', labelArgs: { host } })),
});

const plugin = (ghostId, name, extra = {}) => ({
  key: `plugin:_root:${ghostId}`,
  state: 'ready',
  ghostId,
  name,
  version: '2.1.0',
  namespace: null,
  pluginId: `plg_${ghostId}`,
  source: 'market',
  marketName: null,
  enabledOnSource: true,
  consent: null,
  ...extra,
});

const plan = {
  planId: 'fixture-plan',
  source: { deviceId: 'mbp', name: 'MacBook Pro', platform: 'darwin' },
  createdAt: 0,
  plugins: [
    plugin('gmail', 'Gmail', { consent: consent('gmail', 'Gmail', ['gmail.googleapis.com']) }),
    plugin('calendar', 'Calendar Sync', { enabledOnSource: false, consent: consent('calendar', 'Calendar Sync', ['www.googleapis.com']) }),
    plugin('design-kit', 'Design Kit', { source: 'custom-market', marketName: 'Team Market', pluginId: 'custom:Team%20Market/design-kit' }),
    plugin('local-notes', 'Local Notes', { state: 'unavailable', reason: 'local-only', source: 'manual', pluginId: null }),
    plugin('retired', 'Retired Helper', { state: 'unavailable', reason: 'not-in-catalog' }),
    plugin('github', 'GitHub', { state: 'present' }),
  ],
  skills: [
    { key: 'skill:release-notes', state: 'ready', name: 'release-notes', version: '1.2.0', catalogScope: 'market', enabledOnSource: true },
    { key: 'skill:team-review', state: 'ready', name: 'team-review', version: '0.4.0', catalogScope: 'team', enabledOnSource: true },
    { key: 'skill:my-notes', state: 'unavailable', reason: 'local-only', name: 'my-notes', version: null, catalogScope: null, enabledOnSource: true },
  ],
  settings: [
    { key: 'settings:appearance', id: 'appearance', changeCount: 3, keptCount: 0, state: 'ready' },
    { key: 'settings:collaboration', id: 'collaboration', changeCount: 2, keptCount: 1, state: 'ready' },
    { key: 'settings:gitSafety', id: 'gitSafety', changeCount: 0, keptCount: 1, state: 'kept' },
    { key: 'settings:memory', id: 'memory', changeCount: 0, keptCount: 0, state: 'present' },
  ],
  rendererPrefs: { key: 'renderer-prefs', state: 'ready', values: { theme: 'dark', language: 'zh-CN' } },
  providers: [
    { key: 'provider:openrouter', state: 'ready', provider: { id: 'openrouter', name: 'OpenRouter', auth: 'apiKey', config: { id: 'openrouter', name: 'OpenRouter', runtimes: {} } } },
    { key: 'provider:ollama', state: 'unavailable', reason: 'local-only', provider: { id: 'ollama', name: 'Ollama (local)', auth: 'none', config: { id: 'ollama', runtimes: {} } } },
  ],
  mcpServers: [
    { key: 'mcp:docs', state: 'ready', server: { id: 'docs', name: 'Team Docs', transport: 'http', url: 'https://mcp.example.com/docs', headers: {}, hasToken: true } },
  ],
  builtinTools: [{ key: 'builtin-tool:browser', id: 'browser', enabled: true, state: 'ready' }],
  access: [
    { key: 'access:remote-control', id: 'remote-control', state: 'ready' },
    { key: 'access:keep-awake', id: 'keep-awake', state: 'ready' },
  ],
  checklist: [
    { id: 'provider-key:openrouter', kind: 'provider-key', label: 'OpenRouter', ref: 'openrouter' },
    { id: 'provider-connection:openrouter', kind: 'provider-connection', label: 'OpenRouter', ref: 'openrouter' },
    { id: 'mcp-token:docs', kind: 'mcp-token', label: 'Team Docs', ref: 'docs' },
    { id: 'im-channel:telegram', kind: 'im-channel', label: 'telegram', ref: 'telegram' },
    { id: 'computer-use', kind: 'computer-use', label: 'computer', ref: 'computer' },
    { id: 'ssh', kind: 'ssh', label: '3' },
  ],
  unavailable: [],
};

const checklistAfter = [
  { id: 'plugin-setup:_root__gmail', kind: 'plugin-setup', label: 'Gmail', ref: '_root__gmail', details: ['Google account'] },
  ...plan.checklist,
];

const applyResponse = {
  results: [
    { key: 'plugin:_root:gmail', outcome: 'done' },
    { key: 'plugin:_root:calendar', outcome: 'done' },
    { key: 'plugin:_root:design-kit', outcome: 'failed', code: 'MUTATION_CANCELLED' },
    { key: 'skill:release-notes', outcome: 'done' },
    { key: 'skill:team-review', outcome: 'done' },
    { key: 'settings:appearance', outcome: 'done' },
    { key: 'settings:collaboration', outcome: 'done' },
  ],
  checklist: checklistAfter,
};

const tools = [{ id: 'browser', name: 'Browser' }];

async function next(page, ui) {
  await page.getByRole('button', { name: await ui.t('setupMigration.source.next'), exact: true }).click();
  await page.getByText('Gmail', { exact: true }).first().waitFor();
}

const readyCount = [
  ...plan.plugins,
  ...plan.skills,
  ...plan.settings,
  plan.rendererPrefs,
  ...plan.providers,
  ...plan.mcpServers,
  ...plan.builtinTools,
  ...plan.access,
].filter((item) => item.state === 'ready').length;

async function start(page, ui) {
  const label = await ui.t('setupMigration.review.start', { count: readyCount });
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByText(await ui.t('setupMigration.permissions.title'), { exact: true }).waitFor();
}

export default {
  name: 'setup-migration',
  entry: './setup-migration-fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'SetupMigrationDialog (computer picker, review groups, batch plugin permissions with GhostInstallConsentContent, result and one-time checklist), SetupMigrationSection, translations and themes',
  notCovered: 'Main-side snapshot, plan, plugin/skill installers and settings writes (unit-tested in src/main/setup-migration), device-link transport, the first-run suggestion timer, and two real computers',
  cases: {
    source: { about: 'Pick a computer; offline and remote-control-off computers explain why they cannot be read', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    default: { about: 'Review what moves: plugins, skills, settings, providers/MCP, access switches and the one-time checklist', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    permissions: { about: 'One confirmation for the permissions of all selected market plugins', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    done: { about: 'Result with a failed item and what is left to do on this computer', data: { surface: 'dialog', sources, plan, applyResponse, tools } },
    'read-error': { about: 'The other computer runs an older Cindy', data: { surface: 'dialog', deviceId: 'mbp', sources, plan, previewError: 'SETUP_SOURCE_OUTDATED', applyResponse, tools } },
    settings: {
      about: 'Settings → General entry with the remaining checklist',
      data: {
        surface: 'settings',
        state: { lastRun: { sourceName: 'MacBook Pro', finishedAt: 0, checklist: checklistAfter.map((item, index) => (index === 1 ? { ...item, done: true } : item)) }, suggestion: null },
      },
      viewport: { width: 900, height: 760 },
    },
  },
  async check(page, ui) {
    if (ui.case === 'settings') {
      await page.getByText(await ui.t('setupMigration.settings.description'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'read-error') {
      await page.getByText(await ui.t('setupMigration.errors.SETUP_SOURCE_OUTDATED', { name: 'MacBook Pro' }), { exact: true }).waitFor();
      return;
    }
    await page.getByText('MacBook Pro', { exact: true }).waitFor();
    if (ui.case === 'source') return;
    await next(page, ui);
    if (ui.case === 'default') {
      // Already-identical items are summarized instead of listed.
      assert.equal(await page.getByText('GitHub', { exact: true }).count(), 0);
      await ui.capture('scrolled', {});
      return;
    }
    await start(page, ui);
    if (ui.case === 'permissions') return;
    const confirm = await ui.t('setupMigration.permissions.confirm', { count: 2 });
    await page.getByRole('button', { name: confirm, exact: true }).click();
    await page.getByText(await ui.t('setupMigration.done.checklistTitle'), { exact: true }).waitFor();
  },
};
