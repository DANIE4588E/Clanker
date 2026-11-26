import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { browserSignIn, settleConnecting } from '@/components/PluginActions';
import { PluginTile } from '@/components/PluginIcon';
import * as Haptics from '@/lib/haptics';
import {
  checkDeviceAuth,
  connectWithToken,
  needsClientSetup,
  openInBrowser,
  redirectRegistered,
  redirectUriFor,
  signInKind,
  startDeviceAuth,
  type DeviceSession,
} from '@/lib/plugins/auth';
import { pluginById, pluginGranted, type PluginDef } from '@/lib/plugins/catalog';
import { PROVIDERS, type TokenConfig } from '@/lib/plugins/providers';
import { useTheme } from '@/lib/theme';
import { usePlugins } from '@/store/plugins';

type Mode = 'setup' | 'device' | 'token';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Connecting a plugin when it takes more than the system browser: a pasted token, GitHub's device
 * code, or (once, when the build has no OAuth client for the provider) setting one up. OAuth
 * sign-ins themselves open in the system browser straight from the plugin list.
 */
export default function ConnectScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const plugin = pluginById(id);
  const done = useRef(false);
  // Set when the browser sign-in takes over; it settles the row's spinner itself.
  const handedOff = useRef(false);
  const [mode, setMode] = useState<Mode | null>(() => {
    if (!plugin || plugin.provider === 'none') return null;
    if (needsClientSetup(plugin.provider)) return 'setup';
    const kind = signInKind(plugin.provider);
    return kind === 'device' || kind === 'token' ? kind : 'setup';
  });

  // The plugin's row spins while this is open, however it was opened.
  useEffect(() => {
    if (plugin && !usePlugins.getState().connecting) usePlugins.getState().setConnecting(plugin.id);
    return () => {
      if (!handedOff.current) settleConnecting(done.current);
    };
  }, [plugin]);

  if (!plugin || !mode) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <SheetHeader title="Connect" />
      </View>
    );
  }

  const finish = () => {
    if (!pluginGranted(plugin)) {
      throw new Error(`Access for ${plugin.title} wasn’t allowed. Try again and allow everything ${PROVIDERS[plugin.provider].title} asks for.`);
    }
    usePlugins.getState().install(plugin.id);
    done.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.back();
  };

  const afterSetup = () => {
    const kind = signInKind(plugin.provider);
    if (kind === 'oauth') {
      handedOff.current = true;
      router.back();
      void browserSignIn(plugin);
    } else setMode(kind === 'device' ? 'device' : 'token');
  };

  switch (mode) {
    case 'setup':
      return <ClientSetup plugin={plugin} onDone={afterSetup} />;
    case 'device':
      return <DeviceSignIn plugin={plugin} onSignedIn={finish} onUseToken={() => setMode('token')} />;
    case 'token':
      return <TokenSignIn plugin={plugin} onSignedIn={finish} />;
  }
}

function SheetHeader({ title }: { title: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sheetHeader, { paddingTop: insets.top + 6, borderBottomColor: colors.border }]}>
      <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Close" style={styles.headerButton}>
        <Feather name="x" size={24} color={colors.text} />
      </Pressable>
      <Text numberOfLines={1} style={[styles.sheetTitle, { color: colors.text }]}>
        {title}
      </Text>
      <View style={styles.headerButton} />
    </View>
  );
}

function Steps({ steps }: { steps: string[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.steps}>
      {steps.map((step, i) => (
        <View key={step} style={styles.step}>
          <View style={[styles.stepNumber, { backgroundColor: colors.surface }]}>
            <Text style={[styles.stepNumberText, { color: colors.text }]}>{i + 1}</Text>
          </View>
          <Text style={[styles.stepText, { color: colors.text }]}>{step}</Text>
        </View>
      ))}
    </View>
  );
}

