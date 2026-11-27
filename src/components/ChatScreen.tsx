import { router, useFocusEffect } from 'expo-router';
import * as Haptics from '@/lib/haptics';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AppState, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { ChatHeader } from '@/components/ChatHeader';
import { chatScreenActions } from '@/components/ChatMenu';
import { ContextMenu, type MenuAnchor } from '@/components/ContextMenu';
import { usePromptOpen } from '@/components/Dialogs';
import { FindBar } from '@/components/FindBar';
import { composerGrowth } from '@/components/Composer';
import { COMPOSER_FADE, ComposerDock } from '@/components/ComposerDock';
import { EdgeFade } from '@/components/EdgeFade';
import { EmptyState } from '@/components/EmptyState';
import { MessageList } from '@/components/MessageList';
import { ModelPicker } from '@/components/ModelPicker';
import { attachmentsForEdit, branchToNewChat, continueReply, editMessage, regenerate, stopStreaming, submitMessage } from '@/lib/chat';
import { deleteAttachment } from '@/lib/attachments';
import { brandOfBackendKind, brandOfModel, friendlyModelName } from '@/lib/modelNames';
import type { AttachmentPart } from '@/lib/providers';
import { splitQuotes, withQuotes } from '@/lib/quotes';
import { useTheme } from '@/lib/theme';
import { useContextUsage } from '@/lib/usage';
import { messageText, useChats } from '@/store/chats';
import { useProjects } from '@/store/projects';
import { useSettings } from '@/store/settings';
import { useUI } from '@/store/ui';
import { useBackends } from '@/store/backends';
import { refreshRemoteBackend, resumeRemoteChat } from '@/lib/remote/chat';
import { addAskListener } from '../../modules/clanker-selection';

// How far the header fade reaches past its controls into the conversation.
const HEADER_FADE = 16;

/** Shows Settings when sending fails for want of a model. */
export function reportSendError(e: unknown) {
  Alert.alert('No model selected', e instanceof Error ? e.message : String(e), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => router.push('/settings/providers') },
  ]);
}

/**
 * The chat on screen (store/ui currentId), or the new-chat state. The main one sits in the drawer
 * and opens it from the header; a project's chat is pushed over the project page and goes back
 * to it instead.
 */
