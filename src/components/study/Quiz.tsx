import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from '@/lib/haptics';
import { gradeQuizAnswer, type QuizGrade } from '@/lib/quizGrading';
import { useTheme } from '@/lib/theme';
import { CardTitle, hashKey, IconButton, Pager, parseLoose, PillButton, RichText, str, StudyCard, useFollowUp, useSticky, useStudyReply } from './shared';
import { useTextSelection } from '../SelectionArea';

type Question = { question: string; hint?: string } & (
  | { type: 'multiple-choice'; options: { text: string; explanation?: string }[]; answer: number }
  | { type: 'open-ended'; referenceAnswer: string }
);

/** What a ```quiz block holds, normalized from the shapes a model may write. */
export type QuizSpec = {
  title?: string;
  questions: Question[];
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
    if (!question) continue;
    const hint = str(q?.hint) || undefined;
    if (q?.type === 'open-ended') {
      const referenceAnswer = str(q.referenceAnswer ?? q.correctAnswer ?? q.answer);
      if (referenceAnswer) questions.push({ type: 'open-ended', question, hint, referenceAnswer });
      continue;
    }
    const choices = q?.options ?? q?.choices ?? q?.answers;
    if (!Array.isArray(choices) || choices.length < 2) continue;
    const rawOptions = choices.slice(0, LETTERS.length);
    const options: { text: string; explanation?: string }[] = rawOptions.map((o) =>
      typeof o === 'object' && o
        ? { text: str(o.text ?? o.label ?? o.option ?? o.answer), explanation: str(o.explanation ?? o.why ?? o.rationale ?? o.feedback) || undefined }
        : { text: str(o) }
    );
    let answer = rawOptions.findIndex((o) => o && typeof o === 'object' && (o.correct === true || o.isCorrect === true || o.correct === 'true'));
    if (answer < 0) answer = answerIndex(q?.answer ?? q?.correct ?? q?.correctAnswer, options.map((o) => o.text));
    if (answer < 0 || answer >= options.length || options.some((o) => !o.text)) continue;
    // Explanations given apart from the options: one list, or one for the right answer.
    if (Array.isArray(q?.explanations)) options.forEach((o, i) => (o.explanation ??= str(q.explanations[i]) || undefined));
    if (str(q?.explanation) && !options[answer].explanation) options[answer].explanation = str(q.explanation);
    questions.push({ type: 'multiple-choice', question, hint, options, answer });
  }
  if (!questions.length) return null;
  return { title: str(raw?.title) || undefined, questions };
}

type WrittenResponse = { answer: string; grade: QuizGrade };
type QuizResponse = number | WrittenResponse | null;
type QuizState = { index: number; responses: QuizResponse[]; drafts: string[]; hints: boolean[]; done: boolean };

function isCorrect(question: Question, response: QuizResponse) {
  if (typeof response === 'number') return question.type === 'multiple-choice' && response === question.answer;
  return !!response?.grade.correct;
}

