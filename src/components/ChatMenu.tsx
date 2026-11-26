import * as Haptics from '@/lib/haptics';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { stopStreaming } from '@/lib/chat';
import { shareChat } from '@/lib/chatExport';
import { moveChatToProject } from '@/lib/projects';
import { useChats, type Conversation } from '@/store/chats';
import { useProjects } from '@/store/projects';
import { useUI } from '@/store/ui';
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu';
import { choose, confirm, notify, prompt, type Choice } from './Dialogs';

function move(c: Conversation, projectId: string | null) {
  try {
    const renamed = moveChatToProject(c.id, projectId);
    if (renamed.length) {
      notify(
        'Some files were renamed',
        `These names were taken where the chat moved to:\n${renamed.map(([a, b]) => `${a} → ${b}`).join('\n')}`
      );
    }
  } catch (e) {
    notify('Could not move the chat', e instanceof Error ? e.message : String(e));
  }
}

/** Picks the project to move a chat to: an existing one, a new one, or none. */
function chooseProject(c: Conversation) {
  const projects = Object.values(useProjects.getState().projects).sort(
    (a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || a.name.localeCompare(b.name)
  );
  const choices: Choice[] = [
    ...projects.map(
      (p): Choice => ({
        label: p.name,
        icon: { feather: 'folder' },
        selected: p.id === c.projectId,
        onPress: () => move(c, p.id),
      })
    ),
    {
      label: 'New project',
      icon: { feather: 'folder-plus' },
      onPress: () =>
        prompt({
          title: 'New project',
          placeholder: 'Project name',
          confirmLabel: 'Create',
          maxLength: 80,
          onSubmit: (name) => move(c, useProjects.getState().create(name)),
        }),
    },
    ...(c.projectId
      ? [{ label: 'Remove from project', icon: { feather: 'x-circle' as const }, onPress: () => move(c, null) }]
      : []),
  ];
  choose({
    title: c.projectId ? 'Move to project' : 'Add to project',
    message: c.projectId
      ? 'It takes copies of the files it used along, and starts using the new place for files and memory.'
      : 'Its files move along, and it shares the project’s workspace, sources, instructions and memory from then on.',
    choices,
  });
}

export function confirmDeleteChat(c: Conversation, after?: () => void) {
  confirm({
    title: 'Delete chat?',
    message: `"${c.title}"${c.projectId || c.workspace ? '' : ' and its files'} will be deleted. This can't be undone.`,
    confirmLabel: 'Delete',
    destructive: true,
    onConfirm: () => {
      stopStreaming(c.id);
      useChats.getState().remove(c.id);
      if (useUI.getState().currentId === c.id) useUI.getState().open(null);
      after?.();
    },
  });
}

const pinAction = (c: Conversation): MenuItem => ({
  label: c.pinnedAt ? 'Unpin' : 'Pin',
  icon: { mci: c.pinnedAt ? 'pin-off-outline' : 'pin-outline' },
  onPress: () => useChats.getState().setPinned(c.id, !c.pinnedAt),
});

const projectAction = (c: Conversation, more?: boolean): MenuItem => ({
  label: c.projectId ? 'Move to project' : 'Add to project',
  icon: { feather: 'folder-plus' },
  more,
  onPress: () => chooseProject(c),
});

/** `after` runs once the chat is archived, to leave it when it is the one on screen. */
const archiveAction = (c: Conversation, after?: () => void): MenuItem =>
  c.archivedAt
    ? { label: 'Unarchive', icon: { feather: 'archive' }, onPress: () => useChats.getState().setArchived(c.id, false) }
    : {
        label: 'Archive',
        icon: { feather: 'archive' },
        onPress: () =>
          confirm({
            title: 'Archive chat?',
            message: `"${c.title}" will be hidden from your chats. To see archived chats again, turn on Show archived chats in Settings.`,
            confirmLabel: 'Archive',
            onConfirm: () => {
              useChats.getState().setArchived(c.id, true);
              after?.();
            },
          }),
      };

const deleteAction = (c: Conversation, after?: () => void): MenuItem => ({
  label: 'Delete',
  icon: { feather: 'trash-2' },
  destructive: true,
  onPress: () => confirmDeleteChat(c, after),
});

/** The actions on a chat, for its long-press menu. */
export function chatActions(c: Conversation): MenuItem[] {
  return [
    pinAction(c),
    {
      label: 'Rename',
      icon: { feather: 'edit-2' },
      onPress: () =>
        prompt({
          title: 'Rename chat',
          initial: c.title,
          confirmLabel: 'Save',
          maxLength: 100,
          onSubmit: (title) => useChats.getState().rename(c.id, title),
        }),
    },
    projectAction(c),
    archiveAction(c),
    deleteAction(c),
  ];
}

/**
 * The menu behind the dots in the header of the chat on screen. `onLeave` takes the screen off the
 * chat once it is archived or deleted; `onFind` opens the find bar.
 */
export function chatScreenActions(
  c: Conversation,
  { onNewChat, onFind, onLeave }: { onNewChat: () => void; onFind: () => void; onLeave: () => void }
): MenuItem[] {
  return [
    { label: 'New chat', icon: { feather: 'edit' }, onPress: onNewChat },
    {
      label: 'Share',
      icon: { feather: 'share' },
      onPress: () => {
        // Read again: the chat may have moved on since the menu opened.
        const latest = useChats.getState().conversations[c.id] ?? c;
        shareChat(latest).catch((e) => notify('Could not share the chat', e instanceof Error ? e.message : String(e)));
      },
    },
    pinAction(c),
    projectAction(c, true),
    {
      label: 'Uploaded files',
      icon: { feather: 'paperclip' },
      onPress: () => router.push({ pathname: '/chats/files', params: { id: c.id } }),
    },
    { label: 'Find in chat', icon: { feather: 'search' }, onPress: onFind },
    archiveAction(c, onLeave),
    deleteAction(c, onLeave),
  ];
}

/** A chat's popup menu. `show` opens it at the point pressed; render `menu` once on the screen. */
export function useChatMenu() {
  const [state, setState] = useState<{ chat: Conversation; anchor: MenuAnchor } | null>(null);
  const show = useCallback((chat: Conversation, anchor: MenuAnchor) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setState({ chat, anchor });
  }, []);
  const menu = (
    <ContextMenu anchor={state?.anchor ?? null} items={state ? chatActions(state.chat) : []} onClose={() => setState(null)} />
  );
  return { show, menu };
}
