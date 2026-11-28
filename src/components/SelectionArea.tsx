import { createContext, useContext, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSettings } from '@/store/settings';
import { SelectionScope } from '../../modules/clanker-selection';

const InArea = createContext(false);

/** Whether areas select their text themselves, so the Text in them mustn't be selectable. */
export const areasSelect = !!SelectionScope;

/** Whether chat text selects at all: the user's setting, off unless they turn it on. */
export function useTextSelection() {
  return useSettings((s) => s.textSelection);
}

/**
 * Chat text the user can select across paragraphs, code and lists in one go, with "Ask Clanker"
 * beside Copy. Where the native selection isn't in the build, each Text selects on its own;
 * where the setting is off, nothing selects and the area is just a View.
 */
export function SelectionArea({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const on = useTextSelection();
  if (!SelectionScope || !on) return <View style={style}>{children}</View>;
  return (
    <InArea.Provider value>
      <SelectionScope style={style}>{children}</SelectionScope>
    </InArea.Provider>
  );
}

/** Whether a Text selects natively: with the setting on, and not inside a selection area, which selects for it. */
export function useSelectable() {
  const inArea = useContext(InArea);
  return useTextSelection() && !inArea;
}
