import { router } from 'expo-router';
import { Platform } from 'react-native';
import * as Haptics from '@/lib/haptics';
import { attachmentFor, openItemExternally, saveItem, shareItem, type LibraryItem } from '@/lib/library';
import { useChats } from '@/store/chats';
import { useLibrary } from '@/store/library';
import { useUI } from '@/store/ui';
import type { MenuItem } from './ContextMenu';
import { notify } from './Dialogs';
import { openProjectChat } from './ProjectMenu';

export function reportLibraryError(e: unknown) {
  notify('Something went wrong', e instanceof Error ? e.message : String(e));
}

/**
 * Starts a new chat on the main screen with the file attached: left in the box to add a message
 * to, or sent at once with `question`.
 */
export async function chatAbout(item: LibraryItem, question?: string) {
  try {
    const part = await attachmentFor(item);
    useUI.getState().startWith({ attachments: [part], text: question, send: !!question });
    router.dismissTo('/');
  } catch (e) {
    reportLibraryError(e);
  }
}

/** Opens the chat the file came from. */
export function viewChat(item: LibraryItem) {
  if (!useChats.getState().conversations[item.chatId]) return notify('That chat was deleted');
  if (item.projectId) return openProjectChat(item.projectId, item.chatId);
  useUI.getState().open(item.chatId);
  router.dismissTo('/');
}

export function toggleFavorite(item: LibraryItem) {
  const { favorites, setFavorite } = useLibrary.getState();
  void Haptics.selectionAsync();
  setFavorite([item.key], !favorites[item.key]);
}

/** Moves the file to Deleted, where it can be restored. */
export function removeFromLibrary(items: LibraryItem[]) {
  void Haptics.selectionAsync();
  useLibrary.getState().remove(items.map((i) => i.key));
}

export const saveLabel = Platform.OS === 'ios' ? 'Save to Files' : 'Save to device';

export function save(item: LibraryItem) {
  saveItem(item)
    .then((saved) => {
      if (saved && Platform.OS === 'android') notify('Saved', `"${item.name}" was saved to the folder you picked.`);
    })
    .catch(reportLibraryError);
}

/** The long-press menu on a file in the Library. */
export function libraryItemActions(item: LibraryItem): MenuItem[] {
  const favorite = !!useLibrary.getState().favorites[item.key];
  return [
    { label: saveLabel, icon: { feather: 'download' }, onPress: () => save(item) },
    { label: 'Chat about this', icon: { feather: 'message-circle' }, onPress: () => void chatAbout(item) },
    { label: 'Share', icon: { feather: 'share-2' }, onPress: () => shareItem(item).catch(reportLibraryError) },
    {
      label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: { mci: favorite ? 'bookmark-remove-outline' : 'bookmark-outline' },
      onPress: () => toggleFavorite(item),
    },
    { label: 'Delete from Library', icon: { feather: 'trash-2' }, destructive: true, onPress: () => removeFromLibrary([item]) },
  ];
}

/** The menu on a file's preview. */
export function previewActions(item: LibraryItem, onRemoved: () => void): MenuItem[] {
  const favorite = !!useLibrary.getState().favorites[item.key];
  return [
    { label: 'Share', icon: { feather: 'share-2' }, onPress: () => shareItem(item).catch(reportLibraryError) },
    { label: saveLabel, icon: { feather: 'download' }, onPress: () => save(item) },
    { label: 'Open with…', icon: { feather: 'external-link' }, onPress: () => openItemExternally(item).catch(reportLibraryError) },
    { label: 'View chat', icon: { feather: 'message-circle' }, onPress: () => viewChat(item) },
    {
      label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: { mci: favorite ? 'bookmark-remove-outline' : 'bookmark-outline' },
      onPress: () => toggleFavorite(item),
    },
    {
      label: 'Delete from Library',
      icon: { feather: 'trash-2' },
      destructive: true,
      onPress: () => {
        removeFromLibrary([item]);
        onRemoved();
      },
    },
  ];
}
