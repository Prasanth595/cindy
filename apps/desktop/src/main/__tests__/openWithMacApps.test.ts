import { expect, it } from 'vitest';

import { MAC_OPEN_WITH_SCRIPT, parseMacOpenWithApps } from '../openWithMacApps';

it('accepts only absolute app bundle paths and nonempty labels', () => {
  const apps = parseMacOpenWithApps(
    JSON.stringify([
      { exePath: '/Applications/Code.app', label: ' Code ', lastUsedAt: 123, installedAt: null },
      { exePath: '/Applications/Typora.app', label: 'Typora', lastUsedAt: -1, installedAt: '2000' },
      { exePath: 'relative.app', label: 'Invalid' },
      { exePath: '/bin/sh', label: 'Shell' },
      { exePath: '/Applications/Bad.app', label: '' },
      { exePath: '/Applications/Bad\0.app', label: 'Invalid' },
      null,
    ]),
  );
  expect(apps).toEqual([
    { exePath: '/Applications/Code.app', label: 'Code' },
    { exePath: '/Applications/Typora.app', label: 'Typora' },
  ]);
  expect(parseMacOpenWithApps('{}')).toEqual([]);
});

it('keeps the native script static and passes the file path only as argv', () => {
  expect(MAC_OPEN_WITH_SCRIPT).toContain('fileURLWithPath(argv[0])');
  expect(MAC_OPEN_WITH_SCRIPT).not.toContain('NSMetadataItem');
  expect(MAC_OPEN_WITH_SCRIPT).not.toContain('kMDItemFSContentChangeDate');
  expect(MAC_OPEN_WITH_SCRIPT).toContain('/^public\\.');
});
