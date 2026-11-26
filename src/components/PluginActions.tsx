import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import * as Haptics from '@/lib/haptics';
import { canInstallSilently, disconnectProvider, needsClientSetup, signInKind, signInWithBrowser } from '@/lib/plugins/auth';
import { pluginGranted, PLUGINS, type PluginDef } from '@/lib/plugins/catalog';
import { connectMcp } from '@/lib/plugins/mcp';
import { PROVIDERS } from '@/lib/plugins/providers';
import { usePlugins } from '@/store/plugins';
import { useUI } from '@/store/ui';
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu';
import { confirm, notify } from './Dialogs';

/** How long a row keeps spinning after a plugin is added, so the change reads as a step. */
const SETTLE_MS = 450;

/**
 * Adds a plugin: at once when its account already allows it (or it needs none), otherwise by
 * signing in. OAuth sign-ins go straight to the system browser; tokens, GitHub's device code and
 * the one-time client setup open the connect sheet. The plugin's row spins meanwhile.
 */
export function addPlugin(plugin: PluginDef) {
  connectPlugin(plugin, false);
}

/** Signs in again (from a plugin's settings), even when the saved account looks fine. */
export function reconnectPlugin(plugin: PluginDef) {
  connectPlugin(plugin, true);
}

function connectPlugin(plugin: PluginDef, force: boolean) {
  const { install, setConnecting, connecting } = usePlugins.getState();
  if (connecting) return;
  setConnecting(plugin.id);
  if (!force && canInstallSilently(plugin)) {
    install(plugin.id);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTimeout(() => usePlugins.getState().setConnecting(null), SETTLE_MS);
    return;
  }
  const kind = plugin.provider === 'none' ? 'none' : signInKind(plugin.provider);
  if (kind === 'mcp' || (kind === 'oauth' && !needsClientSetup(plugin.provider))) {
    void browserSignIn(plugin);
    return;
  }
  router.push({ pathname: '/plugins/connect', params: { id: plugin.id } });
}

/**
 * The provider's sign-in page in the system browser, then back to the app (MCP servers that need
 * no account connect straight away). Closing the browser just stops; failures are reported in a
 * dialog. Expects the plugin's row to be spinning already.
 */
export async function browserSignIn(plugin: PluginDef) {
  let installed = false;
  try {
    const account = signInKind(plugin.provider) === 'mcp' ? await connectMcp(plugin) : await signInWithBrowser(plugin);
    if (account) {
      if (!pluginGranted(plugin)) {
        notify(`${plugin.title} wasn’t allowed`, `Add it again and allow everything ${PROVIDERS[plugin.provider].title} asks for.`);
      } else {
        usePlugins.getState().install(plugin.id);
        installed = true;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    }
  } catch (e) {
    notify(`Couldn’t connect ${plugin.title}`, e instanceof Error ? e.message : String(e));
  } finally {
    settleConnecting(installed);
  }
}

/** Called by the sign-in sheet when it closes, connected or not. */
export function settleConnecting(installed: boolean) {
  setTimeout(() => usePlugins.getState().setConnecting(null), installed ? SETTLE_MS : 0);
}

/** Starts a new chat with `text` in the box, or sent right away. */
export function tryInChat(text: string, send = false) {
  useUI.getState().startWith({ attachments: [], text, send });
  router.dismissTo('/');
}

/** Removes a plugin; the account stays connected for the provider's other plugins. */
export function removePlugin(plugin: PluginDef, onRemoved?: () => void) {
  confirm({
    title: `Remove ${plugin.title}?`,
    message: 'Agents will no longer be able to use it. You can add it again any time.',
    confirmLabel: 'Remove',
    destructive: true,
    onConfirm: () => {
      const { installed, accounts } = usePlugins.getState();
      usePlugins.getState().uninstall([plugin.id]);
      // The last plugin on a token-only account takes the account with it.
      const others = PLUGINS.some((p) => p.provider === plugin.provider && p.id !== plugin.id && installed[p.id]);
      if (!others && accounts[plugin.provider] && PROVIDERS[plugin.provider].auth.kind !== 'oauth') {
        void disconnectProvider(plugin.provider);
      }
      onRemoved?.();
    },
  });
}

/** Signs out of a provider, which removes every plugin that uses it. */
export function signOutProvider(plugin: PluginDef, onDone?: () => void) {
  const provider = PROVIDERS[plugin.provider];
  const affected = PLUGINS.filter((p) => p.provider === plugin.provider && usePlugins.getState().installed[p.id]).map((p) => p.title);
  confirm({
    title: `Disconnect ${provider.title}?`,
    message: `${affected.length > 1 ? `${affected.join(', ')} will be removed. ` : ''}Clanker forgets the sign-in${
      provider.auth.kind === 'oauth' ? ' and revokes its access where it can' : ''
    }. Your files and data stay as they are.`,
    confirmLabel: 'Disconnect',
    destructive: true,
    onConfirm: async () => {
      await disconnectProvider(plugin.provider);
      onDone?.();
    },
  });
}

export function pluginActions(plugin: PluginDef): MenuItem[] {
  const account = plugin.provider === 'none' ? undefined : usePlugins.getState().accounts[plugin.provider];
  const broken = plugin.provider !== 'none' && (!account || account.needsReconnect || !pluginGranted(plugin));
  return [
    ...(broken ? [{ label: 'Reconnect', icon: { feather: 'refresh-cw' as const }, onPress: () => reconnectPlugin(plugin) }] : []),
    { label: 'Try in chat', icon: { feather: 'message-circle' }, onPress: () => tryInChat(`@${plugin.title} `) },
    { label: 'Details', icon: { feather: 'info' }, onPress: () => router.push({ pathname: '/plugins/plugin', params: { id: plugin.id } }) },
    { label: 'Settings', icon: { feather: 'settings' }, onPress: () => router.push({ pathname: '/plugins/settings', params: { id: plugin.id } }) },
    { label: 'Remove', icon: { feather: 'trash-2' }, destructive: true, separated: true, onPress: () => removePlugin(plugin) },
  ];
}

/** The ⋯ menu of an installed plugin. `show` opens it at the point pressed; render `menu` once. */
export function usePluginMenu() {
  const [state, setState] = useState<{ plugin: PluginDef; anchor: MenuAnchor } | null>(null);
  const show = useCallback((plugin: PluginDef, anchor: MenuAnchor) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setState({ plugin, anchor });
  }, []);
  const menu = <ContextMenu anchor={state?.anchor ?? null} items={state ? pluginActions(state.plugin) : []} onClose={() => setState(null)} />;
  return { show, menu };
}
