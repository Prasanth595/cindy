/**
 * 伙伴私聊长按菜单的「选择文字」：长按交给系统菜单后，正文改在这里用系统文字选择挑一部分复制。
 * 挂载即打开；关闭先播完系统收起，再由 onClose 卸载，不叠第二个面板。iOS 用 UITextView，可只选一部分。
 */
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { UITextView } from 'react-native-uitextview';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, spacing, typeScale } from '@/theme/tokens';
import { CompanionSheet } from './CompanionSheet';
import { selectableMessageText } from './selectableMessageText';

export function CompanionSelectTextSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [visible, setVisible] = useState(true);
  return (
    <CompanionSheet visible={visible} title={t('message.renderer.selectText')} onClose={() => setVisible(false)}
      onClosed={onClose} testID="companion.selectTextSheet">
      <View style={styles.content}>
        {/* iOS RN Text can only copy the whole block; UITextView gives system handles for part of it. */}
        {Platform.OS === 'ios'
          ? <UITextView selectable uiTextView style={styles.text}>{selectableMessageText(text)}</UITextView>
          : <Text selectable style={styles.text}>{selectableMessageText(text)}</Text>}
      </View>
    </CompanionSheet>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingBottom: spacing.lg },
  text: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
});
