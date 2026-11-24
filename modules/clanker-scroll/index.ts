import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ReactNode } from 'react';

/**
 * Wraps a scroll view nested in an inverted list so that, past its ends, it scrolls the list the
 * way the finger moves. Null on iOS (which doesn't hand scrolls on) and in builds without this
 * module (such as Expo Go, where NestedScroll uses a UI-thread gesture relay instead).
 */
export const InvertedScrollRelay = requireOptionalNativeModule('ClankerScroll')
  ? requireNativeView<{ children: ReactNode }>('ClankerScroll')
  : null;
