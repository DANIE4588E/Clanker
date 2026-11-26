import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { PluginId } from '@/lib/plugins/catalog';
import { BRAND_MARKS } from '@/lib/plugins/marks';
import { useTheme } from '@/lib/theme';

const SIMPLE_ICON: Partial<Record<PluginId, string>> = {
  gmail: 'gmail',
  'google-calendar': 'googlecalendar',
  'google-drive': 'googledrive',
  'google-docs': 'googledocs',
  'google-sheets': 'googlesheets',
  'google-slides': 'googleslides',
  'google-tasks': 'googletasks',
  github: 'github',
  notion: 'notion',
  linear: 'linear',
  figma: 'figma',
  todoist: 'todoist',
  asana: 'asana',
  clickup: 'clickup',
  airtable: 'airtable',
  dropbox: 'dropbox',
  spotify: 'spotify',
  atlassian: 'atlassian',
  miro: 'miro',
  calendly: 'calendly',
  make: 'make',
  paypal: 'paypal',
  sentry: 'sentry',
  supabase: 'supabase',
  netlify: 'netlify',
  neon: 'neon',
  huggingface: 'huggingface',
  webflow: 'webflow',
  wix: 'wix',
  excalidraw: 'excalidraw',
};

/**
 * Brands Simple Icons doesn't carry: the icons their own sites publish, bundled with the app.
 * `fill` icons are already square app tiles and cover the whole tile; the others are marks.
 * `mono` marks are one dark color, tinted with the text color on the dark theme.
 */
const IMAGES: Partial<Record<PluginId, { source: number; color: string; fill?: boolean; mono?: boolean }>> = {
  attio: { source: require('../../assets/plugins/attio.png'), color: '#1F2937', mono: true },
  jotform: { source: require('../../assets/plugins/jotform.png'), color: '#FF6100' },
  granola: { source: require('../../assets/plugins/granola.png'), color: '#9FB33A', fill: true },
  context7: { source: require('../../assets/plugins/context7.png'), color: '#0E7C59', fill: true },
  deepwiki: { source: require('../../assets/plugins/deepwiki.png'), color: '#2D5BDB', fill: true },
};

const MS_BLUE = '#0078D4';

/** Brand color of a plugin, for tints and gradients. */
export function pluginColor(id: PluginId) {
  const key = SIMPLE_ICON[id];
  if (key) return BRAND_MARKS[key].hex;
  const image = IMAGES[id];
  if (image) return image.color;
  return id === 'weather' ? '#3B8FE0' : id === 'study' ? '#7C5CFA' : id === 'microsoft-todo' ? '#2564CF' : MS_BLUE;
}

/** Relative luminance of a #rrggbb color, 0 (black) to 1 (white). */
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** The plugin's mark alone, `size` square. */
function Mark({ id, size }: { id: PluginId; size: number }) {
  const { colors, scheme } = useTheme();
  const key = SIMPLE_ICON[id];
  const svg = { width: size, height: size, viewBox: '0 0 24 24', accessibilityElementsHidden: true, importantForAccessibility: 'no' as const };
  if (key) {
    const { hex, d } = BRAND_MARKS[key];
    // Marks too dark to see on the tile (GitHub, Notion; on the dark theme also Sentry, PayPal,
    // Miro) follow the text color instead.
    const tooDark = luminance(hex) < (scheme === 'dark' ? 0.06 : 0.03);
    return (
      <Svg {...svg}>
        <Path d={d} fill={tooDark ? colors.text : hex} />
      </Svg>
    );
  }
  const image = IMAGES[id];
  if (image) {
    return (
      <Image
        source={image.source}
        style={{ width: size, height: size }}
        contentFit="contain"
        tintColor={image.mono && scheme === 'dark' ? colors.text : undefined}
        accessible={false}
      />
    );
  }
  switch (id) {
    case 'outlook':
      return (
        <Svg {...svg}>
          <Rect x={2} y={5} width={20} height={14} rx={2.5} fill={MS_BLUE} />
          <Path d="M3.5 7.5 12 13l8.5-5.5" stroke="#FFFFFF" strokeWidth={1.8} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        </Svg>
      );
    case 'outlook-calendar':
      return (
        <Svg {...svg}>
          <Rect x={3} y={4.5} width={18} height={16} rx={2.5} fill={MS_BLUE} />
          <Rect x={3} y={4.5} width={18} height={4.5} rx={2} fill="#005A9E" />
          <Rect x={7} y={2.5} width={2} height={4} rx={1} fill="#005A9E" />
          <Rect x={15} y={2.5} width={2} height={4} rx={1} fill="#005A9E" />
          {[0, 1, 2].map((r) =>
            [0, 1, 2].map((c) => <Rect key={`${r}${c}`} x={6.5 + c * 4} y={11 + r * 3} width={2.5} height={1.8} rx={0.5} fill="#FFFFFF" />)
          )}
        </Svg>
      );
    case 'onedrive':
      return (
        <Svg {...svg}>
          <Path d="M6.6 19A4.6 4.6 0 0 1 5.8 9.9 6.4 6.4 0 0 1 17.9 9.7 4.7 4.7 0 0 1 17.6 19Z" fill={MS_BLUE} />
        </Svg>
      );
    case 'microsoft-todo':
      return (
        <Svg {...svg}>
          <Path d="M3.5 12.5 9 18 20.5 6.5" stroke="#2564CF" strokeWidth={3.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      );
    case 'weather':
      return (
        <Svg {...svg}>
          <Circle cx={9} cy={9} r={4.5} fill="#F6B500" />
          <Path d="M8.5 20a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.4 1.7A3.2 3.2 0 0 1 18 20Z" fill="#8FB8E8" />
        </Svg>
      );
    case 'study':
      return (
        <Svg {...svg}>
          <Path d="M12 3.5 1.5 8.5 12 13.5l10.5-5Z" fill="#7C5CFA" />
          <Path d="M5.5 11v4.6c0 1.6 2.9 3.4 6.5 3.4s6.5-1.8 6.5-3.4V11L12 14.2Z" fill="#A894FF" />
          <Path d="M21 9.2v6.3" stroke="#7C5CFA" strokeWidth={1.6} strokeLinecap="round" />
          <Circle cx={21} cy={16.4} r={1.3} fill="#7C5CFA" />
        </Svg>
      );
    default:
      return null;
  }
}

/** A plugin's mark on an app-icon tile. */
export function PluginTile({ id, size = 40 }: { id: PluginId; size?: number }) {
  const { colors, scheme } = useTheme();
  const image = IMAGES[id];
  if (image?.fill) {
    return (
      <View style={[styles.tile, { width: size, height: size, borderRadius: size * 0.27, borderColor: colors.border, overflow: 'hidden' }]}>
        <Image source={image.source} style={{ width: size, height: size }} contentFit="cover" accessible={false} />
      </View>
    );
  }
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: size * 0.27,
          backgroundColor: scheme === 'dark' ? '#161616' : '#FFFFFF',
          borderColor: colors.border,
        },
      ]}
    >
      <Mark id={id} size={size * 0.58} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
});