function OpenButton({ label, url }: { label: string; url: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={() => void openInBrowser(url)}
      style={({ pressed }) => [styles.secondary, { borderColor: colors.border }, pressed && { opacity: 0.6 }]}
    >
      <Feather name="external-link" size={17} color={colors.text} />
      <Text style={[styles.secondaryText, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

// ---- Device code (GitHub) ---------------------------------------------------------------------

function DeviceSignIn({ plugin, onSignedIn, onUseToken }: { plugin: PluginDef; onSignedIn: () => void; onUseToken: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const provider = PROVIDERS[plugin.provider];
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [failure, setFailure] = useState('');
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signedIn = useRef(onSignedIn);
  useEffect(() => {
    signedIn.current = onSignedIn;
  });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    let current: DeviceSession | null = null;

    const check = async () => {
      if (!current || checking || controller.signal.aborted) return;
      checking = true;
      clearTimeout(timer);
      try {
        const result = await checkDeviceAuth(current, controller.signal);
        if (controller.signal.aborted) return;
        if ('account' in result) {
          setWorking(true);
          signedIn.current();
          return;
        }
        timer = setTimeout(check, result.wait * 1000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setWorking(false);
          setFailure(message(e));
        }
      } finally {
        checking = false;
      }
    };

    // Timers can stall while GitHub's page is in front, so check as soon as the app is back.
    const sub = AppState.addEventListener('change', (state) => state === 'active' && void check());

    void (async () => {
      try {
        const s = await startDeviceAuth(plugin.provider);
        if (controller.signal.aborted) return;
        current = s;
        setSession(s);
        // Copied up front, so it's ready to paste on GitHub's page.
        await Clipboard.setStringAsync(s.userCode).catch(() => {});
        setCopied(true);
        void openInBrowser(s.verificationUri);
        timer = setTimeout(check, s.interval * 1000);
      } catch (e) {
        if (!controller.signal.aborted) setFailure(message(e));
      }
    })();

    return () => {
      controller.abort();
      clearTimeout(timer);
      sub.remove();
    };
  }, [plugin.provider, attempt]);

  const retry = () => {
    setSession(null);
    setFailure('');
    setWorking(false);
    setAttempt((n) => n + 1);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <SheetHeader title={`Connect ${plugin.title}`} />
      <View style={[styles.form, { paddingBottom: insets.bottom + 32 }]}>
        <PluginTile id={plugin.id} size={60} />
        <Text style={[styles.formTitle, { color: colors.text }]}>Enter this code on {provider.title}</Text>
        <Text style={[styles.formLead, { color: colors.textSecondary }]}>
          {session
            ? `${provider.title} opened in your browser. Sign in, paste the code and authorize Clanker, then come back here.`
            : 'Getting a code…'}
        </Text>

        <View style={[styles.codeCard, { backgroundColor: colors.surface }]}>
          <Text selectable style={[styles.code, { color: colors.text }]}>
            {session?.userCode ?? '····-····'}
          </Text>
          {session && (
            <Pressable
              onPress={() => {
                void Clipboard.setStringAsync(session.userCode);
                setCopied(true);
              }}
              hitSlop={8}
              style={[styles.copy, { backgroundColor: colors.chrome }]}
            >
              <Feather name={copied ? 'check' : 'copy'} size={15} color={colors.text} />
              <Text style={[styles.copyText, { color: colors.text }]}>{copied ? 'Copied' : 'Copy'}</Text>
            </Pressable>
          )}
        </View>

        {session && !failure && (
          <View style={styles.waiting}>
            <ActivityIndicator color={colors.textTertiary} />
            <Text style={[styles.waitingText, { color: colors.textSecondary }]}>{working ? 'Connecting…' : 'Waiting for you to authorize…'}</Text>
          </View>
        )}
        {!!failure && <Text style={[styles.failure, { color: colors.danger }]}>{failure}</Text>}

        {failure ? (
          <Pressable onPress={retry} style={({ pressed }) => [styles.cta, { backgroundColor: colors.text, opacity: pressed ? 0.8 : 1 }]}>
            <Text style={[styles.ctaText, { color: colors.background }]}>Get a new code</Text>
          </Pressable>
        ) : (
          session && <OpenButton label={`Open ${provider.title} again`} url={session.verificationUri} />
        )}

        <Pressable onPress={onUseToken} hitSlop={8} style={styles.textButton}>
          <Text style={[styles.textButtonLabel, { color: colors.link }]}>Use a token instead</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---- Pasted token -----------------------------------------------------------------------------

function TokenSignIn({ plugin, onSignedIn }: { plugin: PluginDef; onSignedIn: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const provider = PROVIDERS[plugin.provider];
  const auth = (provider.auth.kind === 'device' ? provider.auth.token : provider.auth) as TokenConfig;
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  const connect = async () => {
    setBusy(true);
    setFailure('');
    try {
      await connectWithToken(plugin.provider, token);
      onSignedIn();
    } catch (e) {
      setFailure(message(e));
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <SheetHeader title={`Connect ${plugin.title}`} />
      <KeyboardAwareScrollView contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
        <PluginTile id={plugin.id} size={60} />
        <Text style={[styles.formTitle, { color: colors.text }]}>Connect {plugin.title}</Text>
        <Text style={[styles.formLead, { color: colors.textSecondary }]}>
          {provider.title} connects with a token from your account. It stays in this phone’s keychain and is only sent to {provider.title}.
        </Text>
        <Steps steps={auth.steps} />
        <OpenButton label={`Open ${provider.title}`} url={auth.tokenUrl} />

        <View style={[styles.field, { backgroundColor: colors.surface }]}>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder={auth.placeholder}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            onSubmitEditing={() => token.trim() && void connect()}
            style={[styles.fieldInput, { color: colors.text }]}
          />
          <Pressable
            onPress={async () => {
              const text = await Clipboard.getStringAsync();
              if (text) setToken(text.trim());
            }}
            hitSlop={8}
          >
            <Text style={[styles.paste, { color: colors.link }]}>Paste</Text>
          </Pressable>
        </View>
        {!!failure && <Text style={[styles.failure, { color: colors.danger }]}>{failure}</Text>}

        <Pressable
          onPress={() => void connect()}
          disabled={busy || !token.trim()}
          style={({ pressed }) => [styles.cta, { backgroundColor: colors.text, opacity: !token.trim() ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          {busy ? <ActivityIndicator color={colors.background} /> : <Text style={[styles.ctaText, { color: colors.background }]}>Connect</Text>}
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}

// ---- One-time client setup --------------------------------------------------------------------

function CopyRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      onPress={() => {
        void Clipboard.setStringAsync(value);
        setCopied(true);
      }}
      accessibilityHint={`Copies the ${label.toLowerCase()}`}
      style={[styles.copyRow, { backgroundColor: colors.surface }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.copyRowLabel, { color: colors.textTertiary }]}>{label}</Text>
        <Text selectable style={[styles.copyRowValue, { color: colors.text }]}>
          {value}
        </Text>
      </View>
      <Feather name={copied ? 'check' : 'copy'} size={18} color={colors.textSecondary} />
    </Pressable>
  );
}

function ClientSetup({ plugin, onDone }: { plugin: PluginDef; onDone: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const provider = PROVIDERS[plugin.provider];
  const oauth = provider.auth.kind === 'oauth' ? provider.auth : null;
  const saved = usePlugins((s) => s.clients[plugin.provider]);
  const [clientId, setClientId] = useState(saved?.id ?? provider.builtInClient?.id ?? '');
  const id = clientId.trim();
  // Google returns on a scheme made from the client ID, which only a build that has it can receive.
  const perClientScheme = oauth?.redirect === 'google';
  const receivable = !oauth || !id || redirectRegistered(plugin.provider, id);

  const save = () => {
    usePlugins.getState().setClient(plugin.provider, { id });
    onDone();
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <SheetHeader title={`Set up ${provider.title}`} />
      <KeyboardAwareScrollView contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
        <PluginTile id={plugin.id} size={60} />
        <Text style={[styles.formTitle, { color: colors.text }]}>One-time setup</Text>
        <Text style={[styles.formLead, { color: colors.textSecondary }]}>
          This build of Clanker has no {provider.title} sign-in client yet. Register one once and every {provider.title} plugin signs in with it.
        </Text>
        {provider.setup && <Steps steps={provider.setup.steps} />}
        {provider.setup && <OpenButton label={`Open ${provider.title} console`} url={provider.setup.consoleUrl} />}

        <View style={[styles.field, { backgroundColor: colors.surface }]}>
          <TextInput
            value={clientId}
            onChangeText={setClientId}
            placeholder="Client ID"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.fieldInput, { color: colors.text }]}
          />
        </View>

        {oauth && (!perClientScheme || id) && <CopyRow label="Redirect URI" value={redirectUriFor(plugin.provider, id || 'CLIENT_ID')} />}
        {perClientScheme && id && !receivable && (
          <View style={[styles.note, { backgroundColor: colors.surface }]}>
            <Feather name="alert-triangle" size={18} color={colors.danger} />
            <Text style={[styles.noteText, { color: colors.text }]}>
              This build can’t receive {provider.title}’s redirect for this client yet. Add it to .env.local and make a new build, then add the plugin
              again.
            </Text>
          </View>
        )}
        {perClientScheme && id && !receivable && <CopyRow label=".env.local" value={`EXPO_PUBLIC_GOOGLE_PLUGIN_CLIENT_ID=${id}`} />}

        <Pressable
          onPress={save}
          disabled={!id || !receivable}
          style={({ pressed }) => [styles.cta, { backgroundColor: colors.text, opacity: !id || !receivable ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          <Text style={[styles.ctaText, { color: colors.background }]}>Continue to sign in</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sheetTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  form: { padding: 24, alignItems: 'stretch' },
  formTitle: { fontSize: 24, fontWeight: '600', marginTop: 16 },
  formLead: { fontSize: 15, lineHeight: 21, marginTop: 8 },
  steps: { gap: 14, marginTop: 24 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  stepNumber: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  stepNumberText: { fontSize: 13, fontWeight: '600' },
  stepText: { flex: 1, fontSize: 15, lineHeight: 21, paddingTop: 2 },
  secondary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 24, borderWidth: 1, marginTop: 24 },
  secondaryText: { fontSize: 16, fontWeight: '500' },
  codeCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 18, borderRadius: 16, marginTop: 24 },
  code: { flex: 1, fontSize: 28, fontWeight: '700', letterSpacing: 2, fontVariant: ['tabular-nums'] },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 17 },
  copyText: { fontSize: 14, fontWeight: '500' },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20 },
  waitingText: { fontSize: 15 },
  textButton: { alignSelf: 'center', marginTop: 20 },
  textButtonLabel: { fontSize: 15, fontWeight: '500' },
  copyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, marginTop: 14 },
  copyRowLabel: { fontSize: 12 },
  copyRowValue: { fontSize: 15, marginTop: 2 },
  note: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 14, marginTop: 14 },
  noteText: { flex: 1, fontSize: 14, lineHeight: 20 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, paddingHorizontal: 16, marginTop: 14 },
  fieldInput: { flex: 1, fontSize: 16, paddingVertical: 14 },
  paste: { fontSize: 15, fontWeight: '500' },
  failure: { fontSize: 14, lineHeight: 20, marginTop: 14 },
  cta: { height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  ctaText: { fontSize: 17, fontWeight: '600' },
});
