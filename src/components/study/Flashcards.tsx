import Feather from '@expo/vector-icons/Feather';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from '@/lib/haptics';
import { useTheme } from '@/lib/theme';
import { CardTitle, hashKey, IconButton, Pager, parseLoose, PillButton, RichText, str, StudyCard, useFollowUp, useSticky } from './shared';

/** What a ```flashcards block holds, normalized from the shapes a model may write. */
export type FlashcardSpec = { title?: string; cards: { front: string; back: string; hint?: string }[] };

/** Reads a flashcards block's JSON; null when it isn't a deck this can show. */
export function parseFlashcards(json: string): FlashcardSpec | null {
  const raw = parseLoose(json);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cards) ? raw.cards : null;
  if (!list) return null;
  const cards = list.flatMap((c: any) => {
    const front = str(c?.front ?? c?.term ?? c?.question ?? c?.q);
    const back = str(c?.back ?? c?.definition ?? c?.answer ?? c?.a);
    return front && back ? [{ front, back, hint: str(c?.hint) || undefined }] : [];
  });
  return cards.length ? { title: str(raw?.title) || undefined, cards } : null;
}

type Mark = 'known' | 'learning';
type DeckState = { order: number[]; index: number; flipped: boolean; marks: (Mark | null)[]; done: boolean };

