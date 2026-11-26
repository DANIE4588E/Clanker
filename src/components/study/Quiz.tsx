import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from '@/lib/haptics';
import { useTheme } from '@/lib/theme';
import { CardTitle, hashKey, IconButton, Pager, parseLoose, PillButton, RichText, str, StudyCard, useFollowUp, useSticky } from './shared';

/** What a ```quiz block holds, normalized from the shapes a model may write. */
export type QuizSpec = {
  title?: string;
  questions: { question: string; hint?: string; options: { text: string; explanation?: string }[]; answer: number }[];
};

const LETTERS = 'ABCDEFGHIJ';

/** Which option an answer given apart from the options names: an index, a letter, or the option's text. */
function answerIndex(answer: unknown, options: string[]) {
  if (typeof answer === 'number') return Number.isInteger(answer) && answer >= 0 && answer < options.length ? answer : -1;
  const a = str(answer);
  if (/^[A-J]$/i.test(a)) return LETTERS.indexOf(a.toUpperCase());
  if (/^\d+$/.test(a)) return Number(a) < options.length ? Number(a) : -1;
  return options.findIndex((o) => o.toLowerCase() === a.toLowerCase());
}

/** Reads a quiz block's JSON; null when it isn't a quiz this can show. */
export function parseQuiz(json: string): QuizSpec | null {
  const raw = parseLoose(json);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.questions) ? raw.questions : null;
  if (!list) return null;
  const questions: QuizSpec['questions'] = [];
  for (const q of list) {
    const question = str(q?.question ?? q?.q ?? q?.prompt ?? q?.text);
    const rawOptions = q?.options ?? q?.choices ?? q?.answers;
    if (!question || !Array.isArray(rawOptions) || rawOptions.length < 2) continue;
    const options = rawOptions.map((o: any) =>
      typeof o === 'object' && o
        ? { text: str(o.text ?? o.label ?? o.option ?? o.answer), explanation: str(o.explanation ?? o.why ?? o.rationale ?? o.feedback) || undefined }
        : { text: str(o) }
    );
    let answer = rawOptions.findIndex((o: any) => o && typeof o === 'object' && (o.correct === true || o.isCorrect === true || o.correct === 'true'));
    if (answer < 0) answer = answerIndex(q?.answer ?? q?.correct ?? q?.correctAnswer, options.map((o: { text: string }) => o.text));
    if (answer < 0 || options.some((o: { text: string }) => !o.text)) continue;
    // Explanations given apart from the options: one list, or one for the right answer.
    if (Array.isArray(q?.explanations)) options.forEach((o: any, i: number) => (o.explanation ??= str(q.explanations[i]) || undefined));
    if (str(q?.explanation) && !options[answer].explanation) options[answer].explanation = str(q.explanation);
    questions.push({ question, hint: str(q?.hint) || undefined, options: options.slice(0, LETTERS.length), answer });
  }
  if (!questions.length) return null;
  return { title: str(raw?.title) || undefined, questions };
}

type QuizState = { index: number; picks: (number | null)[]; hints: boolean[]; done: boolean };

function Results({ quiz, state, restart }: { quiz: QuizSpec; state: QuizState; restart: () => void }) {
  const { colors } = useTheme();
  const followUp = useFollowUp();
  const right = quiz.questions.filter((q, i) => state.picks[i] === q.answer).length;
  const total = quiz.questions.length;
  const missed = quiz.questions.flatMap((q, i) => (state.picks[i] !== q.answer ? [{ q, i, pick: state.picks[i] }] : []));
  const name = quiz.title ? `“${quiz.title}”` : 'the quiz';
  const verdict = right === total ? 'Perfect score!' : right / total >= 0.7 ? 'Nice work.' : right / total >= 0.4 ? 'Getting there.' : 'Keep practising.';

  const review = () => {
    const lines = missed.map(
      ({ q, i, pick }) =>
        `- Q${i + 1}: ${q.question}\n  My answer: ${pick == null ? '(skipped)' : `${LETTERS[pick]}. ${q.options[pick].text}`}\n  Correct: ${LETTERS[q.answer]}. ${q.options[q.answer].text}`
    );
    followUp?.(`I scored ${right}/${total} on ${name}. Help me understand the ones I got wrong:\n${lines.join('\n')}`);
  };

  return (
    <View>
      <Text style={[styles.score, { color: colors.text }]}>
        {right}
        <Text style={{ color: colors.textTertiary }}> / {total}</Text>
      </Text>
      <Text style={[styles.verdict, { color: colors.textSecondary }]}>{verdict}</Text>
      <View style={styles.summary}>
        {quiz.questions.map((q, i) => {
          const ok = state.picks[i] === q.answer;
          return (
            <View key={i} style={styles.summaryRow}>
              <Feather name={ok ? 'check-circle' : 'x-circle'} size={18} color={ok ? colors.success : colors.danger} />
              <Text numberOfLines={2} style={[styles.summaryText, { color: colors.textSecondary }]}>
                {q.question}
              </Text>
            </View>
          );
        })}
      </View>
      <View style={styles.actions}>
        {followUp && missed.length > 0 && <PillButton title="Review mistakes" icon="message-circle" primary onPress={review} />}
        {followUp && (
          <PillButton
            title={right === total ? 'Harder quiz' : 'New quiz'}
            icon="zap"
            primary={!missed.length}
            onPress={() =>
              followUp(
                right === total
                  ? `I got ${right}/${total} on ${name}. Give me a harder quiz on the same topic.`
                  : `I got ${right}/${total} on ${name}. Give me a new quiz on the same topic that focuses on what I got wrong.`
              )
            }
          />
        )}
        <PillButton title="Retry" icon="rotate-ccw" onPress={restart} />
      </View>
    </View>
  );
}

