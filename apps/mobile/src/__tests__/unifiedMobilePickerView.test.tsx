// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnifiedModelPickerView } from '@/session/UnifiedModelPickerView';
import { UnifiedModelPickerView as IosModelPickerView } from '@/session/UnifiedModelPickerView.ios';
const nativeScroll = vi.hoisted(() => ({ modifiers: [] as any[] }));
const platform = vi.hoisted(() => ({ OS: 'android', Version: '18.0' }));
const virtualList = vi.hoisted(() => ({ scrollToOffset: vi.fn() }));
const theme = vi.hoisted(() => ({ mode: 'light' as 'light' | 'dark' }));
vi.mock('react-native', async () => {
  const { createElement: el, useImperativeHandle } = await import('react');
  const View = ({ children, accessibilityElementsHidden, pointerEvents }: any) => el('div', { 'aria-hidden': accessibilityElementsHidden, 'data-pointer-events': pointerEvents }, children);
  return {
    Platform: platform,
    View, ScrollView: View,
    FlatList: ({
      ref,
      testID,
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
    }: any) => {
      useImperativeHandle(
        ref,
        () => ({ scrollToOffset: virtualList.scrollToOffset }),
        [],
      );
      return el(
        "div",
        { "data-testid": testID },
        ListHeaderComponent,
        data.length
          ? data.map((item: any, index: number) =>
              el("div", { key: item.key }, renderItem({ item, index })),
            )
          : ListEmptyComponent,
      );
    },

    Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) => el('button', { onClick: onPress, disabled, 'aria-label':accessibilityLabel }, children),
    StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock('@/components/AppText', async () => {
  const { createElement: el } = await import('react');
  return { Text: ({ children }: any) => el('span', null, children), TextInput: () => null };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 40, bottom: 20 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({
  ...Object.fromEntries(['Brain', 'SlidersHorizontal', 'Check', 'Zap', 'LayoutGrid', 'Search', 'X', 'ChevronDown', 'ChevronRight', 'ChevronsUpDown', 'CircleAlert'].map(key => [key, () => null])),
  Star: ({ fill, color }: any) => createElement('span', { 'data-star-fill': fill, 'data-star-color': color }),
}));
vi.mock('react-native-svg', () => ({
  default: ({ children, ...props }: any) => createElement('svg', props, children),
  Path: (props: any) => createElement('path', props),
}));
vi.mock('@expo/ui/swift-ui', async () => {
  const { useRef } = await import('react');
  const Container = ({ children, modifiers, testID }: any) => createElement('div', {
    'data-testid': testID, 'data-modifiers': JSON.stringify(modifiers),
    'aria-hidden': modifiers?.some((m:any) => m.accessibilityHidden === true),
  }, children);
  const Background = Object.assign(Container, { Content: Container });
  return {
    Background,
    Form: (props: any) => createElement('div', { 'data-testid': props.testID, 'data-native-form': '' }, props.children),
    ScrollView: (props: any) => { nativeScroll.modifiers = props.modifiers; return createElement(Container, props); },
    TextField: ({ onTextChange, onFocusChange, text, testID }: any) => createElement('input', { 'data-testid': testID, value: text.get(), onFocus: () => onFocusChange?.(true), onChange: (event:any) => onTextChange(event.target.value) }),
    ...Object.fromEntries(['BottomSheet', 'Group', 'ZStack', 'Image', 'Spacer', 'HStack', 'Picker', 'ProgressView', 'RNHostView', 'VStack', 'LazyVStack', 'Divider', 'UnevenRoundedRectangle', 'Text', 'Toggle'].map(key => [key, Container])),
    Button: ({ children, onPress, modifiers }: any) => createElement('button', {onClick:onPress, 'aria-label':modifiers?.find((m:any)=>m.accessibilityLabel)?.accessibilityLabel}, children),
    useNativeState: (initial: string | null) => useRef({ value: initial, get() { return this.value; }, set: vi.fn(function(this: any, value: string | null) { this.value = value; }) }).current,
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({...Object.fromEntries(
  ['onAppear', 'onDisappear', 'onGeometryChange', 'onScrollPhaseChange', 'scrollTargetLayout', 'id', 'scrollDismissesKeyboard', 'background', 'fixedSize', 'accessibilityElement', 'accessibilityHidden', 'opacity', 'scrollDisabled', 'scrollContentBackground', 'presentationDetents', 'presentationDragIndicator', 'interactiveDismissDisabled', 'contentShape', 'accessibilityLabel', 'buttonStyle', 'disabled', 'font', 'foregroundStyle', 'frame', 'pickerStyle', 'progressViewStyle', 'tint', 'tag', 'padding', 'autocorrectionDisabled', 'textInputAutocapitalization', 'lineLimit'].map(key => [key, (value: any) => ({ [key]: value })]),
), scrollPosition: (state:any, options:any) => ({ scrollPosition: { state, options } }), shapes:{rectangle:()=>({}), roundedRectangle:(value: any)=>value}}));
vi.mock('@expo/ui', () => ({Host:({children}:any)=>children}));
vi.mock('@/session/ComposerSheet', () => import('@/session/ComposerSheet.ios'));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: ({ children, title }: any) => createElement('div', null, title, children) }));
vi.mock('@/session/ComposerNativeRow', () => ({ ComposerNativeRow: ({ leading, title }: any) => createElement('div', null, leading, title) }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: ({ children }: any) => children, NativeSwitch: () => null, usesNativePullDownMenu: () => true }));
vi.mock('@/components/MobileAgentMark', () => ({ MobileAgentMark: () => null }));
// 远程标记由 mark 自己按 remote 画(字形不缩放不移位),桩里只留一个可数的记号。
vi.mock('@/session/MobileProviderMark', () => {
  const stub = ({ remote }: any) => (remote ? createElement('span', { 'data-remote-mark': '' }) : null);
  return { MobileModelIconMark: stub, MobileProviderMark: stub };
});
vi.mock('@/session/SheetModal', () => ({ SheetModal: ({ children }: any) => children }));
vi.mock('@/session/SheetSurface', () => ({ SheetSurface: ({ children, pinnedTop, onBack, backAccessibilityLabel, testID, renderScrollContent }: any) => createElement('section', null,
  onBack ? createElement('button', {onClick:onBack, 'aria-label':backAccessibilityLabel ?? 'shared.back'}, 'Back') : null,
  pinnedTop, renderScrollContent ? renderScrollContent({ testID: `${testID}.scroll` }) : createElement('div', {'data-testid':`${testID}.scroll`}, children)) }));
vi.mock('@/session/sessionAgentSwitch', () => ({ mobileAgentLabel: (agent: string) => agent }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.palettes[theme.mode] }), useThemedStyles: (factory: any) => factory(tokens.palettes[theme.mode]) };
});
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  platform.Version = '18.0';
  virtualList.scrollToOffset.mockClear();
  nativeScroll.modifiers = [];
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
it.each([null, '2d · 70%'])('keeps both account identities visible with quota %s', async quotaLabel => {
  const rows = ['first@example.com', 'second@example.com'].map(subtitle => ({
    key: subtitle, subtitle, quotaLabel, entry: { displayName: 'Same Model' },
    config: { agent: 'codex' }, providerMark: {},
  }));
  await act(async () => root.render(createElement(UnifiedModelPickerView, {
    visible: true, groups: [{ key: 'favorites', title: 'Favorites', rows }], filters: [],
  } as any)));
  for (const row of rows) expect(host.textContent).toContain(row.subtitle);
  if (quotaLabel) expect(host.textContent).toContain(quotaLabel);
});