const shuffled = (n: number) => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function FlashcardsInner({ source }: { source: string }) {
  const { colors, scheme } = useTheme();
  const followUp = useFollowUp();
  const deck = useMemo(() => parseFlashcards(source), [source]);
  const count = deck?.cards.length ?? 0;
  const fresh = (order = Array.from({ length: count }, (_, i) => i)): DeckState => ({
    order,
    index: 0,
    flipped: false,
    marks: Array(count).fill(null),
    done: false,
  });
  const [state, setState] = useSticky<DeckState>(hashKey('cards', source), () => fresh());
  // The flip: the card narrows to an edge, swaps sides, and widens again.
  const [turn] = useState(() => new Animated.Value(1));
  const busy = useRef(false);
  useEffect(() => () => turn.stopAnimation(), [turn]);
  if (!deck) return null;

  const cardIndex = state.order[state.index] ?? 0;
  const card = deck.cards[cardIndex];
  const known = state.marks.filter((m) => m === 'known').length;
  const learning = state.marks.filter((m) => m === 'learning').length;

  const flip = () => {
    if (busy.current) return;
    busy.current = true;
    Haptics.selectionAsync();
    Animated.timing(turn, { toValue: 0, duration: 110, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => {
      setState((s) => ({ ...s, flipped: !s.flipped }));
      Animated.timing(turn, { toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => {
        busy.current = false;
      });
    });
  };
  const go = (index: number) => setState((s) => ({ ...s, index, flipped: false }));
  const mark = (m: Mark) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setState((s) => {
      const marks = s.marks.map((x, i) => (i === cardIndex ? m : x));
      const last = s.index >= s.order.length - 1;
      return { ...s, marks, index: last ? s.index : s.index + 1, flipped: false, done: last };
    });
  };
  const missed = deck.cards.filter((_, i) => state.marks[i] === 'learning');

  if (state.done) {
    return (
      <StudyCard>
        {deck.title && <CardTitle>{deck.title}</CardTitle>}
        <Text style={[styles.doneTitle, { color: colors.text }]}>Deck done</Text>
        <View style={styles.tally}>
          <Tally icon="check" color={colors.success} label="Know" value={known} />
          <Tally icon="refresh-cw" color="#F59E0B" label="Still learning" value={learning} />
        </View>
        <View style={styles.actions}>
          {learning > 0 && (
            <PillButton
              title="Practise missed"
              icon="repeat"
              primary
              onPress={() => setState({ ...fresh(state.order.filter((i) => state.marks[i] === 'learning')), marks: state.marks.map((m) => (m === 'learning' ? null : m)) })}
            />
          )}
          <PillButton title="Shuffle & restart" icon="shuffle" onPress={() => setState(fresh(shuffled(count)))} />
          {followUp && (
            <PillButton
              title="Quiz me"
              icon="help-circle"
              onPress={() =>
                followUp(
                  `Quiz me on ${deck.title ? `the “${deck.title}” flashcards` : 'these flashcards'}${
                    missed.length ? `, focusing on the ones I’m still learning: ${missed.map((c) => c.front).join('; ')}` : ''
                  }.`
                )
              }
            />
          )}
        </View>
      </StudyCard>
    );
  }

  const face = state.flipped ? card.back : card.front;
  const tint = scheme === 'dark' ? '#1E1B2E' : '#F3F0FF';
  return (
    <StudyCard>
      <Pager
        index={state.index}
        count={state.order.length}
        noun="card"
        onChange={go}
        right={<IconButton icon="shuffle" label="Shuffle" onPress={() => setState(fresh(shuffled(count)))} />}
      />
      {deck.title && <CardTitle>{deck.title}</CardTitle>}
      <Pressable onPress={flip} accessibilityRole="button" accessibilityLabel={`${state.flipped ? 'Answer' : 'Card'}: ${face}. Tap to flip`}>
        <Animated.View
          style={[
            styles.face,
            { backgroundColor: state.flipped ? colors.surface : tint, transform: [{ scaleX: turn }] },
          ]}
        >
          <Text style={[styles.side, { color: colors.textTertiary }]}>{state.flipped ? 'ANSWER' : 'QUESTION'}</Text>
          <RichText style={[state.flipped ? styles.back : styles.front, { color: colors.text }]}>{face}</RichText>
          {!state.flipped && card.hint && <RichText style={[styles.hint, { color: colors.textTertiary }]}>{`Hint: ${card.hint}`}</RichText>}
          <View style={styles.flipHint}>
            <Feather name="rotate-cw" size={13} color={colors.textTertiary} />
            <Text style={{ color: colors.textTertiary, fontSize: 13 }}>Tap to flip</Text>
          </View>
        </Animated.View>
      </Pressable>
      <View style={styles.marks}>
        <PillButton title="Still learning" icon="refresh-cw" onPress={() => mark('learning')} />
        <PillButton title="Got it" icon="check" primary onPress={() => mark('known')} />
      </View>
      <View style={[styles.progress, { backgroundColor: colors.surface }]}>
        <View style={{ flex: known, backgroundColor: colors.success }} />
        <View style={{ flex: learning, backgroundColor: '#F59E0B' }} />
        <View style={{ flex: count - known - learning }} />
      </View>
    </StudyCard>
  );
}

function Tally({ icon, color, label, value }: { icon: keyof typeof Feather.glyphMap; color: string; label: string; value: number }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tallyBox, { backgroundColor: colors.surface }]}>
      <Feather name={icon} size={18} color={color} />
      <Text style={[styles.tallyValue, { color: colors.text }]}>{value}</Text>
      <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{label}</Text>
    </View>
  );
}

/** A deck of flashcards: flip each one, sort it into known or still learning, then practise the misses. */
export const Flashcards = memo(FlashcardsInner);

const styles = StyleSheet.create({
  face: { minHeight: 200, borderRadius: 18, padding: 20, marginTop: 6, justifyContent: 'center', gap: 10 },
  side: { position: 'absolute', top: 14, left: 18, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  front: { fontSize: 22, lineHeight: 30, fontWeight: '600', textAlign: 'center', marginTop: 18 },
  back: { fontSize: 17, lineHeight: 25, textAlign: 'center', marginTop: 18 },
  hint: { fontSize: 14, textAlign: 'center' },
  flipHint: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 8 },
  marks: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  progress: { flexDirection: 'row', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 14 },
  doneTitle: { fontSize: 24, fontWeight: '700', marginTop: 2 },
  tally: { flexDirection: 'row', gap: 10, marginTop: 14 },
  tallyBox: { flex: 1, borderRadius: 16, padding: 14, gap: 4 },
  tallyValue: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
});
