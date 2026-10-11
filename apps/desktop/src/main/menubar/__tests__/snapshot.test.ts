import { describe, expect, it } from 'vitest';

import { DEFAULT_MENUBAR_SETTINGS, type MenubarSettings } from '../../../shared/menubarQuota';
import type { SupportedLocale } from '../../../shared/locale';
import { mainStringKeysUnder, rawMainString } from '../../i18n';
import { familyLogo, MENUBAR_CINDY_LOGO, MENUBAR_HARNESS_LOGOS } from '../logos';
import {
  buildMenubarView,
  isLowOnEverything,
  type MenubarBuildInput,
  type MenubarSourceInput,
  type MenubarSubscriptionInput,
} from '../snapshot';
import { buildMenubarUiStrings, createMenubarTranslate, fillTemplate } from '../strings';

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function codex(id: string, usedPercent: number, extra: Partial<MenubarSubscriptionInput> = {}): MenubarSubscriptionInput {
  return {
    kind: 'subscription',
    id,
    providerId: `codex-${id}`,
    family: 'codex',
    logoSvg: familyLogo('codex'),
    brand: 'Codex',
    account: `${id}@example.com`,
    plan: 'Pro',
    windows: [{ kind: 'week', usedPercent, resetsAtMs: NOW + 3 * DAY, windowMinutes: 10_080 }],
    credits: null,
    creditsUnlimited: false,
    prepaidUsd: null,
    updatedAtMs: NOW - 60_000,
    ...extra,
  };
}

function input(sources: MenubarSourceInput[], options: { locale?: SupportedLocale; settings?: Partial<MenubarSettings> } = {}): MenubarBuildInput {
  const locale = options.locale ?? 'en';
  const raw = (key: string) => rawMainString(key, locale);
  const days = Array.from({ length: 90 }, (_, i) => new Date(NOW - (89 - i) * DAY).toISOString().slice(0, 10));
  const daily = days.map(() => ({ money: [1, 1, 0] as [number, number, number], paid: 0, tokens: [10, 10, 0] as [number, number, number] }));
  const scope = { daily, models: { '7': [], '30': [], '90': [] }, devices: [{ name: 'Mac', isSelf: true, syncedAtMs: null }] };
  return {
    nowMs: NOW,
    locale,
    moneySymbol: '$',
    settings: { ...DEFAULT_MENUBAR_SETTINGS, ...options.settings },
    sources,
    tasks: [],
    usage: { days, scopes: { local: scope, all: scope } },
    updatedAtMs: NOW - 60_000,
    harnessLogos: MENUBAR_HARNESS_LOGOS,
    uiStrings: buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, locale),
    t: createMenubarTranslate(locale, raw),
  };
}