function Results({ quiz, state, restart }: { quiz: QuizSpec; state: QuizState; restart: () => void }) {
  const { colors } = useTheme();
  const followUp = useFollowUp();
  const total = quiz.questions.length;
  const missed = quiz.questions.flatMap((q, i) => {
    const response = state.responses[i];
    return isCorrect(q, response) ? [] : [{ q, i, response }];
  });
  const right = total - missed.length;
  const name = quiz.title ? `“${quiz.title}”` : 'the quiz';
  const verdict = right === total ? 'Perfect score!' : right / total >= 0.7 ? 'Nice work.' : right / total >= 0.4 ? 'Getting there.' : 'Keep practising.';

  const review = () => {
    const lines = missed.flatMap(({ q, i, response }) => {
      const heading = `- Q${i + 1}: ${q.question}`;
      if (q.type === 'multiple-choice' && typeof response === 'number') {
        return [`${heading}\n  My answer: ${LETTERS[response]}. ${q.options[response].text}\n  Correct: ${LETTERS[q.answer]}. ${q.options[q.answer].text}`];
      }
      if (typeof response === 'object' && response && !response.grade.correct) {
        return [`${heading}\n  My answer: ${response.answer}\n  Suggested answer: ${response.grade.suggestedAnswer}`];
      }
      return [];
    });
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
          const ok = isCorrect(q, state.responses[i]);
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

function QuizCard({ quiz, progressKey, conversationId }: { quiz: QuizSpec; progressKey: string; conversationId?: string }) {
  const { colors } = useTheme();
  const textSelects = useTextSelection();
  const count = quiz.questions.length;
  const fresh = (): QuizState => ({
    index: 0, responses: Array(count).fill(null), drafts: Array(count).fill(''), hints: Array(count).fill(false), done: false,
  });
  const [state, setState] = useSticky<QuizState>(progressKey, fresh);
  const request = useRef<AbortController | null>(null);
  const [gradingIndex, setGradingIndex] = useState<number | null>(null);
  const [gradingError, setGradingError] = useState<{ index: number; message: string } | null>(null);
  useEffect(() => () => {
    const controller = request.current;
    request.current = null;
    controller?.abort();
  }, []);

  const { index } = state;
  const q = quiz.questions[index];
  const response = state.responses[index];
  const answered = response != null;
  const draft = state.drafts[index];
  const firstUnanswered = state.responses.indexOf(null);
  const complete = firstUnanswered === -1;
  const last = index === count - 1;

  const record = (answer: NonNullable<QuizResponse>, correct: boolean) => {
    void Haptics.impactAsync(correct ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Heavy);
    setState((s) => s.responses[index] != null ? s : {
      ...s,
      responses: s.responses.map((r, i) => (i === index ? answer : r)),
    });
  };

  const choose = (i: number) => {
    if (!answered && q.type === 'multiple-choice') record(i, i === q.answer);
  };
  const submit = async () => {
    const answer = draft.trim();
    if (answered || !answer || request.current || q.type !== 'open-ended') return;
    const controller = new AbortController();
    request.current = controller;
    setGradingError(null);
    setGradingIndex(index);
    Keyboard.dismiss();

    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const grade = await gradeQuizAnswer(conversationId, q, answer, controller.signal);
      if (controller.signal.aborted) throw new Error('Grading was cancelled.');
      if (request.current === controller) record({ answer, grade }, grade.correct);
    } catch (error) {
      if (request.current === controller) {
        const message = controller.signal.aborted
          ? 'Grading timed out. Try submitting again.'
          : error instanceof Error ? error.message : 'Couldn’t grade your answer. Try submitting again.';
        setGradingError({ index, message });
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setGradingIndex(null);
      }
    }
  };
  const go = (index: number) => setState((s) => ({ ...s, index, done: false }));
  const copy = () => {
    const text = q.type === 'open-ended'
      ? q.question
      : [q.question, ...q.options.map((o, i) => `${LETTERS[i]}. ${o.text}`)].join('\n');
    void Clipboard.setStringAsync(text);
    Haptics.selectionAsync();
  };

  if (state.done && complete) {
    return (
      <StudyCard>
        {quiz.title && <CardTitle>{quiz.title}</CardTitle>}
        <Results quiz={quiz} state={state} restart={() => { setGradingError(null); setState(fresh()); }} />
      </StudyCard>
    );
  }

  const hintShown = state.hints[index];
  return (
    <StudyCard>
      <Pager
        index={index}
        count={count}
        noun="question"
        onChange={go}
        right={
          <>
            {q.hint && (
              <IconButton
                icon="zap"
                label={hintShown ? 'Hide hint' : 'Show hint'}
                active={hintShown}
                onPress={() => setState((s) => ({ ...s, hints: s.hints.map((h, j) => (j === index ? !h : h)) }))}
              />
            )}
            <IconButton icon="copy" label="Copy question" onPress={copy} />
          </>
        }
      />
      {quiz.title && <CardTitle>{quiz.title}</CardTitle>}
      <RichText style={[styles.question, { color: colors.text }]}>{q.question}</RichText>
      {q.hint && hintShown && (
        <View style={[styles.hint, { backgroundColor: colors.surface }]}>
          <Feather name="zap" size={15} color={colors.accentText} style={styles.hintIcon} />
          <RichText style={[styles.hintText, { color: colors.textSecondary }]}>{q.hint}</RichText>
        </View>
      )}
      {q.type === 'multiple-choice' ? (
        <View style={styles.options}>
          {q.options.map((o, i) => {
            const isAnswer = i === q.answer;
            const picked = i === response;
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
      ) : (
        <View style={styles.written}>
          {typeof response === 'object' && response ? (
            <>
              <Text accessibilityLiveRegion="polite" style={[styles.feedback, { color: response.grade.correct ? colors.success : colors.danger }]}>
                {response.grade.correct ? 'Correct' : 'Incorrect'}
              </Text>
              <Text selectable={textSelects} style={[styles.explanation, { color: colors.text }]}>
                {response.answer}
              </Text>
              {!response.grade.correct && (
                <View style={styles.suggestion}>
                  <Text style={[styles.feedback, { color: colors.text }]}>Suggested answer</Text>
                  <RichText style={[styles.explanation, { color: colors.textSecondary }]}>{response.grade.suggestedAnswer}</RichText>
                </View>
              )}
            </>
          ) : (
            <>
              <TextInput
                key={index}
                accessibilityLabel="Your answer"
                placeholder="Write your answer"
                placeholderTextColor={colors.textTertiary}
                multiline
                editable={gradingIndex !== index}
                value={draft}
                onChangeText={(value) => setState((s) => ({ ...s, drafts: s.drafts.map((d, i) => (i === index ? value : d)) }))}
                style={[styles.input, { color: colors.text, borderColor: colors.border }]}
              />
              {gradingError?.index === index && (
                <Text accessibilityLiveRegion="polite" style={[styles.explanation, { color: colors.danger }]}>{gradingError.message}</Text>
              )}
            </>
          )}
        </View>
      )}
      <View style={styles.footer}>
        {!answered && q.type === 'open-ended' && (
          <PillButton
            title={gradingIndex === index ? 'Grading…' : 'Submit'}
            primary
            disabled={gradingIndex !== null || !draft.trim()}
            onPress={() => void submit()}
          />
        )}
        {complete ? (
          <PillButton title="See results" onPress={() => setState((s) => ({ ...s, done: true }))} />
        ) : answered && (
          <PillButton
            title={last ? 'Next unanswered' : 'Next'}
            onPress={() => go(last ? firstUnanswered : index + 1)}
          />
        )}
      </View>
    </StudyCard>
  );
}

function QuizInner({ source }: { source: string }) {
  const quiz = useMemo(() => parseQuiz(source), [source]);
  const reply = useStudyReply();
  const key = hashKey(`quiz:${reply?.conversationId ?? ''}:${reply?.messageId ?? ''}`, source);
  return quiz ? <QuizCard key={key} quiz={quiz} progressKey={key} conversationId={reply?.conversationId} /> : null;
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
  written: { marginTop: 18, gap: 8 },
  input: { borderRadius: 10, borderWidth: 1, minHeight: 92, maxHeight: 200, padding: 12, fontSize: 16, textAlignVertical: 'top' },
  feedback: { fontSize: 15, fontWeight: '600' },
  suggestion: { gap: 4, marginTop: 4 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, minHeight: 4 },
  score: { fontSize: 44, fontWeight: '700', marginTop: 4, fontVariant: ['tabular-nums'] },
  verdict: { fontSize: 16, marginTop: 2 },
  summary: { marginTop: 16, gap: 10 },
  summaryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  summaryText: { flex: 1, fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
});