it.each([
  ['Android', 'light', UnifiedModelPickerView],
  ['Android', 'dark', UnifiedModelPickerView],
  ['iOS', 'light', IosModelPickerView],
  ['iOS', 'dark', IosModelPickerView],
] as const)('shows add/remove favorite states on %s in %s mode while retaining source settings', async (_platform, mode, Component) => {
  theme.mode = mode;
  const row = {
    key: 'model', entry: { capabilities: { codex: { efforts: [] } } },
    config: { agent: 'codex' },
  };
  const render = async (isFavorite: boolean | undefined, favorite = false) => {
    await act(async () => root.render(createElement(Component, {
      visible: true, groups: [], filters: [], query: '',
      options: { row: { ...row, favorite: favorite ? { uid: 'saved' } : undefined }, agents: ['codex'], isFavorite, canReset:true },
    } as any)));
  };
  const fill = () => host.querySelector('[data-star-fill]')?.getAttribute('data-star-fill');
  await render(false);
  expect(fill()).toBe('none');
  expect(host.textContent).toContain('models.unified.favoriteConfiguration');
  await render(true);
  const color = host.querySelector('[data-star-fill]')?.getAttribute('data-star-color');
  expect(color).toBeTruthy();
  expect(fill()).toBe(color);
  expect(host.textContent).toContain('models.unified.savedConfiguration');
  expect(host.textContent).toContain('models.unified.restoreRecommended');
  await render(false);
  expect(fill()).toBe('none');
  expect(host.textContent).toContain('models.unified.favoriteConfiguration');
  await render(undefined, true);
  expect(fill()).toBe(color);
  expect(host.textContent).toContain('models.unified.savedConfiguration');
});

