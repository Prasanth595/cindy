import { StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import { MonitorOff, MonitorSmartphone } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, typeScale } from '@/theme/tokens';
import type { HomeProjectMachineIdentity } from './homeProjectMachineIdentity';

/** Desktop ProjectNode / RemoteProjectIcon: icon stays even when the heading owns the label. */
export function HomeProjectMachineLabel({ identity, labelStyle, testID }: {
  identity: HomeProjectMachineIdentity;
  /** Applies to the name only: task rows cap it harder so it truncates before the title. */
  labelStyle?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const Icon = identity.disconnected ? MonitorOff : MonitorSmartphone;
  return (
    <>
      <Icon
        color={colors.textSecondary}
        size={iconSize.sm}
        strokeWidth={iconStroke.regular}
        style={identity.disconnected ? styles.disconnected : styles.icon}
      />
      {!identity.hideLabel ? (
        // Name and ID are separate texts: on a narrow row only the name gives way,
        // so same-named computers never collapse into the same visible label.
        <View style={styles.labelGroup} testID={testID}>
          <Text style={[styles.name, labelStyle]} numberOfLines={1} ellipsizeMode="tail">{identity.name}</Text>
          {identity.suffix ? (
            <Text style={styles.suffix} numberOfLines={1} ellipsizeMode="middle">{` · ${identity.suffix}`}</Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  icon: { flexShrink: 0 },
  disconnected: { flexShrink: 0, opacity: 0.75 },
  labelGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    maxWidth: '45%',
    minWidth: 0,
  },
  name: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: typeScale.micro,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    minWidth: 0,
  },
  // The ID never shrinks, so it is what tells same-named computers apart; the
  // cap and middle ellipsis only guard against an unusually long one.
  suffix: {
    color: colors.textSecondary,
    flexShrink: 0,
    fontSize: typeScale.micro,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    maxWidth: 96,
  },
});
