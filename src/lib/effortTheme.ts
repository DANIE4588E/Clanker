import type { Colors } from './theme';

/**
 * How "charged" a level looks: 0 for everyday levels (flat accent blue), rising through
 * high → xhigh → max as the fill turns from blue into a starry deep violet.
 */
export type EffortTier = 0 | 1 | 2 | 3;

const NAMED: Record<string, EffortTier> = {
  high: 1,
  xhigh: 2,
  'x-high': 2,
  'extra-high': 2,
  extra_high: 2,
  veryhigh: 2,
  'very-high': 2,
  max: 3,
  maximum: 3,
  ultra: 3,
  extreme: 3,
};

/**
 * The tier of `level` within `levels`. Known names keep the same look on every model; a name
 * the app doesn't know (remote backends report their own) is placed by its position: past
 * `high` it's charged, and the top of the range always gets the full look.
 */
export function effortTier(levels: string[], level: string): EffortTier {
  const key = level.toLowerCase();
  const named = NAMED[key];
  if (named !== undefined) return named;
  const i = levels.indexOf(level);
  const high = levels.findIndex((l) => NAMED[l.toLowerCase()] === 1);
  if (i < 0 || high < 0 || i <= high) return 0;
  return i === levels.length - 1 ? 3 : 2;
}

/**
 * How fast the stars drift left at each tier, in track widths per second: still at everyday
 * levels, a slow drift at high, racing across at the top.
 */
export const EFFORT_DRIFT = [0, 0.18, 0.42, 0.9];

/** Left-to-right gradient stops for each tier above 0; tier 0 is the solid accent. */
export const EFFORT_GRADIENTS: Record<Exclude<EffortTier, 0>, string[]> = {
  1: ['#4A6CF0', '#6C63F2', '#9A5CF6'],
  2: ['#3A2BBF', '#6239E3', '#9F55FA'],
  3: ['#2A1288', '#4F25CF', '#8A3FF5', '#B57CFF'],
};

/** The halo colour around the slider and the tint of its outline at the higher tiers. */
export const EFFORT_GLOW = '#8B5CF6';

const WORD = {
  light: ['', '#5A4FEA', '#6A3DE3', '#7A2EDF'],
  dark: ['', '#A8A6FF', '#B796FF', '#C79DFF'],
};

/** The colour of the level's name in the slider label, matching its fill. */
export function effortWordColor(tier: EffortTier, scheme: 'light' | 'dark', colors: Colors) {
  return tier === 0 ? colors.accentText : WORD[scheme][tier];
}