it.each([['Android', UnifiedModelPickerView], ['iOS', IosModelPickerView]] as const)(
  'separates recommendation status, reset and explicit favorite editing on %s', async (_platform, Component) => {
    const row={key:'model',entry:{displayName:'Model',capabilities:{codex:{efforts:[]}}},config:{agent:'codex',effort:'high',fast:false},providerMark:{}};
    const render=async(extra:Record<string,unknown>)=>act(async()=>root.render(createElement(Component,{
      visible:true,testID:'modelSheet',title:'Model',query:'',filter:'all',groups:[],filters:[],
      options:{row,agents:['codex'],isFavorite:true,configurationSummary:'Codex · high',...extra},
    } as any)));
    await render({canReset:false});
    expect(host.textContent).toContain('models.unified.usingRecommended');
    expect(host.textContent).not.toContain('models.unified.restoreRecommended');
    expect(host.textContent).toContain('models.unified.savedConfiguration');
    await render({canReset:true,onEditFavorite:vi.fn()});
    expect(host.textContent).toContain('models.unified.customized');
    expect(host.textContent).toContain('models.unified.restoreRecommended');
    expect(host.textContent).toContain('models.unified.resetScopeHint');
    expect(host.textContent).toContain('models.unified.editFavorite');
    await render({canReset:true,editingFavorite:true});
    expect(host.textContent).toContain('models.unified.editFavoriteHint');
    expect(host.textContent).toContain('models.unified.saveFavorite');
    expect(host.textContent).toContain('models.unified.cancelEdit');
    expect(host.textContent).not.toContain('models.unified.restoreRecommended');
    expect(host.textContent).not.toContain('models.unified.savedConfiguration');
  },
);

