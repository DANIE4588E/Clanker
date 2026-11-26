import { create } from 'zustand';

/**
 * /compact: the model summarises the chat so far, and the summary takes the place of that history
 * from the next turn on (see compactChat in lib/chat and compactHistory in lib/context). The
 * messages themselves stay on screen; only what is sent to the model changes.
 */

/** What is happening with a chat's /compact, while it runs or after it failed; not kept across launches. */
export type Compaction = { status: 'running'; startedAt: number } | { status: 'error'; error: string };

export const useCompaction = create<Record<string, Compaction | undefined>>(() => ({}));

export function setCompaction(conversationId: string, compaction: Compaction | undefined) {
  useCompaction.setState({ [conversationId]: compaction });
}

/** Clears a failed /compact's message, as sending something else does. */
export function dismissCompactionError(conversationId: string) {
  if (useCompaction.getState()[conversationId]?.status === 'error') setCompaction(conversationId, undefined);
}

/** The request added to the end of the history for the model to write the summary. */
export function compactRequest(focus: string) {
  return (
    '[The user ran /compact. Everything in this conversation so far is about to be replaced by the summary you write now, ' +
    'to free up context, and you will carry on from that summary alone. Make no tool calls; reply with the summary only, ' +
    'in Markdown, with no preamble. Cover:\n' +
    "1. The user's requests and intent, in order, and every instruction, preference or correction they gave. Quote their " +
    'own words where the wording matters.\n' +
    '2. What was done: files read, created or changed (with their paths), commands and tools run and what came of them, ' +
    'and the findings and decisions made, with the reasons for them.\n' +
    '3. Specifics to keep exactly: names, paths, URLs, numbers, settings, short snippets of code, error messages.\n' +
    "4. Problems met and how they were solved, and approaches tried that didn't work.\n" +
    '5. Where things stand: what is finished, what is in progress, open questions, and the next step if one was planned.\n' +
    'Be thorough about what is still needed and brief about what is settled.' +
    (focus ? `\n\nThe user asked the summary to focus on: ${focus}` : '') +
    ']'
  );
}
