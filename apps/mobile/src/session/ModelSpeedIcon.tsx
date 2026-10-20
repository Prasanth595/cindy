import Svg, { Path } from 'react-native-svg';
import { Zap } from 'lucide-react-native';

export function ModelSpeedIcon({ mode, size = 16, color }: {
  mode: boolean | 'ultrafast'; size?: number; color: string;
}) {
  if (mode !== 'ultrafast') return <Zap size={size} color={color} fill={color} />;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M11.5 2 2 13h5l-2 9L15.5 10h-5l1-8Z" />
      <Path d="m16 3-1 5h6L10 21" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