it.each([
  ['Android', UnifiedModelPickerView, 'modelSheet.scroll', 'modelSheet.list.scroll', '18.0'],
  ['iOS 18', IosModelPickerView, 'modelSheet.list', 'modelSheet.list', '18.0'],
  ['iOS 17', IosModelPickerView, 'modelSheet.list', 'modelSheet.list', '17.7'],
  ['iOS 16.4', IosModelPickerView, 'modelSheet.list', 'modelSheet.list', '16.4'],
] as const)('retains the long list and its scroll position when returning from details on %s', async (_platform, Component, listId, hiddenListId, version) => {
  platform.Version = version;
  const rows = Array.from({length:60}, (_, i) => ({
    key:`model-${i}`, entry:{displayName:`Model ${i}`, capabilities:{codex:{efforts:[]}}},
    config:{agent:'codex'}, subtitle:'Provider', providerMark:{},
  }));
  const props = {
    visible:true, testID:'modelSheet', title:'Models', query:'Model', filter:'provider',
    filters:[{id:'provider',label:'Provider'}], groups:[{key:'provider',title:'Provider',rows}],
    onClose:vi.fn(),
  };
  const render = (options?: any) => root.render(createElement(Component, {
    ...props, options, onBack:options ? () => render() : undefined,
  } as any));
  await act(async () => render());
  const list = host.querySelector(`[data-testid="${listId}"]`) as HTMLElement;
  expect(list).not.toBeNull();
  // iOS 16/17 have no reliable drag-phase callback in the installed Expo UI.
  // Preserve the original Form rather than starting a reveal we cannot cancel.
  if (Number.parseInt(version, 10) < 18) {
    expect(list.hasAttribute('data-native-form')).toBe(true);
    expect(nativeModifier('scrollPosition')).toBeUndefined();
  }
  list.scrollTop = 960;
  virtualList.scrollToOffset.mockClear();
  const listChildren = [...list.childNodes];
  for (const row of [rows[35], rows[40]]) {
    await act(async () => render({row, agents:['codex']}));
    expect(host.querySelector(`[data-testid="${hiddenListId}"]`)).toBe(list);
    expect([...list.childNodes]).toEqual(listChildren);
    expect(list.closest('[aria-hidden="true"]')).not.toBeNull();
    const back = host.querySelector('button[aria-label="models.picker.backToModels"]') as HTMLButtonElement;
    expect(back).not.toBeNull();
    await act(async () => back.click());
    expect(host.querySelector(`[data-testid="${listId}"]`)).toBe(list);
    expect(list.scrollTop).toBe(960);
    expect(virtualList.scrollToOffset).not.toHaveBeenCalled();
    expect(list.closest('[aria-hidden="true"]')).toBeNull();
  }
  const sources = host.querySelector('button[aria-label="models.unified.source"]') as HTMLButtonElement;
  await act(async () => sources.click());
  expect(host.querySelector(`[data-testid="${hiddenListId}"]`)).toBe(list);
  expect(list.closest('[aria-hidden="true"]')).not.toBeNull();
  const back = host.querySelector('button[aria-label="models.picker.backToModels"], button[aria-label="shared.back"]') as HTMLButtonElement;
  await act(async () => back.click());
  expect(host.querySelector(`[data-testid="${listId}"]`)).toBe(list);
  expect(list.scrollTop).toBe(960);
  expect(list.closest('[aria-hidden="true"]')).toBeNull();
});

it.each([
  ['Android', UnifiedModelPickerView],
  ['iOS', IosModelPickerView],
] as const)('lists each other computer as its own source block on %s', async (_platform, Component) => {
  const remote = (deviceId: string, deviceName: string, providerLabel: string) => ({
    id: `remote:${deviceId}:${providerLabel}`,
    label: `${providerLabel} · ${deviceName}`,
    providerMark: { name: providerLabel },
    remote: { deviceId, deviceName, providerLabel },
  });
  const filters = [
    { id: 'all', label: 'All' },
    { id: 'account', label: 'Local Provider', providerMark: { name: 'Local Provider' } },
    remote('studio', 'Studio Mac', 'Claude Sub'),
    remote('office', 'Office PC', 'Codex Sub'),
    remote('studio', 'Studio Mac', 'OpenRouter'),
  ];
  const onFilter = vi.fn();
  await act(async () => root.render(createElement(Component, {
    visible: true, testID: 'modelSheet', title: 'Models', query: '', filter: 'all', filters, groups: [], onFilter,
  } as any)));
  const sourceButton = host.querySelector('button[aria-label="models.unified.source"]') as HTMLButtonElement;
  await act(async () => sourceButton.click());
  const text = host.textContent ?? '';
  // 每台电脑一块,块标题是电脑名;块里的行只写供应商名。
  expect(text).toContain('Studio Mac');
  expect(text).toContain('Office PC');
  expect(text.indexOf('Local Provider')).toBeLessThan(text.indexOf('Studio Mac'));
  expect(text.indexOf('Studio Mac')).toBeLessThan(text.indexOf('Claude Sub'));
  expect(text.indexOf('OpenRouter')).toBeLessThan(text.indexOf('Office PC'));
  expect(text).not.toContain('Claude Sub · Studio Mac');
  // 其他电脑的供应商图标带远程标记,本机的不带。
  expect(host.querySelectorAll('[data-remote-mark]')).toHaveLength(3);
});

