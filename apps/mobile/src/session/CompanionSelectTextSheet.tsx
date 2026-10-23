/**
 * 伙伴私聊长按菜单的「选择文字」：长按交给系统菜单后，正文改在这里用系统文字选择挑一部分复制。
 * 挂载即打开；关闭先播完系统收起，再由 onClose 卸载，不叠第二个面板。iOS 用 UITextView，可只选一部分。
 * Android 用按内容定高的面板：短消息不留大片空白，长消息在面板内滚动。不用原生底部面板：它打开时把
 * 焦点交给可选文字，Android 会在正文上画一条默认焦点高亮。
 */
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { UITextView } from 'react-native-uitextview';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/AppText';
import { usePaneViewport } from '@/platform/AdaptiveWindowContext';
import { radius, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { CompanionSheet } from './CompanionSheet';
import { SheetModal } from './SheetModal';
import { SheetGrabber } from './SheetSurface';
import { selectableMessageText } from './selectableMessageText';

export function CompanionSelectTextSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // The pane SheetModal lays this out in (one side of a fold, a floating panel), not the whole window.
  const viewport = usePaneViewport();
  const [visible, setVisible] = useState(true);
  const title = t('message.renderer.selectText');
  const close = () => setVisible(false);
  if (Platform.OS === 'android') {
    return (
      <SheetModal visible={visible} onRequestClose={close} onBackdropPress={close} onClosed={onClose}>
        <View style={[styles.androidCard, { maxHeight: viewport.height * 0.8, paddingBottom: spacing.lg + insets.bottom }]}
          testID="companion.selectTextSheet">
          <SheetGrabber />
          <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{title}</Text>
          {/* Sized by its text inside the content-height sheet; scrolls once it reaches the cap. */}
          <ScrollView style={styles.scroll}>
            <Text selectable style={styles.text}>{selectableMessageText(text)}</Text>
          </ScrollView>
        </View>
      </SheetModal>
    );
  }
  return (
    <CompanionSheet visible={visible} title={title} onClose={close} onClosed={onClose} testID="companion.selectTextSheet">
      <View style={styles.content}>
        {/* iOS RN Text can only copy the whole block; UITextView gives system handles for part of it. */}
        <UITextView selectable uiTextView style={styles.text}>{selectableMessageText(text)}</UITextView>
      </View>
    </CompanionSheet>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingBottom: spacing.lg },
  // Same surface, corners and padding as the other teammate sheets (SheetSurface).
  androidCard: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    paddingHorizontal: 20,
    paddingTop: spacing.sm,
  },
  scroll: { flexGrow: 0 },
  title: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold, textAlign: 'center', paddingBottom: spacing.md },
  text: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
});