describe('buildMenubarView', () => {
  it('recommends the source with the most room and outlines its tube', () => {
    const view = buildMenubarView(input([codex('alpha', 80), codex('beta', 20)]));
    expect(view.headlinePrimary).toBe('beta has the most left.');
    const beta = view.sources.find((s) => s.id === 'beta');
    expect(beta).toMatchObject({ value: '80', valueUnit: '%', level: 'normal', fill: 0.8, emphasized: true });
    expect(view.sources.find((s) => s.id === 'alpha')?.emphasized).toBe(false);
  });

  it('marks a nearly empty window as a warning', () => {
    const view = buildMenubarView(input([codex('alpha', 93)]));
    expect(view.sources[0]).toMatchObject({ value: '7', level: 'warn', fill: 0.07 });
  });

  it('hatches a used-up window that still has extra credits', () => {
    const view = buildMenubarView(input([codex('alpha', 100, { credits: 61_838 }), codex('beta', 10)]));
    const alpha = view.sources.find((s) => s.id === 'alpha');
    expect(alpha).toMatchObject({ value: null, reserve: true, fill: 0, level: 'error' });
    expect(view.details.alpha.action).toEqual({ kind: 'new-task', providerId: 'codex-alpha' });
  });

  it('follows the saved order and hides pay-as-you-go connections until shown', () => {
    const payg: MenubarSourceInput = { kind: 'payg', id: 'glm', providerId: 'glm', logoSvg: '', name: 'GLM', billing: 'api' };
    const sources = [codex('alpha', 10), codex('beta', 10), payg];
    const ordered = buildMenubarView(input(sources, { settings: { order: ['beta', 'alpha'] } }));
    expect(ordered.sources.map((s) => s.id)).toEqual(['beta', 'alpha']);
    expect(ordered.manage.find((row) => row.id === 'glm')?.hidden).toBe(true);
    const shown = buildMenubarView(input(sources, { settings: { shown: ['glm'] } }));
    expect(shown.sources.map((s) => s.id)).toContain('glm');
  });

  it('masks account names in privacy mode', () => {
    const view = buildMenubarView(input([codex('alpha', 10)], { settings: { privacy: true } }));
    expect(view.sources[0].name).not.toContain('alpha');
  });

  it('sends the balance detail to top-up instead of a new task', () => {
    const balance: MenubarSourceInput = {
      kind: 'balance', id: 'cindy', logoSvg: MENUBAR_CINDY_LOGO, available: 12, fullAmount: 20,
      burnPerDay: 3, observedAtMs: NOW, currency: 'USD',
    };
    const view = buildMenubarView(input([balance]));
    expect(view.details.cindy.action).toEqual({ kind: 'open-billing' });
    expect(view.sources[0].fill).toBeCloseTo(0.6);
  });

  it('says nothing was read instead of "used up" when no level is known', () => {
    const unread = buildMenubarView(input([codex('alpha', 0, { windows: [] })]));
    expect(unread.headlinePrimary).toBe('Quota not read yet.');
    expect(unread.sources[0].fill).toBeNull();
    const empty = buildMenubarView(input([]));
    expect(empty.headlinePrimary).toBe('Nothing with a quota yet.');
    const usedUp = buildMenubarView(input([codex('alpha', 100)]));
    expect(usedUp.headlinePrimary).toBe('Everything is used up.');
  });

  it('carries the sign-in gate with no status text', () => {
    const view = buildMenubarView({ ...input([]), gate: 'sign-in' });
    expect(view.gate).toBe('sign-in');
    expect(Object.values(view.statusTextByMode).every((text) => text === null)).toBe(true);
    expect(view.strings.gateTitle).toBeTruthy();
    expect(buildMenubarView(input([codex('alpha', 10)])).gate).toBeUndefined();
  });

  it('localizes the headline', () => {
    const view = buildMenubarView(input([codex('alpha', 80), codex('beta', 20)], { locale: 'zh-CN' }));
    expect(view.headlinePrimary).toBe('beta 余量最足。');
  });
});

describe('isLowOnEverything', () => {
  it('is true only when every readable source is nearly empty', () => {
    expect(isLowOnEverything(input([codex('alpha', 95), codex('beta', 99)]))).toBe(true);
    expect(isLowOnEverything(input([codex('alpha', 95), codex('beta', 50)]))).toBe(false);
  });

  it('ignores sources it cannot read and stays quiet with nothing known', () => {
    const unread = codex('alpha', 0, { windows: [] });
    expect(isLowOnEverything(input([unread]))).toBe(false);
  });
});

describe('menubar strings', () => {
  it('fills known placeholders and leaves unknown ones visible', () => {
    expect(fillTemplate('{{a}} and {{b}}', { a: 1 })).toBe('1 and {{b}}');
  });

  it('picks plural variants by count', () => {
    const table: Record<string, string> = { 'menubar.x_one': 'one item', 'menubar.x_other': '{{count}} items' };
    const t = createMenubarTranslate('en', (key) => table[key] ?? null);
    expect(t('x', { count: 1 })).toBe('one item');
    expect(t('x', { count: 3 })).toBe('3 items');
    expect(t('missing')).toBe('menubar.missing');
  });

  it('sends plural families to the helper with both forms', () => {
    const table: Record<string, string> = { 'menubar.ui.n_one': 'a', 'menubar.ui.n_other': 'b', 'menubar.ui.plain': 'p' };
    const strings = buildMenubarUiStrings(['n_one', 'n_other', 'plain'], (key) => table[key] ?? null, 'en');
    expect(strings).toEqual({ n: 'b', n_one: 'a', n_other: 'b', plain: 'p' });
  });

  it('never takes a fallback-locale singular for locales without one', () => {
    const raw = (key: string) => rawMainString(key, 'zh-CN');
    const strings = buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, 'zh-CN');
    expect(strings.updatedMinutes_one).toBe(strings.updatedMinutes_other);
    expect(strings.updatedMinutes_one).not.toMatch(/Updated/);
  });
});