it.each([
  ['Android', UnifiedModelPickerView],
  ['iOS', IosModelPickerView],
] as const)('marks model rows from another computer on %s', async (_platform, Component) => {
  const row = (key: string, remoteDevice?: { deviceId: string; name: string }) => ({
    key, entry: { displayName: key, capabilities: { codex: { efforts: [] } } },
    config: { agent: 'codex' }, subtitle: '', providerMark: {}, ...(remoteDevice ? { remoteDevice } : {}),
  });
  await act(async () => root.render(createElement(Component, {
    visible: true, testID: 'modelSheet', title: 'Models', query: '', filter: 'all', filters: [],
    groups: [
      { key: 'account', title: 'Local Provider', rows: [row('local')] },
      { key: 'remote', title: 'Claude Sub · Studio Mac', rows: [row('remote', { deviceId: 'studio', name: 'Studio Mac' })] },
    ],
  } as any)));
  expect(host.textContent).toContain('Claude Sub · Studio Mac');
  expect(host.querySelectorAll('[data-remote-mark]')).toHaveLength(1);
});

it('keeps selection errors visible in the retained native root list', async () => {
  await act(async () => root.render(createElement(IosModelPickerView, {
    visible:true, testID:'modelSheet', query:'', filters:[], groups:[], error:'Save failed',
  } as any)));
  const list = host.querySelector('[data-testid="modelSheet.list"]');
  expect(list?.textContent).toContain('Save failed');
});

