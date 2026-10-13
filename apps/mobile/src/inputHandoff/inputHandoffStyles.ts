import { StyleSheet } from "react-native";
import {
  fontWeight,
  lineHeight,
  monoFont,
  radius,
  spacing,
  typeScale,
  type ThemeColors,
} from "@/theme";

export const makeInputHandoffStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      gap: spacing.sm,
      padding: spacing.lg,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
    },
    // 代输入: optional live view of the window, below the step.
    liveView: {
      gap: spacing.sm,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    // 代输入：设备码登录，代码与在本设备打开
    deviceCode: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceChip,
    },
    // 大数字：设备码本身
    deviceCodeText: {
      fontFamily: monoFont,
      fontSize: typeScale.headline,
      lineHeight: lineHeight.headline,
      fontWeight: fontWeight.semibold,
      letterSpacing: 2,
      color: colors.textPrimary,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    row: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    // 列表 / 卡片标题
    title: {
      fontSize: typeScale.subtitle,
      lineHeight: lineHeight.subtitle,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    // 行标题、选项
    label: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    // 次级正文
    body: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    // 时间、计数、状态词
    meta: {
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
    // 说明、提示、报错
    note: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    warning: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
      borderLeftWidth: 2,
      borderLeftColor: colors.warningFg,
      paddingLeft: spacing.sm,
    },
    heading: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
    },
    mono: {
      fontFamily: monoFont,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    input: {
      fontSize: typeScale.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.control,
      paddingHorizontal: spacing.md,
      minHeight: 44,
    },
    option: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.control,
    },
    optionSelected: {
      borderColor: colors.borderStrong,
      backgroundColor: colors.surfaceChip,
    },
    field: { gap: spacing.xs },
    stack: { gap: spacing.md },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    options: { maxHeight: 264 },
    // 代输入画面：整宽、按截图比例，点按位置按比例换算
    picture: {
      width: "100%",
      overflow: "hidden",
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceChip,
    },
    pictureDisabled: { opacity: 0.6 },
    pictureImage: { width: "100%", height: "100%" },
  });