export function ChatScreen({ onMenu, onBack, sidebarOpen }: { onMenu?: () => void; onBack?: () => void; sidebarOpen?: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const currentId = useUI((s) => s.currentId);
  const open = useUI((s) => s.open);
  useFocusEffect(useCallback(() => {
    if (!currentId || sidebarOpen || useUI.getState().currentId !== currentId) return;
    useUI.setState({ visibleChatId: currentId });
    if (AppState.currentState === 'active') useChats.getState().markRead(currentId);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && useUI.getState().currentId === currentId) {
        useChats.getState().markRead(currentId);
      }
    });
    return () => {
      listener.remove();
      useUI.setState({ visibleChatId: null });
    };
  }, [currentId, sidebarOpen]));
  // Only what this screen shows itself. MessageList reads the messages, so a streaming reply
  // re-renders the list rather than the header and composer with every token.
  const conversation = useChats(
    useShallow((s) => {
      const c = currentId ? s.conversations[currentId] : undefined;
      if (!c) return undefined;
      const last = c.messages[c.messages.length - 1];
      return {
        memory: c.memory,
        backendId: c.backendId ?? 'local',
        model: c.model,
        pendingRemote: !!c.remote?.submissionId,
        projectId: c.projectId,
        empty: c.messages.length === 0,
        streaming: c.messages.some((m) => m.status === 'streaming'),
        interrupted: !!last && last.role === 'assistant' && (last.status === 'error' || !!last.interrupted),
      };
    })
  );
  const active = useSettings((s) => s.active);
  const selectedBackend = useBackends((s) => s.selected);
  const backendId = conversation?.backendId ?? selectedBackend;
  const remote = backendId !== 'local';
  const backendName = useBackends((s) => s.remotes.find((b) => b.id === backendId)?.name ?? (backendId === 'local' ? 'Clanker' : 'Remote backend'));
  const remoteModel = useBackends((s) => s.remotes.find((b) => b.id === backendId)?.model);
  const hasEndpoint = useSettings((s) => s.endpoints.some((e) => e.models.length > 0));
  const friendly = useSettings((s) => s.friendlyModelNames);
  const showUsage = useSettings((s) => s.contextUsage);
  const usage = useContextUsage(currentId, showUsage);
  const memorySetting = useSettings((s) => s.memory);
  const backendKind = useBackends((s) => s.remotes.find((b) => b.id === backendId)?.kind);
  const newChatMemoryOff = useUI((s) => s.newChatMemoryOff);
  const memoryOff = !remote && memorySetting && (conversation ? conversation.memory === false : newChatMemoryOff);
  const newChatProjectId = useUI((s) => s.newChatProjectId);
  const projectId = conversation ? conversation.projectId : newChatProjectId;
  const projectName = useProjects((s) => (projectId ? s.projects[projectId]?.name : undefined));

  const [draft, setDraft] = useState('');
  // Text picked from the chat with "Ask Clanker", sent as quotes ahead of the next message.
  const [quotes, setQuotes] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<AttachmentPart[]>([]);
  // A message being edited in the box. What the box held before waits in `stash`, put back when
  // the edit is sent or cancelled.
  const [editing, setEditing] = useState<{
    chatId: string;
    messageId: string;
    stash: { draft: string; quotes: string[]; attachments: AttachmentPart[] };
  } | null>(null);
  const addQuote = useCallback((text: string) => setQuotes((prev) => (prev.includes(text) ? prev : [...prev, text])), []);
  // Only the screen in front takes them, with a project chat open over the main one.
  useFocusEffect(useCallback(() => addAskListener(addQuote), [addQuote]));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);
  // Bumped to put the cursor in the box, with the keyboard up, for a chat started by pulling.
  const [composerFocus, setComposerFocus] = useState(0);
  // Find in chat: the bar takes the header's place, for the chat it was opened in (another chat,
  // or a new one, closes it); `find` is what it marks in the messages and the one it shows.
  const [findIn, setFindIn] = useState<string | null>(null);
  const finding = !!currentId && findIn === currentId;
  const promptOpen = usePromptOpen();
  const [find, setFind] = useState<{ needle: string; focusId: string | null } | null>(null);
  const closeFind = useCallback(() => {
    setFindIn(null);
    setFind(null);
  }, []);
  // The conversation runs under the floating header and composer; these are their measured
  // heights (fade included) so content can rest clear of them. The composer's is measured
  // collapsed, and its growth while expanding is added on the UI thread: measuring it every
  // frame re-rendered the whole screen per frame and tanked the animation.
  const [headerHeight, setHeaderHeight] = useState(insets.top + 60 + HEADER_FADE);
  const [composerBase, setComposerBase] = useState(0);
  const composerProgress = useSharedValue(0);
  const composerSlide = useSharedValue(0);
  const topInset = headerHeight - HEADER_FADE;
  // Let the conversation use the space the composer gives up as it slides away.
  const bottomInset = useDerivedValue(() => {
    const dockInset = Math.max(composerBase + composerGrowth(composerProgress.value) - COMPOSER_FADE, 0);
    return Math.max(dockInset * (1 - composerSlide.value), finding ? insets.bottom : 0);
  });
  const emptyInsetStyle = useAnimatedStyle(() => ({ paddingBottom: bottomInset.value }));

  const streaming = !!conversation?.streaming || !!conversation?.pendingRemote;
  useEffect(() => {
    if (!remote) return;
    void refreshRemoteBackend(backendId).catch(() => {});
  }, [backendId, remote]);
  useEffect(() => {
    if (!currentId || !remote) return;
    void resumeRemoteChat(currentId);
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void resumeRemoteChat(currentId); });
    return () => listener.remove();
  }, [currentId, remote]);

  // Reopening a chat switches back to the model it was using, as ChatGPT does.
  useEffect(() => {
    const conversation = currentId ? useChats.getState().conversations[currentId] : undefined;
    if (!conversation || (conversation.backendId && conversation.backendId !== 'local')) return;
    const { endpoints, setActive } = useSettings.getState();
    const endpoint = endpoints.find((e) => e.id === conversation.endpointId);
    if (endpoint?.models.includes(conversation.model)) {
      setActive({ endpointId: endpoint.id, model: conversation.model });
    }
  }, [currentId]);

  const endEdit = useCallback(
    (sent: boolean) => {
      if (!editing) return;
      // The edit's attachments are copies of the message's (see attachmentsForEdit); unsent, they go.
      if (!sent) for (const a of attachments) if (a.file) deleteAttachment(a.file);
      setDraft(editing.stash.draft);
      setQuotes(editing.stash.quotes);
      setAttachments(editing.stash.attachments);
      setEditing(null);
    },
    [attachments, editing]
  );

  // Leaving the chat drops an edit of one of its messages.
  useEffect(() => {
    if (!editing) return;
    return useUI.subscribe((s) => {
      if (s.currentId !== editing.chatId) endEdit(false);
    });
  }, [editing, endEdit]);

  const send = useCallback(
    (text: string, sent: AttachmentPart[]) => {
      if (editing && editing.chatId === currentId) {
        try {
          editMessage(editing.chatId, editing.messageId, withQuotes(quotes, text), sent);
          endEdit(true);
        } catch (e) {
          Alert.alert('Could not edit the message', e instanceof Error ? e.message : String(e));
          // The box was emptied on send; the edit goes back in it.
          setAttachments(sent);
        }
        return;
      }
      try {
        // While a reply runs, this queues the message or steers the reply with it.
        const id = submitMessage(currentId, withQuotes(quotes, text), sent);
        if (id !== currentId) open(id);
        setDraft('');
        setQuotes([]);
      } catch (e) {
        reportSendError(e);
      }
    },
    [currentId, editing, endEdit, open, quotes]
  );

  // A new chat started from another screen (the Library's "Chat about this"), on the main screen
  // only: its files go in the box, or are sent with a question asked there.
  useEffect(() => {
    if (onBack) return;
    return useUI.subscribe((s, prev) => {
      const seed = s.seed;
      if (!seed || seed === prev.seed) return;
      useUI.setState({ seed: null });
      // After the other listeners: leaving a chat puts back the box an edit set aside.
      setTimeout(() => {
        if (seed.send) {
          try {
            useUI.getState().open(submitMessage(null, seed.text ?? '', seed.attachments));
          } catch (e) {
            setAttachments((prev) => [...prev, ...seed.attachments]);
            reportSendError(e);
          }
          return;
        }
        setAttachments((prev) => [...prev, ...seed.attachments]);
        if (seed.text) setDraft(seed.text);
        setComposerFocus((n) => n + 1);
      }, 0);
    });
  }, [onBack]);

  // What the box holds, for the message actions below: read when they run rather than closed over,
  // so typing doesn't make new callbacks and re-render every message in the list.
  const box = useRef({ draft, quotes, attachments, editing });
  useLayoutEffect(() => {
    box.current = { draft, quotes, attachments, editing };
  });

  const onEdit = useCallback(
    (messageId: string) => {
      if (!currentId || streaming) return;
      const message = useChats.getState().conversations[currentId]?.messages.find((m) => m.id === messageId);
      if (!message) return;
      const { draft, quotes, attachments, editing } = box.current;
      // Switching to another message's edit keeps what the box held before the first one.
      if (editing) for (const a of attachments) if (a.file) deleteAttachment(a.file);
      const stash = editing?.stash ?? { draft, quotes, attachments };
      const parts = splitQuotes(messageText(message));
      setEditing({ chatId: currentId, messageId, stash });
      setDraft(parts.text);
      setQuotes(parts.quotes);
      setAttachments(attachmentsForEdit(currentId, messageId));
    },
    [currentId, streaming]
  );

  const onBranch = useCallback(
    (messageId: string) => {
      if (!currentId || streaming) return;
      const messages = useChats.getState().conversations[currentId]?.messages ?? [];
      const next = messages[messages.findIndex((m) => m.id === messageId) + 1];
      const { attachments, editing } = box.current;
      // What the box held is replaced, an edit's put-aside draft included; unsent, its files go.
      const dropped = [...attachments, ...(editing?.stash.attachments ?? [])];
      try {
        open(branchToNewChat(currentId, messageId));
      } catch (e) {
        Alert.alert('Could not branch the chat', e instanceof Error ? e.message : String(e));
        return;
      }
      // The prompt that followed the reply waits in the box of the new chat, to be changed and sent.
      // Set after `open`, so it wins over an edit being put away on leaving the chat.
      if (next?.role !== 'user') return;
      for (const a of dropped) if (a.file) deleteAttachment(a.file);
      const parts = splitQuotes(messageText(next));
      setDraft(parts.text);
      setQuotes(parts.quotes);
      setAttachments(attachmentsForEdit(currentId, next.id));
    },
    [currentId, open, streaming]
  );

  const onRegenerate = useCallback(
    (messageId: string) => {
      if (currentId && !streaming) regenerate(currentId, messageId);
    },
    [currentId, streaming]
  );

  const canContinue = !remote && !streaming && !!conversation?.interrupted && !!currentId;
  const onContinue = useCallback(() => {
    if (!currentId || streaming) return;
    try {
      continueReply(currentId);
    } catch (e) {
      reportSendError(e);
    }
  }, [currentId, streaming]);

  const newChat = useCallback(() => {
    const projectId = currentId ? useChats.getState().conversations[currentId]?.projectId : undefined;
    if (projectId) useUI.getState().openNewInProject(projectId);
    else open(null);
  }, [currentId, open]);

  // Pulling the finished chat up past its end starts a new one, ready to type in, as in ChatGPT.
  const pullNewChat = useCallback(() => {
    newChat();
    setComposerFocus((n) => n + 1);
  }, [newChat]);

  // The chat's menu, built when it opens so it shows the chat as it is then (pinned, archived).
  const menuChat = menuAnchor && currentId ? useChats.getState().conversations[currentId] : undefined;
  const menuItems = menuChat
    ? chatScreenActions(menuChat, {
        onNewChat: newChat,
        onFind: () => setFindIn(currentId),
        // An archived or deleted chat leaves the screen: back to the project, or to a new chat.
        onLeave: onBack ?? (() => open(null)),
      })
    : [];

  // The header title: raw ids, or with friendly names the brand mark plus a tidied model name.
  // A remote chat carries its backend's mark (Hermes / DeepSeek Harness); local ones carry none.
  const rawTitle = remote ? (conversation?.model ?? remoteModel ?? backendName) : (active?.model ?? 'Clanker');
  const title = friendly && rawTitle !== 'Clanker' && rawTitle !== backendName ? friendlyModelName(rawTitle) || rawTitle : rawTitle;
  const titleBrand = friendly ? (remote ? (backendKind ? brandOfBackendKind(backendKind) : undefined) : active ? brandOfModel(active.model) : undefined) : undefined;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* With KeyboardProvider mounted the Android window no longer resizes for the keyboard,
          so both platforms pad from the keyboard height. */}
      <KeyboardAvoidingView style={styles.container} behavior="padding">
        {/* An unpadded box, so the composer's absolute position isn't thrown off by the
            avoiding view's keyboard padding. */}
        <View style={styles.container}>
          {currentId && conversation && !conversation.empty ? (
            <MessageList
              conversationId={currentId}
              onRegenerate={remote ? undefined : onRegenerate}
              onEdit={remote ? undefined : onEdit}
              onBranch={remote ? undefined : onBranch}
              busy={streaming}
              topInset={topInset}
              bottomInset={bottomInset}
              find={finding ? find : null}
              onPullNewChat={streaming || finding ? undefined : pullNewChat}
            />
          ) : (
            <Animated.View style={[styles.container, { paddingTop: topInset }, emptyInsetStyle]}>
              <EmptyState
                hasEndpoint={remote ? !!remoteModel : hasEndpoint}
                remote={remote ? backendName : undefined}
                remoteBrand={remote && friendly && backendKind ? brandOfBackendKind(backendKind) : undefined}
                memoryOff={memoryOff}
                project={projectName}
                onSuggestion={setDraft}
                onAddEndpoint={() =>
                  router.push(remote ? { pathname: '/settings/backend', params: { id: backendId } } : '/settings/endpoint')
                }
                onAddSubscription={!remote ? () => router.push('/settings/subscription') : undefined}
              />
            </Animated.View>
          )}
          <ComposerDock
            conversationId={currentId}
            draft={draft}
            onChangeDraft={setDraft}
            quotes={quotes}
            onChangeQuotes={setQuotes}
            streaming={streaming}
            onSend={send}
            onStop={() => currentId && stopStreaming(currentId)}
            onContinue={canContinue ? onContinue : undefined}
            usage={usage}
            progress={composerProgress}
            slideProgress={composerSlide}
            onBaseHeight={setComposerBase}
            attachments={attachments}
            onChangeAttachments={setAttachments}
            editing={!!editing && editing.chatId === currentId}
            onCancelEdit={() => endEdit(false)}
            // Text dialogs and Find take over before their input gets the keyboard.
            hidden={finding || promptOpen}
            focusKey={composerFocus}
          />
        </View>
      </KeyboardAvoidingView>

      {/* Floats over the top of the list, fading what scrolls beneath it, as in ChatGPT. */}
      <View
        pointerEvents="box-none"
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
        style={styles.headerArea}
      >
        <EdgeFade solid="top" style={StyleSheet.absoluteFill} />
        {finding ? (
          <FindBar conversationId={currentId} onClose={closeFind} onChange={setFind} />
        ) : (
          <ChatHeader
            title={title}
            onMenu={onMenu}
            onBack={onBack}
            onTitle={() => setPickerOpen(true)}
            backend={remote ? backendName : undefined}
            brand={titleBrand}
            onMore={
              currentId
                ? (anchor) => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setMenuAnchor(anchor);
                  }
                : undefined
            }
            memoryOff={memoryOff}
            onToggleMemory={
              !currentId && memorySetting && !remote ? () => useUI.getState().setNewChatMemoryOff(!newChatMemoryOff) : undefined
            }
          />
        )}
      </View>

      <ContextMenu anchor={menuAnchor} items={menuItems} onClose={() => setMenuAnchor(null)} />

      <ModelPicker visible={pickerOpen} onClose={() => setPickerOpen(false)} conversationId={currentId} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerArea: { position: 'absolute', top: 0, left: 0, right: 0, paddingBottom: HEADER_FADE },
});