it.each(["query", "filter"])(
  "returns to the first result when %s changes after scrolling",
  async (field) => {
    const props = {
      visible: true,
      groups: [],
      filters: [],
      query: "",
      filter: "all",
      emptyHint: "No results",
    };
    await act(async () =>
      root.render(createElement(UnifiedModelPickerView, props as any)),
    );
    virtualList.scrollToOffset.mockClear();
    await act(async () =>
      root.render(
        createElement(UnifiedModelPickerView, {
          ...props,
          [field]: "changed",
        } as any),
      ),
    );
    expect(virtualList.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
    expect(host.textContent).toContain("No results");
  },
);


// Test value: drive the native list's presentation/layout/drag events, then assert
// the actual scroll binding written by the real picker. Existing list-retention
// tests never open on a selected model. Minimal failure: selected row after many
// favorites, including a catalog delivered after opening. Tier: unit.
function iosRevealProps(overrides: Record<string, unknown> = {}) {
  const row = (key: string, selected = false) => ({
    key, selected, entry: { displayName: key, capabilities: { codex: { efforts: [] } } },
    config: { agent: 'codex' }, subtitle: 'Provider', providerMark: {},
  });
  return {
    visible: true, testID: 'modelSheet', title: 'Models', query: '', filter: 'all',
    filters: [{ id: 'all', label: 'All' }], onClose: vi.fn(), onQuery: vi.fn(), onOptions: vi.fn(),
    groups: [
      { key: 'favorites', title: 'Favorites', rows: Array.from({ length: 30 }, (_, index) => row(`favorite-${index}`)) },
      { key: 'provider', title: 'Provider', rows: [row('current', true)] },
    ],
    ...overrides,
  };
}
function nativeModifier(name: string) {
  return nativeScroll.modifiers.find(item => item && name in item)?.[name];
}
function presentNativeList() {
  nativeModifier('onAppear')();
  nativeModifier('onGeometryChange')({ x: 0, y: 100, width: 400, height: 350 });
}
it('reveals the selected native row after layout, preserves manual scroll, and reveals again on reopen', async () => {
  const props = iosRevealProps();
  await act(async () => root.render(createElement(IosModelPickerView, props as any)));
  const position = nativeModifier('scrollPosition')?.state;
  expect(position).toBeDefined();
  expect(position.get()).toBeNull();
  await act(async () => presentNativeList());
  const selectedTarget = position.get();
  expect(selectedTarget).toContain('current');
  const writes = position.set.mock.calls.length;
  position.value = 'manually-scrolled-row';
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, busy: true } as any)));
  expect(position.set).toHaveBeenCalledTimes(writes);
  expect(position.get()).toBe('manually-scrolled-row');
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, visible: false } as any)));
  await act(async () => root.render(createElement(IosModelPickerView, props as any)));
  await act(async () => presentNativeList());
  expect(position.get()).toBe(selectedTarget);
});
it('waits for a late native catalog without treating automatic source selection as a user scroll', async () => {
  const props = iosRevealProps();
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, groups: [] } as any)));
  await act(async () => presentNativeList());
  const position = nativeModifier('scrollPosition').state;
  expect(position.get()).toBeNull();
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, filter: 'provider' } as any)));
  expect(position.get()).toContain('current');
});
it.each(['drag', 'focus', 'search', 'sources', 'options'])('does not steal native scroll from %s while the catalog arrives', async action => {
  const props = iosRevealProps();
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, groups: [] } as any)));
  await act(async () => presentNativeList());
  const position = nativeModifier('scrollPosition').state;
  await act(async () => {
    if (action === 'drag') nativeModifier('onScrollPhaseChange')('tracking', {});
    if (action === 'focus') (host.querySelector('[data-testid="modelSheet.search"]') as HTMLInputElement).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    if (action === 'search') {
      const input = host.querySelector('[data-testid="modelSheet.search"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'query');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (action === 'sources') (host.querySelector('button[aria-label="models.unified.source"]') as HTMLButtonElement).click();
    if (action === 'options') root.render(createElement(IosModelPickerView, { ...props, groups: [], options: { row: props.groups[1].rows[0], agents: ['codex'] } } as any));
  });
  await act(async () => root.render(createElement(IosModelPickerView, props as any)));
  expect(position.get()).toBeNull();
});

it.each(['query', 'options'])('waits for stale %s from the previous presentation to reset on reopening', async stale => {
  const props = iosRevealProps();
  const oldPage = stale === 'query' ? { query: 'old search' } : {
    options: { row: props.groups[1].rows[0], agents: ['codex'] },
  };
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, ...oldPage, visible: false } as any)));
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, ...oldPage } as any)));
  await act(async () => presentNativeList());
  const position = nativeModifier('scrollPosition').state;
  expect(position.get()).toBeNull();
  await act(async () => root.render(createElement(IosModelPickerView, props as any)));
  expect(position.get()).toContain('current');
});
it('waits until the picker is ready and catalog loading finishes before positioning the native list', async () => {
  const props = iosRevealProps();
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, busy: true, loading: true } as any)));
  await act(async () => presentNativeList());
  const position = nativeModifier('scrollPosition').state;
  expect(position.get()).toBeNull();
  await act(async () => root.render(createElement(IosModelPickerView, { ...props, loading: true } as any)));
  expect(position.get()).toBeNull();
  await act(async () => root.render(createElement(IosModelPickerView, props as any)));
  expect(position.get()).toContain('current');
});
