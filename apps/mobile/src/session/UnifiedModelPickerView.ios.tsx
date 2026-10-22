import { NativeErrorNotice } from "@/components/NativeErrorNotice.ios";
import { ModelSpeedIcon } from "./ModelSpeedIcon";
import {
  Background,
  Button,
  Divider,
  HStack,
  LazyVStack,
  ScrollView,
  UnevenRoundedRectangle,
  Picker,
  ProgressView,
  RNHostView,
  VStack,
  Text,
  TextField,
  Toggle,
  useNativeState,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonStyle,
  id,
  onAppear,
  onDisappear,
  onGeometryChange,
  onScrollPhaseChange,
  scrollDismissesKeyboard,
  scrollPosition,
  scrollTargetLayout,
  disabled,
  font,
  foregroundStyle,
  frame,
  pickerStyle,
  progressViewStyle,
  tint,
  tag,
  padding,
  autocorrectionDisabled,
  textInputAutocapitalization,
  lineLimit,
} from "@expo/ui/swift-ui/modifiers";
import {
  Check,
  SlidersHorizontal,
  Star,
  Zap,
  Search,
  X,
  LayoutGrid,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { iconSize, radius, spacing, useTheme } from "@/theme";
import { MobileAgentMark } from "@/components/MobileAgentMark";
import { ComposerSheet } from "./ComposerSheet";
import { ComposerNativeSection as Section } from "./ComposerNativeSection";
import { ComposerNativeRow } from "./ComposerNativeRow";
import { MobileModelIconMark, MobileProviderMark } from "./MobileProviderMark";
import { groupSourceFilters } from "./remoteSourceFilters";
import { mobileAgentLabel } from "./sessionAgentSwitch";
import type { UnifiedMobilePickerViewProps } from "./UnifiedModelPickerSheet";

function NativeMark({ children }: { children: ReactNode }) {
  return (
    <RNHostView matchContents>
      <View
        pointerEvents="none"
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </View>
    </RNHostView>
  );
}

/** 来源格的供应商 mark;另一台电脑上的供应商带远程标记(右上角一道波纹加一个点)。 */
function ProviderSourceMark({
  filter,
}: {
  filter: UnifiedMobilePickerViewProps["filters"][number] | undefined;
}) {
  return (
    <MobileProviderMark
      {...filter?.providerMark}
      name={filter?.providerMark?.name ?? ""}
      remote={filter?.remote != null}
    />
  );
}

export function UnifiedModelPickerView(p: UnifiedMobilePickerViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [page, setPage] = useState<"sources" | "harness" | null>(null);
  useEffect(() => {
    setPage(null);
  }, [p.visible, p.options?.row.key]);
  const mark = (Icon: typeof Star, filled = false) => (
    <NativeMark>
      <Icon
        size={iconSize.action}
        color={colors.textSecondary}
        fill={filled ? colors.textSecondary : "none"}
      />
    </NativeMark>
  );
  const search = useNativeState(p.query);
  useEffect(() => {
    if (search.get() !== p.query) search.set(p.query);
  }, [p.query, search]);
  const options = p.options;
  const isFavorite = options?.isFavorite ?? !!options?.row.favorite;
  const config = options?.row.config;
  const rootActive = !options && !page;
  // scrollPosition needs iOS 17, but reliable user-drag cancellation needs 18.
  // The installed Expo UI has no drag gesture bridge for older systems.
  const supportsInitialReveal = Number.parseInt(String(Platform.Version), 10) >= 18;
  const selectedGroup = p.groups.find((group) =>
    group.rows.some((row) => row.selected && !row.favorite),
  );
  const selectedRow = selectedGroup?.rows.find(
    (row) => row.selected && !row.favorite,
  );
  const selectedTarget =
    selectedGroup && selectedRow
      ? JSON.stringify([selectedGroup.key, selectedRow.key])
      : null;
  const scrollTarget = useNativeState<string | null>(null);
  const reveal = useRef({
    pending: false,
    appeared: false,
    laidOut: false,
    rootStarted: false,
  });
  const cancelReveal = () => {
    reveal.current.pending = false;
  };
  const revealSelected = () => {
    const state = reveal.current;
    if (
      !supportsInitialReveal ||
      !p.visible ||
      p.busy ||
      p.loading ||
      !rootActive ||
      p.query?.trim() ||
      !state.pending ||
      !state.appeared ||
      !state.laidOut ||
      !selectedTarget
    )
      return;
    state.pending = false;
    scrollTarget.set(selectedTarget);
  };
  useEffect(() => {
    reveal.current.pending = supportsInitialReveal && p.visible;
    reveal.current.rootStarted = false;
    if (!p.visible) reveal.current.appeared = false;
    if (supportsInitialReveal) scrollTarget.set(null);
  }, [p.visible, scrollTarget, supportsInitialReveal]);
  useEffect(() => {
    if (!p.visible) return;
    // Parent resets an old details page on opening. Wait for the root once,
    // then a user's navigation away cancels any still-pending initial reveal.
    if (rootActive) reveal.current.rootStarted = true;
    else if (reveal.current.rootStarted) cancelReveal();
    revealSelected();
  }, [p.visible, p.busy, p.loading, rootActive, selectedTarget, p.query]);
  const level = (id: string) =>
    t(`models.options.effortLevels.${id}`, { defaultValue: id });
  const listHeader = (
    <HStack spacing={12} modifiers={[padding({ horizontal: 20, bottom: 4 })]}>
      {mark(Search)}
      <TextField
        text={search}
        onFocusChange={(focused) => { if (focused) cancelReveal(); }}
        onTextChange={(value) => {
          cancelReveal();
          p.onQuery(value);
        }}
        placeholder={t("models.picker.searchPlaceholder")}
        modifiers={[
          frame({ maxWidth: Infinity, minHeight: 44 }),
          autocorrectionDisabled(),
          textInputAutocapitalization("never"),
        ]}
        testID={`${p.testID}.search`}
      />
      {p.query ? (
        <Button
          onPress={() => {
            cancelReveal();
            p.onQuery("");
          }}
          modifiers={[
            buttonStyle("plain"),
            accessibilityLabel(t("devices.detail.search.clearA11y")),
          ]}
        >
          <HStack modifiers={[frame({ width: 44, height: 44 })]}>
            {mark(X)}
          </HStack>
        </Button>
      ) : null}
      <Button
        onPress={() => {
          cancelReveal();
          setPage("sources");
        }}
        modifiers={[
          buttonStyle("plain"),
          frame({ maxWidth: 120, minHeight: 44 }),
          accessibilityLabel(t("models.unified.source")),
        ]}
        testID={`${p.testID}.filter`}
      >
        <HStack>
          {p.filter === "favorites" ? (
            mark(Star, true)
          ) : p.filter === "all" ? (
            mark(LayoutGrid)
          ) : (
            <NativeMark>
              <ProviderSourceMark
                filter={p.filters.find((item) => item.id === p.filter)}
              />
            </NativeMark>
          )}
          <Text modifiers={[lineLimit(1)]}>
            {p.filters.find((item) => item.id === p.filter)?.label}
          </Text>
        </HStack>
      </Button>
    </HStack>
  );
  const renderModelRow = (row: (typeof p.groups)[number]["rows"][number]) => (
    <ComposerNativeRow
      key={row.key}
      title={row.entry.displayName}
      subtitle={[
        mobileAgentLabel(row.config.agent),
        row.subtitle,
        row.quotaLabel,
      ]
        .filter(Boolean)
        .join(" · ")}
      titleAccessory={
        <HStack spacing={4}>
          {row.costMarks ? (
            <Text
              modifiers={[
                font({ textStyle: "caption" }),
                foregroundStyle(colors.textSecondary),
              ]}
            >
              {row.costMarks}
            </Text>
          ) : null}
          <RNHostView matchContents>
            <View
              pointerEvents="none"
              style={{ width: iconSize.sm, height: iconSize.sm }}
            >
              <MobileAgentMark
                agentKind={row.config.agent}
                color={colors.textSecondary}
              />
            </View>
          </RNHostView>
          {row.effortLabel ? (
            <Text
              modifiers={[
                font({ textStyle: "caption" }),
                foregroundStyle(colors.textSecondary),
              ]}
            >
              {row.effortLabel}
            </Text>
          ) : null}
          {row.config.fast ? (
            <NativeMark>
              <ModelSpeedIcon
                mode={row.config.fast}
                color={colors.textSecondary}
              />
            </NativeMark>
          ) : null}
        </HStack>
      }
      subtitleContent={
        <VStack alignment="leading" spacing={2}>
          <Text
            modifiers={[
              font({ textStyle: "caption" }),
              foregroundStyle(colors.textSecondary),
            ]}
          >
            {row.subtitle}
          </Text>
          {row.quotaLabel ? (
            <Text
              modifiers={[
                font({ textStyle: "caption2" }),
                foregroundStyle(colors.textTertiary),
              ]}
            >
              {row.quotaLabel}
            </Text>
          ) : null}
        </VStack>
      }
      leading={
        <RNHostView matchContents>
          <View
            style={{
              width: 28,
              height: 28,
              justifyContent: "center",
            }}
          >
            <MobileModelIconMark
              icon={row.entry.icon}
              {...row.providerMark}
              color={colors.textSecondary}
              remote={row.remoteDevice != null}
            />
          </View>
        </RNHostView>
      }
      optionsIcon={mark(SlidersHorizontal)}
      selectionIcon={mark(Check)}
      accessory={row.favorite ? mark(Star, true) : undefined}
      selected={row.selected}
      disabled={p.busy || row.disabled}
      onPress={() => {
        cancelReveal();
        p.onSelect(row);
      }}
      onOptions={() => {
        cancelReveal();
        p.onOptions(row);
      }}
      optionsLabel={t("models.picker.configureAccessibility", {
        model: row.entry.displayName,
      })}
      testID={`${p.testID}.model.${row.key}`}
    />
  );
  // Form/List do not support SwiftUI scrollPosition. Keep the root mounted,
  // but use the already-installed native ScrollView and flat lazy targets.
  // Group-rounded backgrounds and separators retain the existing form layout.
  const listContent = supportsInitialReveal ? (
    <ScrollView
      testID={`${p.testID}.list`}
      modifiers={[
        scrollPosition(scrollTarget, { anchor: "center" }),
        scrollDismissesKeyboard("interactively"),
        onAppear(() => {
          if (p.visible) reveal.current.appeared = true;
          revealSelected();
        }),
        onDisappear(() => {
          reveal.current.appeared = false;
        }),
        onGeometryChange(({ width, height }) => {
          reveal.current.laidOut = width > 0 && height > 0;
          revealSelected();
        }),
        onScrollPhaseChange((phase) => {
          if (phase === "tracking" || phase === "interacting") cancelReveal();
        }),
      ]}
    >
      <LazyVStack
        alignment="leading"
        spacing={0}
        modifiers={[
          scrollTargetLayout(),
          padding({ horizontal: spacing.lg, bottom: spacing.xl }),
        ]}
      >
        {p.error ? <NativeErrorNotice message={p.error} /> : null}
        {p.groups.flatMap((group) => [
          <Text
            key={`header:${group.key}`}
            modifiers={[
              font({ textStyle: "footnote" }),
              foregroundStyle(colors.textSecondary),
              padding({
                top: spacing.xl,
                leading: spacing.lg,
                bottom: spacing.sm,
              }),
            ]}
          >
            {group.title}
          </Text>,
          ...group.rows.map((row, index) => (
            <Background
              key={JSON.stringify([group.key, row.key])}
              modifiers={[id(JSON.stringify([group.key, row.key]))]}
            >
              <VStack
                spacing={0}
                modifiers={[
                  frame({ maxWidth: Infinity, alignment: "leading" }),
                ]}
              >
                <VStack
                  modifiers={[
                    padding({ horizontal: spacing.lg, vertical: spacing.sm }),
                  ]}
                >
                  {renderModelRow(row)}
                </VStack>
                {index < group.rows.length - 1 ? (
                  <Divider
                    modifiers={[
                      padding({ leading: spacing.lg }),
                      foregroundStyle(colors.border),
                    ]}
                  />
                ) : null}
              </VStack>
              <Background.Content>
                <UnevenRoundedRectangle
                  topLeadingRadius={index === 0 ? radius.container : 0}
                  topTrailingRadius={index === 0 ? radius.container : 0}
                  bottomLeadingRadius={
                    index === group.rows.length - 1 ? radius.container : 0
                  }
                  bottomTrailingRadius={
                    index === group.rows.length - 1 ? radius.container : 0
                  }
                  modifiers={[foregroundStyle(colors.surfaceTranslucent)]}
                />
              </Background.Content>
            </Background>
          )),
        ])}
        {!p.groups.length ? (
          <Text
            modifiers={[
              foregroundStyle(colors.textSecondary),
              padding({ all: spacing.lg }),
            ]}
          >
            {p.loading ? t("models.picker.loadingDefault") : p.emptyHint}
          </Text>
        ) : null}
      </LazyVStack>
    </ScrollView>
  ) : (
    <>
      {p.error ? (
        <Section>
          <NativeErrorNotice message={p.error} />
        </Section>
      ) : null}
      {p.groups.map((group) => (
        <Section key={group.key} title={group.title}>
          {group.rows.map(renderModelRow)}
        </Section>
      ))}
      {!p.groups.length ? (
        <Section>
          <Text modifiers={[foregroundStyle(colors.textSecondary)]}>
            {p.loading ? t("models.picker.loadingDefault") : p.emptyHint}
          </Text>
        </Section>
      ) : null}
    </>
  );
  const sourceRow = (item: (typeof p.filters)[number]) => (
    <ComposerNativeRow
      key={item.id}
      title={item.remote?.providerLabel ?? item.label}
      subtitle={item.quota?.label}
      testID={`${p.testID}.source.${item.id}`}
      selected={p.filter === item.id}
      selectionIcon={mark(Check)}
      leading={
        item.providerMark ? (
          <VStack spacing={2}>
            <NativeMark>
              <ProviderSourceMark filter={item} />
            </NativeMark>
            {item.quota ? (
              <ProgressView
                value={item.quota.remaining / 100}
                modifiers={[
                  progressViewStyle("linear"),
                  frame({ width: 24 }),
                  tint(colors.textSecondary),
                  accessibilityLabel(item.quota.label),
                ]}
                testID={`${p.testID}.source.${item.id}.quota`}
              />
            ) : null}
          </VStack>
        ) : (
          mark(
            item.id === "favorites" ? Star : LayoutGrid,
            item.id === "favorites" && p.filter === "favorites",
          )
        )
      }
      onPress={() => {
        p.onFilter(item.id);
        setPage(null);
      }}
    />
  );
  // 来源页分块:被控电脑自己的格一块,其他电脑每台一块。
  const sourceGroups = groupSourceFilters(p.filters);
  return (
    <ComposerSheet
      nativeContent
      visible={p.visible}
      onClosed={p.onClosed}
      onClose={p.onClose}
      onBack={page ? () => setPage(null) : p.onBack}
      backLabel={t("models.picker.backToModels")}
      title={
        page === "sources"
          ? t("models.unified.source")
          : page === "harness"
            ? t("models.unified.harness")
            : p.title
      }
      testID={p.testID}
      nativeRoot={{
        active: rootActive,
        contentScrolls: supportsInitialReveal,
        header: listHeader,
        content: listContent,
      }}
    >
      {p.error ? (
        <Section>
          <NativeErrorNotice message={p.error} />
        </Section>
      ) : null}
      {page === "sources" ? (
        <>
          <Section>{sourceGroups.local.map(sourceRow)}</Section>
          {/* 其他电脑的供应商:每台电脑单独一块,块标题是电脑名。 */}
          {sourceGroups.devices.map((device) => (
            <Section key={device.deviceId} title={device.name}>
              {device.filters.map(sourceRow)}
            </Section>
          ))}
        </>
      ) : page === "harness" && options && config ? (
        <Section>
          {options.agents.map((agent) => (
            <ComposerNativeRow
              key={agent}
              title={mobileAgentLabel(agent)}
              leading={
                <NativeMark>
                  <MobileAgentMark
                    agentKind={agent}
                    color={colors.textSecondary}
                  />
                </NativeMark>
              }
              selected={config.agent === agent}
              selectionIcon={mark(Check)}
              disabled={p.busy}
              onPress={() => {
                const cap = options.row.entry.capabilities[agent];
                if (!cap) return;
                options.onChange({
                  ...config,
                  agent,
                  modelId: cap.wireModelId,
                  effort: cap.defaultEffort ?? cap.efforts[0] ?? "",
                  fast: false,
                });
                setPage(null);
              }}
            />
          ))}
        </Section>
      ) : options && config ? (
        <>
          <Section>
            <Text
              modifiers={[
                foregroundStyle(colors.textSecondary),
                font({ textStyle: "footnote" }),
              ]}
            >
              {options.context}
            </Text>
          </Section>
          {options.onEditFavorite ? (
            <Section>
              <ComposerNativeRow
                title={t("models.unified.editFavorite")}
                onPress={options.onEditFavorite}
                disabled={p.busy || options.favoritesDisabled}
                testID={`${p.testID}.editFavorite`}
              />
            </Section>
          ) : null}
          {options.editingFavorite ? (
            <Section>
              <Text
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {t("models.unified.editFavoriteHint")}
              </Text>
            </Section>
          ) : null}
          <Section>
            <ComposerNativeRow
              title={t("models.unified.harness")}
              subtitle={mobileAgentLabel(config.agent)}
              leading={
                <NativeMark>
                  <MobileAgentMark
                    agentKind={config.agent}
                    color={colors.textSecondary}
                  />
                </NativeMark>
              }
              onPress={() => setPage("harness")}
              disabled={p.busy}
              testID={`${p.testID}.harness`}
            />
            {options.row.entry.capabilities[config.agent]?.efforts.length ? (
              <Picker
                label={t("models.options.reasoningEffort")}
                selection={config.effort}
                onSelectionChange={(effort: string) =>
                  options.onChange({ ...config, effort })
                }
                modifiers={[pickerStyle("menu"), disabled(p.busy)]}
                testID={`${p.testID}.effort`}
              >
                {options.row.entry.capabilities[config.agent]!.efforts.map(
                  (effort) => (
                    <Text key={effort} modifiers={[tag(effort)]}>
                      {level(effort)}
                    </Text>
                  ),
                )}
              </Picker>
            ) : null}
            {options.fastCapable && options.row.entry.capabilities[config.agent]?.supportsUltrafastMode ? (
              <Picker
                label={t("models.options.speed.label")}
                selection={config.fast === 'ultrafast' ? 'ultrafast' : config.fast ? 'fast' : 'standard'}
                onSelectionChange={(value: string) => options.onChange({
                  ...config, fast: value === 'ultrafast' ? 'ultrafast' : value === 'fast',
                })}
                modifiers={[pickerStyle("menu"), disabled(p.busy)]}
                testID={`${p.testID}.speed`}
              >
                {(['standard', 'fast', 'ultrafast'] as const).map(value => (
                  <Text key={value} modifiers={[tag(value)]}>{t(`models.options.speed.${value}`)}</Text>
                ))}
              </Picker>
            ) : options.fastCapable ? (
              <HStack>
                {mark(Zap, true)}
                <Toggle
                  label={t("models.options.fastMode")}
                  isOn={!!config.fast}
                  onIsOnChange={(fast) => options.onChange({ ...config, fast })}
                  modifiers={[disabled(p.busy), tint(colors.inputCaret)]}
                  testID={`${p.testID}.fast`}
                />
              </HStack>
            ) : null}
          </Section>
          {!options.editingFavorite ? (
            <Section>
              <Text
                testID={`${p.testID}.configState`}
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {t(
                  options.canReset
                    ? "models.unified.customized"
                    : "models.unified.usingRecommended",
                )}
              </Text>
              {options.canReset ? (
                <ComposerNativeRow
                  title={t("models.unified.restoreRecommended")}
                  onPress={options.onReset}
                  disabled={p.busy}
                  testID={`${p.testID}.reset`}
                />
              ) : null}
              <Text
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {t("models.unified.resetScopeHint")}
              </Text>
            </Section>
          ) : null}
          {options.price ? (
            <Section>
              <Text
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {options.price}
              </Text>
            </Section>
          ) : null}
          {options.editingFavorite ? (
            <Section>
              <ComposerNativeRow
                title={t("models.unified.saveFavorite")}
                onPress={() => options.onSaveEdit?.()}
                disabled={p.busy || options.favoritesDisabled}
                testID={`${p.testID}.saveFavorite`}
              />
              <ComposerNativeRow
                title={t("models.unified.cancelEdit")}
                onPress={() => options.onCancelEdit?.()}
                disabled={p.busy}
                testID={`${p.testID}.cancelEdit`}
              />
            </Section>
          ) : (
            <Section title={t("models.unified.currentConfiguration")}>
              <ComposerNativeRow
                title={t(
                  isFavorite
                    ? "models.unified.savedConfiguration"
                    : "models.unified.favoriteConfiguration",
                )}
                subtitle={options.configurationSummary}
                leading={mark(Star, isFavorite)}
                disabled={p.busy || options.favoritesDisabled}
                onPress={options.onFavorite}
                testID={`${p.testID}.favorite`}
              />
              <Text
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {t(
                  isFavorite
                    ? "models.unified.removeFavoriteHint"
                    : "models.unified.saveFavoriteHint",
                )}
              </Text>
            </Section>
          )}
          {options.notice ? (
            <Section>
              <Text
                testID={`${p.testID}.notice`}
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(colors.textSecondary),
                ]}
              >
                {options.notice}
              </Text>
            </Section>
          ) : null}
        </>
      ) : null}
    </ComposerSheet>
  );
}