function QuizInner({ source }: { source: string }) {
  const { colors } = useTheme();
  const quiz = useMemo(() => parseQuiz(source), [source]);
  const count = quiz?.questions.length ?? 0;
  const fresh = (): QuizState => ({ index: 0, picks: Array(count).fill(null), hints: Array(count).fill(false), done: false });
  const [state, setState] = useSticky<QuizState>(hashKey('quiz', source), fresh);
  if (!quiz) return null;

  const q = quiz.questions[state.index];
  const pick = state.picks[state.index];
  const answered = pick != null;
  const last = state.index === count - 1;

  const choose = (i: number) => {
    if (answered) return;
    Haptics.impactAsync(i === q.answer ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Heavy);
    setState((s) => ({ ...s, picks: s.picks.map((p, j) => (j === s.index ? i : p)) }));
  };
  const go = (index: number) => setState((s) => ({ ...s, index, done: false }));
  const copy = () => {
    const text = [q.question, ...q.options.map((o, i) => `${LETTERS[i]}. ${o.text}`)].join('\n');
    void Clipboard.setStringAsync(text);
    Haptics.selectionAsync();
  };

  if (state.done) {
    return (
      <StudyCard>
        {quiz.title && <CardTitle>{quiz.title}</CardTitle>}
        <Results quiz={quiz} state={state} restart={() => setState(fresh())} />
      </StudyCard>
    );
  }

  return (
    <StudyCard>
      <Pager
        index={state.index}
        count={count}
        noun="question"
        onChange={go}
        right={
          <>
            {q.hint && (
              <IconButton
                icon="zap"
                label={state.hints[state.index] ? 'Hide hint' : 'Show hint'}
                active={state.hints[state.index]}
                onPress={() => setState((s) => ({ ...s, hints: s.hints.map((h, j) => (j === s.index ? !h : h)) }))}
              />
            )}
            <IconButton icon="copy" label="Copy question" onPress={copy} />
          </>
        }
      />
      {quiz.title && <CardTitle>{quiz.title}</CardTitle>}
      <RichText style={[styles.question, { color: colors.text }]}>{q.question}</RichText>
      {q.hint && state.hints[state.index] && (
        <View style={[styles.hint, { backgroundColor: colors.surface }]}>
          <Feather name="zap" size={15} color={colors.accentText} style={styles.hintIcon} />
          <RichText style={[styles.hintText, { color: colors.textSecondary }]}>{q.hint}</RichText>
        </View>
      )}
      <View style={styles.options}>
        {q.options.map((o, i) => {
          const isAnswer = i === q.answer;
          const picked = i === pick;
          // Once answered, the right option and a wrong pick stand out, with why; the rest fade.
          const shown = answered && (isAnswer || picked);
          const fill = shown ? (isAnswer ? '#16A34A' : '#EF4444') : undefined;
          return (
            <Pressable
              key={i}
              onPress={() => choose(i)}
              disabled={answered}
              accessibilityRole="button"
              accessibilityLabel={`${LETTERS[i]}: ${o.text}${shown ? (isAnswer ? ', correct' : ', your answer, wrong') : ''}`}
              style={({ pressed }) => [styles.option, answered && !shown && { opacity: 0.45 }, pressed && { opacity: 0.6 }]}
            >
              <View style={[styles.letter, fill ? { backgroundColor: fill, borderColor: fill } : { borderColor: colors.border }]}>
                <Text style={[styles.letterText, { color: fill ? '#FFFFFF' : colors.textSecondary }]}>{LETTERS[i]}</Text>
              </View>
              <View style={styles.optionBody}>
                <RichText style={[styles.optionText, { color: colors.text }]}>{o.text}</RichText>
                {shown && !!o.explanation && <RichText style={[styles.explanation, { color: colors.textSecondary }]}>{o.explanation}</RichText>}
              </View>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.footer}>
        {answered && (
          <PillButton
            title={last ? 'See results' : 'Next'}
            onPress={() => (last ? setState((s) => ({ ...s, done: true })) : go(state.index + 1))}
          />
        )}
        {!answered && last && state.picks.some((p) => p != null) && (
          <PillButton title="Finish" onPress={() => setState((s) => ({ ...s, done: true }))} />
        )}
      </View>
    </StudyCard>
  );
}

/** An interactive quiz: one question at a time, graded with explanations, then a score to review. */
export const Quiz = memo(QuizInner);

const styles = StyleSheet.create({
  question: { fontSize: 19, lineHeight: 28, fontWeight: '500', marginTop: 4 },
  hint: { flexDirection: 'row', gap: 8, padding: 12, borderRadius: 14, marginTop: 12 },
  hintIcon: { marginTop: 3 },
  hintText: { flex: 1, fontSize: 15, lineHeight: 22 },
  options: { marginTop: 18, gap: 6 },
  option: { flexDirection: 'row', gap: 14, paddingVertical: 8 },
  letter: { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  letterText: { fontSize: 15, fontWeight: '600' },
  optionBody: { flex: 1, paddingTop: 5, gap: 6 },
  optionText: { fontSize: 17, lineHeight: 24 },
  explanation: { fontSize: 15, lineHeight: 22 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, minHeight: 4 },
  score: { fontSize: 44, fontWeight: '700', marginTop: 4, fontVariant: ['tabular-nums'] },
  verdict: { fontSize: 16, marginTop: 2 },
  summary: { marginTop: 16, gap: 10 },
  summaryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  summaryText: { flex: 1, fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
});
