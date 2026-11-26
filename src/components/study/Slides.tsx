import { memo, useMemo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useTheme } from '@/lib/theme';
import { REPLY_GUTTER } from '../Chart';
import { hashKey, IconButton, Pager, parseLoose, PillButton, RichText, str, StudyCard, useFollowUp, useSticky } from './shared';

/** What a ```slides block holds, normalized from the shapes a model may write. */
export type SlidesSpec = {
  title?: string;
  slides: { title: string; subtitle?: string; bullets: string[]; body?: string; notes?: string }[];
};

/** Reads a slides block's JSON; null when it isn't a deck this can show. */
export function parseSlides(json: string): SlidesSpec | null {
  const raw = parseLoose(json);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.slides) ? raw.slides : null;
  if (!list) return null;
  const slides = list.flatMap((s: any) => {
    const title = str(s?.title ?? s?.heading);
    const bulletsRaw = s?.bullets ?? s?.points ?? s?.items;
    const bullets = Array.isArray(bulletsRaw) ? bulletsRaw.map(str).filter(Boolean) : [];
    const body = str(s?.body ?? s?.content ?? s?.text) || undefined;
    if (!title && !bullets.length && !body) return [];
    return [{ title, subtitle: str(s?.subtitle) || undefined, bullets, body, notes: str(s?.notes ?? s?.speakerNotes) || undefined }];
  });
  return slides.length ? { title: str(raw?.title) || undefined, slides } : null;
}

// The deck's accent, a cool violet that reads on both themes.
const ACCENT = '#7C5CFA';

function SlidesInner({ source }: { source: string }) {
  const { colors, scheme } = useTheme();
  const { width } = useWindowDimensions();
  const followUp = useFollowUp();
  const deck = useMemo(() => parseSlides(source), [source]);
  const [state, setState] = useSticky(hashKey('slides', source), () => ({ index: 0, notes: false }));
  if (!deck) return null;

  const count = deck.slides.length;
  const index = Math.min(state.index, count - 1);
  const slide = deck.slides[index];
  // Every slide is at least 3:4 of the card's width, so paging doesn't jump about for short ones.
  const minHeight = Math.round((width - REPLY_GUTTER - 32) * 0.75);
  const cover = !slide.bullets.length && !slide.body;
  const surface = scheme === 'dark' ? '#17161D' : '#FAF9FF';

  return (
    <StudyCard>
      <Pager
        index={index}
        count={count}
        noun="slide"
        onChange={(i) => setState((s) => ({ ...s, index: i }))}
        right={
          deck.slides.some((s) => s.notes) && (
            <IconButton
              icon="file-text"
              label={state.notes ? 'Hide speaker notes' : 'Show speaker notes'}
              active={state.notes}
              onPress={() => setState((s) => ({ ...s, notes: !s.notes }))}
            />
          )
        }
      />
      <View style={[styles.slide, { minHeight, backgroundColor: surface, borderColor: colors.border }, cover && styles.cover]}>
        <View style={[styles.bar, { backgroundColor: ACCENT }]} />
        {cover ? (
          <>
            <RichText style={[styles.coverTitle, { color: colors.text }]}>{slide.title}</RichText>
            {slide.subtitle && <RichText style={[styles.coverSubtitle, { color: colors.textSecondary }]}>{slide.subtitle}</RichText>}
          </>
        ) : (
          <>
            {!!slide.title && <RichText style={[styles.title, { color: colors.text }]}>{slide.title}</RichText>}
            {slide.subtitle && <RichText style={[styles.subtitle, { color: colors.textSecondary }]}>{slide.subtitle}</RichText>}
            {slide.body && <RichText style={[styles.body, { color: colors.text }]}>{slide.body}</RichText>}
            {slide.bullets.length > 0 && (
              <View style={styles.bullets}>
                {slide.bullets.map((b, i) => (
                  <View key={i} style={styles.bulletRow}>
                    <View style={[styles.dot, { backgroundColor: ACCENT }]} />
                    <RichText style={[styles.bullet, { color: colors.text }]}>{b}</RichText>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
        <View style={styles.foot}>
          <Text numberOfLines={1} style={[styles.footText, { color: colors.textTertiary }]}>
            {deck.title ?? ''}
          </Text>
          <Text style={[styles.footText, { color: colors.textTertiary }]}>{index + 1}</Text>
        </View>
      </View>
      {state.notes && (
        <View style={[styles.notes, { backgroundColor: colors.surface }]}>
          <Text style={[styles.notesLabel, { color: colors.textTertiary }]}>SPEAKER NOTES</Text>
          <RichText style={[styles.notesText, { color: colors.textSecondary }]}>{slide.notes ?? 'No notes for this slide.'}</RichText>
        </View>
      )}
      {followUp && index === count - 1 && (
        <View style={styles.actions}>
          <PillButton
            title="Save as PowerPoint"
            icon="download"
            onPress={() => followUp(`Make the ${deck.title ? `“${deck.title}” ` : ''}slides into a PowerPoint (.pptx) file I can download.`)}
          />
          <PillButton title="Quiz me" icon="help-circle" onPress={() => followUp(`Quiz me on the ${deck.title ? `“${deck.title}” ` : ''}slides.`)} />
        </View>
      )}
    </StudyCard>
  );
}

/** A slide deck drawn in the chat, a slide at a time, with speaker notes. */
export const Slides = memo(SlidesInner);

const styles = StyleSheet.create({
  slide: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 20, paddingTop: 22, paddingBottom: 40, overflow: 'hidden' },
  cover: { justifyContent: 'center' },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 5 },
  coverTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  coverSubtitle: { fontSize: 17, lineHeight: 24, marginTop: 10 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  subtitle: { fontSize: 15, lineHeight: 21, marginTop: 4 },
  body: { fontSize: 16, lineHeight: 24, marginTop: 14 },
  bullets: { marginTop: 14, gap: 10 },
  bulletRow: { flexDirection: 'row', gap: 12 },
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: 9 },
  bullet: { flex: 1, fontSize: 16, lineHeight: 24 },
  foot: { position: 'absolute', left: 20, right: 16, bottom: 12, flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  footText: { fontSize: 12, flexShrink: 1 },
  notes: { borderRadius: 14, padding: 12, marginTop: 10, gap: 4 },
  notesLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  notesText: { fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
});
