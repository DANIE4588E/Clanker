import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { WebView } from 'react-native-webview';
import { BrandIcon } from '@/components/BrandIcon';
import { Disclosure, Input, Label } from '@/components/Form';
import { SegmentedControl } from '@/components/SegmentedControl';
import { SubscriptionUsageCard } from '@/components/SubscriptionUsageCard';
import { formatTokens, parseTokens } from '@/lib/context';
import * as Haptics from '@/lib/haptics';
import {
  getAdapter,
  guessEfforts,
  isSubscriptionType,
  type Endpoint,
  type SubscriptionAccount,
  type SubscriptionRouting,
  type SubscriptionType,
} from '@/lib/providers';
import { uid } from '@/lib/storage';
import {
  ANTIGRAVITY_OAUTH,
  accountsOf,
  accountUsageKey,
  buildAntigravityAuthSession,
  buildClaudeAuthSession,
  exchangeAntigravityAuthCode,
  exchangeClaudeAuthCode,
  isAccountCoolingDown,
  parseAntigravityCallback,
  parseAntigravityImport,
  parseClaudeImport,
  parseCodexImport,
  pollCodexDeviceAuth,
  primaryDisplayAccount,
  startCodexDeviceAuth,
  SUBSCRIPTION_META,
  SUBSCRIPTION_TYPES,
  subscriptionAuth,
  type BrowserCodeSession,
  type CodexDeviceSession,
  type SubscriptionCredentials,
} from '@/lib/subscriptions';
import { fonts, useTheme } from '@/lib/theme';
import { resolveBudget, useSettings } from '@/store/settings';
import { useSubscriptionUsage } from '@/store/subscriptionUsage';

const ROUTING_OPTIONS: { value: SubscriptionRouting; label: string; icon: 'shuffle' | 'user' }[] = [
  { value: 'auto', label: 'Auto balance', icon: 'shuffle' },
  { value: 'manual', label: 'Manual', icon: 'user' },
];

export default function SubscriptionScreen() {
  const { colors } = useTheme();
  const { id, preset } = useLocalSearchParams<{ id?: string; preset?: string }>();
  const existing = useSettings((s) => s.endpoints.find((e) => e.id === id && isSubscriptionType(e.type)));
  const initialType: SubscriptionType =
    existing && isSubscriptionType(existing.type)
      ? existing.type
      : preset && isSubscriptionType(preset as SubscriptionType)
        ? (preset as SubscriptionType)
        : 'codex';

  const [endpointId] = useState(() => existing?.id ?? uid());
  const [type, setType] = useState<SubscriptionType>(initialType);
  const [name, setName] = useState(existing?.name ?? SUBSCRIPTION_META[initialType].name);
  const [models, setModels] = useState<string[]>(existing?.models ?? []);
  const [efforts, setEfforts] = useState<Record<string, string[]>>(existing?.efforts ?? {});
  const [contexts, setContexts] = useState<Record<string, number>>(existing?.contexts ?? {});
  const [budgets, setBudgets] = useState<Record<string, number>>(existing?.budgets ?? {});
  const [editing, setEditing] = useState<{ model: string; field: 'effort' | 'budget'; text: string } | null>(null);
  const [newModel, setNewModel] = useState('');
  const [modelFilter, setModelFilter] = useState('');

  const [accounts, setAccounts] = useState<SubscriptionAccount[]>(() =>
    existing?.subscriptionAccounts?.length ? existing.subscriptionAccounts : []
  );
  const [accountMode, setAccountMode] = useState<SubscriptionRouting>(existing?.accountMode ?? 'auto');
  const [activeAccountId, setActiveAccountId] = useState<string | undefined>(
    existing?.activeAccountId ?? existing?.subscriptionAccounts?.[0]?.id
  );
  const [authLoading, setAuthLoading] = useState(!!existing && !existing.subscriptionAccounts?.length);
  const [savedOnce, setSavedOnce] = useState(!!existing);

  // Sign-in panel state (used for initial account, "+ Add another account", or re-authenticating an account).
  const [showAddAccount, setShowAddAccount] = useState(!existing);
  const [reauthAccountId, setReauthAccountId] = useState<string | null>(null);
  const [deviceSession, setDeviceSession] = useState<CodexDeviceSession | null>(null);
  const [browserSession, setBrowserSession] = useState<BrowserCodeSession | null>(null);
  const [googleSession, setGoogleSession] = useState<BrowserCodeSession | null>(null);
  const [googleError, setGoogleError] = useState('');
  const [pastedCode, setPastedCode] = useState('');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState<'auth' | 'fetch' | 'test' | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const deletedRef = useRef(false);
  const savedOnceRef = useRef(!!existing);
  const accountsRef = useRef(accounts);
  const persistRef = useRef<() => void>(() => {});
  const pollController = useRef<AbortController | null>(null);
  const meta = SUBSCRIPTION_META[type];

  const byAccount = useSubscriptionUsage((s) => s.byAccount);
  const loadingMap = useSubscriptionUsage((s) => s.loading);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  // Hydrate legacy single-account subscriptions & refresh usage on mount.
  useEffect(() => {
    let active = true;
    if (existing) {
      if (existing.subscriptionAccounts?.length) {
        void useSubscriptionUsage.getState().refresh(existing);
      } else {
        subscriptionAuth.get(existing.id).then((legacy) => {
          if (!active) return;
          if (legacy) {
            const migrated: SubscriptionAccount = {
              id: existing.id,
              label: legacy.email ?? existing.subscriptionAccount ?? existing.name,
              email: legacy.email ?? existing.subscriptionAccount,
              plan: legacy.plan ?? existing.subscriptionPlan,
              addedAt: Date.now(),
            };
            setAccounts([migrated]);
            setActiveAccountId(migrated.id);
            setShowAddAccount(false);
            void useSubscriptionUsage.getState().refreshAccount(existing, migrated);
          } else {
            setShowAddAccount(true);
          }
          setAuthLoading(false);
        });
      }
    }
    return () => {
      active = false;
      pollController.current?.abort();
    };
  }, [existing]);

  const draft = (overrides?: Partial<Endpoint>): Endpoint => {
    const accList = overrides?.subscriptionAccounts ?? accounts;
    const mode = overrides?.accountMode ?? accountMode;
    const chosenId =
      overrides?.activeAccountId ??
      (activeAccountId && accList.some((a) => a.id === activeAccountId) ? activeAccountId : accList[0]?.id);
    const primary = accList.find((a) => a.id === chosenId) ?? accList[0];
    const primaryUsage = primary ? byAccount[accountUsageKey(endpointId, primary.id)] : undefined;

    return {
      id: endpointId,
      name: name.trim() || meta.name,
      type,
      baseUrl: meta.baseUrl,
      models,
      efforts: Object.fromEntries(models.flatMap((m) => (efforts[m]?.length ? [[m, efforts[m]]] : []))),
      contexts: Object.fromEntries(models.flatMap((m) => (contexts[m] ? [[m, contexts[m]]] : []))),
      budgets: Object.fromEntries(models.flatMap((m) => (budgets[m] ? [[m, budgets[m]]] : []))),
      ...(primary?.email ?? primaryUsage?.email ? { subscriptionAccount: primary?.email ?? primaryUsage?.email } : {}),
      ...(primaryUsage?.plan ?? primary?.plan ? { subscriptionPlan: primaryUsage?.plan ?? primary?.plan } : {}),
      subscriptionAccounts: accList,
      accountMode: mode,
      ...(chosenId ? { activeAccountId: chosenId } : {}),
      ...overrides,
    };
  };

  const canSave = accounts.length > 0 && models.length > 0;

  // Auto-save any changes once the subscription has at least one account and model.
  useEffect(() => {
    const persist = () => {
      if (deletedRef.current || authLoading) return;
      if (!accounts.length || !models.length) return;
      const chosenId =
        activeAccountId && accounts.some((a) => a.id === activeAccountId) ? activeAccountId : accounts[0]?.id;
      const primary = accounts.find((a) => a.id === chosenId) ?? accounts[0];
      const primaryUsage = primary ? useSubscriptionUsage.getState().byAccount[accountUsageKey(endpointId, primary.id)] : undefined;
      const ep: Endpoint = {
        id: endpointId,
        name: name.trim() || meta.name,
        type,
        baseUrl: meta.baseUrl,
        models,
        efforts: Object.fromEntries(models.flatMap((m) => (efforts[m]?.length ? [[m, efforts[m]]] : []))),
        contexts: Object.fromEntries(models.flatMap((m) => (contexts[m] ? [[m, contexts[m]]] : []))),
        budgets: Object.fromEntries(models.flatMap((m) => (budgets[m] ? [[m, budgets[m]]] : []))),
        ...(primary?.email ?? primaryUsage?.email ? { subscriptionAccount: primary?.email ?? primaryUsage?.email } : {}),
        ...(primaryUsage?.plan ?? primary?.plan ? { subscriptionPlan: primaryUsage?.plan ?? primary?.plan } : {}),
        subscriptionAccounts: accounts,
        accountMode,
        ...(chosenId ? { activeAccountId: chosenId } : {}),
      };
      useSettings.getState().upsertEndpoint(ep);
      savedOnceRef.current = true;
      setSavedOnce(true);
    };
    persistRef.current = persist;
    if (!canSave || authLoading) return;
    const timer = setTimeout(persist, 200);
    return () => clearTimeout(timer);
  }, [
    endpointId,
    name,
    type,
    meta.name,
    meta.baseUrl,
    models,
    efforts,
    contexts,
    budgets,
    accounts,
    accountMode,
    activeAccountId,
    canSave,
    authLoading,
  ]);

  // Flush pending auto-save on unmount, or clean up orphaned credentials if never saved.
  useEffect(
    () => () => {
      persistRef.current();
      if (!savedOnceRef.current && !deletedRef.current) {
        const ids = accountsRef.current.map((a) => a.id);
        void subscriptionAuth.removeAll(endpointId, ids);
        useSubscriptionUsage.getState().removeEndpointUsage(endpointId);
      }
    },
    [endpointId]
  );

  const selectType = (next: SubscriptionType) => {
    if (savedOnce || next === type) return;
    pollController.current?.abort();
    setDeviceSession(null);
    setBrowserSession(null);
    setGoogleSession(null);
    setGoogleError('');
    setPastedCode('');
    setImportText('');
    setReauthAccountId(null);
    setAccounts([]);
    setActiveAccountId(undefined);
    setShowAddAccount(true);
    setModels([]);
    setEfforts({});
    setContexts({});
    setBudgets({});
    setStatus(null);
    setType(next);
    setName(SUBSCRIPTION_META[next].name);
    void subscriptionAuth.removeAll(endpointId, accounts.map((a) => a.id));
    useSubscriptionUsage.getState().removeEndpointUsage(endpointId);
  };

  const afterSignIn = async (nextCreds: SubscriptionCredentials, nextType = type) => {
    const emailNorm = nextCreds.email?.trim().toLowerCase();
    // Match the targeted re-auth account, or an existing account with the same email, else create a new slot.
    const existingMatch = reauthAccountId
      ? accounts.find((a) => a.id === reauthAccountId)
      : emailNorm
        ? accounts.find((a) => a.email?.trim().toLowerCase() === emailNorm)
        : undefined;
    const accountId = existingMatch?.id ?? uid();
    await subscriptionAuth.set(endpointId, nextCreds, accountId);

    const newAccount: SubscriptionAccount = {
      id: accountId,
      label:
        nextCreds.email?.trim() ||
        existingMatch?.label ||
        `${SUBSCRIPTION_META[nextType].name} account ${accounts.length + 1}`,
      ...(nextCreds.email ? { email: nextCreds.email } : existingMatch?.email ? { email: existingMatch.email } : {}),
      // On re-authentication, replace stale plan with the freshly negotiated one.
      ...(nextCreds.plan ? { plan: nextCreds.plan } : !reauthAccountId && existingMatch?.plan ? { plan: existingMatch.plan } : {}),
      addedAt: existingMatch?.addedAt ?? Date.now(),
    };

    const nextAccounts = existingMatch
      ? accounts.map((a) => (a.id === accountId ? newAccount : a))
      : [...accounts, newAccount];

    setAccounts(nextAccounts);
    if (!activeAccountId) setActiveAccountId(accountId);

    setReauthAccountId(null);
    setShowAddAccount(false);
    setDeviceSession(null);
    setBrowserSession(null);
    setPastedCode('');
    setImportText('');

    const ep = draft({
      type: nextType,
      baseUrl: SUBSCRIPTION_META[nextType].baseUrl,
      subscriptionAccounts: nextAccounts,
      activeAccountId: activeAccountId ?? accountId,
    });

    // Fetch live usage for this account, and fetch models if none are loaded yet.
    const [usageResult, modelsResult] = await Promise.all([
      useSubscriptionUsage.getState().refreshAccount(ep, newAccount, { force: true, creds: nextCreds }),
      models.length === 0
        ? getAdapter(nextType)
            .listModels(ep)
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    if (usageResult && (usageResult.email || usageResult.plan)) {
      const updatedAccount: SubscriptionAccount = {
        ...newAccount,
        label: usageResult.email ?? newAccount.label,
        email: usageResult.email ?? newAccount.email,
        plan: usageResult.plan ?? newAccount.plan,
      };
      setAccounts((prev) => prev.map((a) => (a.id === accountId ? updatedAccount : a)));
    }

    if (modelsResult?.models.length) {
      setModels(modelsResult.models.map((m) => m.id));
      setEfforts(Object.fromEntries(modelsResult.models.flatMap((m) => (m.efforts ? [[m.id, m.efforts]] : []))));
      setContexts(
        Object.fromEntries(
          modelsResult.models.flatMap((m) => (m.contextLength && m.contextLength > 0 ? [[m.id, m.contextLength]] : []))
        )
      );
      setStatus({
        ok: true,
        text: `Signed in${newAccount.email ? ` as ${newAccount.email}` : ''} and loaded ${modelsResult.models.length} models.`,
      });
    } else {
      setStatus({
        ok: true,
        text: existingMatch
          ? `Refreshed sign-in for ${newAccount.label}.`
          : `Added ${newAccount.label}${nextAccounts.length > 1 ? ` (${nextAccounts.length} accounts connected)` : ''}.`,
      });
    }
  };

  const startSignIn = async (targetAccountId: string | null = null) => {
    setStatus(null);
    setReauthAccountId(targetAccountId);
    setShowAddAccount(true);
    if (type === 'codex') {
      pollController.current?.abort();
      setBusy('auth');
      try {
        const session = await startCodexDeviceAuth();
        setDeviceSession(session);
        await Clipboard.setStringAsync(session.userCode).catch(() => {});
        const controller = new AbortController();
        pollController.current = controller;
        void Linking.openURL(session.verificationUrl);
        const tokens = await pollCodexDeviceAuth(session, controller.signal);
        await afterSignIn(tokens, 'codex');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/cancelled/i.test(msg)) setStatus({ ok: false, text: msg });
        setDeviceSession(null);
      } finally {
        setBusy(null);
      }
      return;
    }

    if (type === 'antigravity') {
      setGoogleError('');
      setGoogleSession(buildAntigravityAuthSession());
      return;
    }

    const session = buildClaudeAuthSession();
    setBrowserSession(session);
    setPastedCode('');
    await Linking.openURL(session.authorizeUrl);
  };

  const cancelSignIn = () => {
    pollController.current?.abort();
    setDeviceSession(null);
    setBrowserSession(null);
    setGoogleSession(null);
    setGoogleError('');
    setPastedCode('');
    setReauthAccountId(null);
    if (accounts.length > 0) setShowAddAccount(false);
    setBusy(null);
  };

  const completeBrowserSignIn = async () => {
    if (!browserSession) return;
    if (!pastedCode.trim()) return setStatus({ ok: false, text: 'Paste the code from your browser first.' });
    setBusy('auth');
    setStatus(null);
    try {
      const tokens = await exchangeClaudeAuthCode(pastedCode, browserSession);
      await afterSignIn(tokens, type);
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const importCredentials = async () => {
    if (!importText.trim()) return setStatus({ ok: false, text: 'Paste credentials first.' });
    setBusy('auth');
    setStatus(null);
    try {
      const parsed: SubscriptionCredentials =
        type === 'codex'
          ? parseCodexImport(importText)
          : type === 'antigravity'
            ? parseAntigravityImport(importText)
            : parseClaudeImport(importText);
      await afterSignIn(parsed, type);
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const removeAccount = (account: SubscriptionAccount) =>
    Alert.alert(
      'Sign out account?',
      `Saved OAuth tokens for ${account.label} will be removed from this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            await subscriptionAuth.remove(endpointId, account.id);
            useSubscriptionUsage.getState().removeAccountUsage(endpointId, account.id);
            const remaining = accounts.filter((a) => a.id !== account.id);
            setAccounts(remaining);
            const nextActive = activeAccountId === account.id ? remaining[0]?.id : activeAccountId;
            setActiveAccountId(nextActive);
            if (!remaining.length) {
              setShowAddAccount(true);
              if (savedOnceRef.current) {
                // Keep endpoint synced with empty account list or let user re-sign-in.
                useSettings.getState().upsertEndpoint(
                  draft({ subscriptionAccounts: [], activeAccountId: undefined, subscriptionAccount: undefined })
                );
              }
            }
          },
        },
      ]
    );

  const fetchModels = async () => {
    if (!accounts.length) return setStatus({ ok: false, text: 'Sign in to an account first.' });
    setBusy('fetch');
    setStatus(null);
    try {
      const ep = draft();
      const { models: list } = await getAdapter(type).listModels(ep);
      setModels(list.map((m) => m.id));
      const found = Object.fromEntries(list.flatMap((m) => (m.efforts ? [[m.id, m.efforts]] : [])));
      setEfforts(found);
      setContexts(
        Object.fromEntries(list.flatMap((m) => (m.contextLength && m.contextLength > 0 ? [[m.id, m.contextLength]] : [])))
      );
      void useSubscriptionUsage.getState().refresh(ep, { force: true });
      const withEffort = Object.keys(found).length;
      setStatus({
        ok: true,
        text: `Found ${list.length} model${list.length === 1 ? '' : 's'}${withEffort ? `, ${withEffort} with effort levels` : ''}.`,
      });
    } catch (e) {
      setStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    if (!accounts.length) return setStatus({ ok: false, text: 'Sign in to an account first.' });
    if (!models.length) return setStatus({ ok: false, text: 'Fetch or add at least one model to test.' });
    setBusy('test');
    setStatus(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let reply = '';
    const ep = draft();
    try {
      await getAdapter(type).stream({
        endpoint: ep,
        model: models[0],
        signal: controller.signal,
        messages: [{ role: 'user', text: 'Reply with exactly one word: OK', images: [] }],
        onToken: (t) => (reply += t),
      });
      const usedId = useSubscriptionUsage.getState().lastUsedAccount[ep.id];
      const usedAcc = accountsOf(ep).find((a) => a.id === usedId);
      void useSubscriptionUsage.getState().refresh(ep, { force: true, ...(usedId ? { accountId: usedId } : {}) });
      setStatus({
        ok: true,
        text: `${models[0]}${accounts.length > 1 && usedAcc ? ` (${usedAcc.label})` : ''} replied: ${reply.trim().slice(0, 80) || '(empty)'}`,
      });
    } catch (e) {
      const text = controller.signal.aborted ? 'Timed out after 30 seconds.' : e instanceof Error ? e.message : String(e);
      setStatus({ ok: false, text });
    } finally {
      clearTimeout(timeout);
      setBusy(null);
    }
  };

  const addModel = () => {
    const m = newModel.trim();
    if (m && !models.includes(m)) {
      setModels([...models, m]);
      const guessed = guessEfforts(type, m);
      if (guessed) setEfforts({ ...efforts, [m]: guessed });
    }
    setNewModel('');
  };

  const commitEdit = () => {
    if (!editing) return;
    setEditing(null);
    if (editing.field === 'effort') {
      const levels = [...new Set(editing.text.split(/[\s,]+/).filter(Boolean).map((l) => l.toLowerCase()))];
      const { [editing.model]: _, ...rest } = efforts;
      setEfforts(levels.length ? { ...rest, [editing.model]: levels } : rest);
      return;
    }
    const { [editing.model]: _, ...rest } = budgets;
    if (!editing.text.trim()) return setBudgets(rest);
    const tokens = parseTokens(editing.text);
    if (tokens) setBudgets({ ...rest, [editing.model]: tokens });
    else Alert.alert('Invalid context budget', 'Enter a token count such as 32000, 128K or 1M.');
  };

  const remove = () =>
    Alert.alert('Remove subscription?', `${name.trim() || meta.name} and all saved OAuth tokens will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          deletedRef.current = true;
          useSettings.getState().removeEndpoint(endpointId);
          router.back();
        },
      },
    ]);

  const visibleModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    return q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  }, [models, modelFilter]);

  const nextAutoAccountId = useMemo(() => {
    if (accountMode !== 'auto' || accounts.length < 2) return undefined;
    return primaryDisplayAccount(
      {
        id: endpointId,
        name: name.trim() || meta.name,
        accountMode,
        activeAccountId,
        subscriptionAccounts: accounts,
      },
      byAccount,
      models[0]
    ).account?.id;
  }, [accountMode, accounts, activeAccountId, byAccount, endpointId, meta.name, models, name]);

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: savedOnce ? name.trim() || meta.name : 'Add subscription',
          headerRight: () =>
            canSave ? (
              <Text style={{ color: colors.textTertiary, fontSize: 14 }}>Saved</Text>
            ) : accounts.length > 0 ? (
              <Text style={{ color: colors.textTertiary, fontSize: 13 }}>Add a model</Text>
            ) : null,
        }}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!savedOnce && (
          <>
            <Label>Subscription</Label>
            <View style={styles.providerGrid}>
              {SUBSCRIPTION_TYPES.map((t) => {
                const m = SUBSCRIPTION_META[t];
                const on = type === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => selectType(t)}
                    style={({ pressed }) => [
                      styles.providerCard,
                      {
                        borderColor: on ? colors.text : colors.border,
                        backgroundColor: on ? colors.surface : 'transparent',
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <BrandIcon brand={m.brand} size={22} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.providerName, { color: colors.text }]}>{m.name}</Text>
                      <Text numberOfLines={1} style={[styles.providerSub, { color: colors.textTertiary }]}>
                        {m.subtitle}
                      </Text>
                    </View>
                    {on && <Feather name="check" size={18} color={colors.text} />}
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        {accounts.length > 1 && (
          <>
            <Label>Account routing</Label>
            <SegmentedControl options={ROUTING_OPTIONS} value={accountMode} onChange={setAccountMode} />
            <Text style={[styles.hint, { color: colors.textTertiary }]}>
              {accountMode === 'auto'
                ? 'Automatically picks the account with the most remaining usage and fails over if one hits a rate limit.'
                : 'Always sends requests through the account selected below.'}
            </Text>
          </>
        )}

        <View style={styles.modelsHeader}>
          <Label>{accounts.length > 1 ? `Accounts (${accounts.length})` : 'Account'}</Label>
          {accounts.length > 0 && (
            <Pressable
              onPress={() => void useSubscriptionUsage.getState().refresh(draft(), { force: true })}
              hitSlop={8}
              style={styles.inlineButton}
            >
              <Feather name="refresh-cw" size={14} color={colors.link} />
              <Text style={{ color: colors.link, fontSize: 14, fontWeight: '500' }}>Refresh all</Text>
            </Pressable>
          )}
        </View>

        {authLoading ? (
          <View style={[styles.authCard, { backgroundColor: colors.surface }]}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={{ color: colors.textSecondary, fontSize: 15 }}>Checking saved sessions…</Text>
          </View>
        ) : (
          <View style={styles.accountStack}>
            {accounts.map((acc) => {
              const key = accountUsageKey(endpointId, acc.id);
              const accUsage = byAccount[key];
              const accLoading = !!loadingMap[key];
              const isSelectedManual = accountMode === 'manual' && (activeAccountId ?? accounts[0]?.id) === acc.id;
              const isNextAuto = accountMode === 'auto' && nextAutoAccountId === acc.id;
              const cooling = isAccountCoolingDown(endpointId, acc.id);

              return (
                <View
                  key={acc.id}
                  style={[
                    styles.accountCard,
                    {
                      backgroundColor: colors.surface,
                      borderColor: isSelectedManual && accounts.length > 1 ? colors.text : 'transparent',
                      borderWidth: isSelectedManual && accounts.length > 1 ? 1 : 0,
                    },
                  ]}
                >
                  <Pressable
                    disabled={accounts.length < 2 || accountMode !== 'manual'}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setActiveAccountId(acc.id);
                    }}
                    style={styles.accountRow}
                  >
                    {accounts.length > 1 && accountMode === 'manual' ? (
                      <Feather
                        name={isSelectedManual ? 'check-circle' : 'circle'}
                        size={20}
                        color={isSelectedManual ? colors.accentText : colors.textTertiary}
                      />
                    ) : (
                      <BrandIcon brand={meta.brand} size={22} />
                    )}
                    <View style={{ flex: 1 }}>
                      <View style={styles.accountTitleRow}>
                        <Text numberOfLines={1} style={[styles.accountTitle, { color: colors.text }]}>
                          {acc.email ?? accUsage?.email ?? acc.label}
                        </Text>
                        {isNextAuto && (
                          <View style={[styles.pill, { backgroundColor: colors.surfaceHover }]}>
                            <Text style={[styles.pillText, { color: colors.textSecondary }]}>Next</Text>
                          </View>
                        )}
                        {cooling && (
                          <View style={[styles.pill, { backgroundColor: colors.dangerBg }]}>
                            <Text style={[styles.pillText, { color: colors.danger }]}>Cooldown</Text>
                          </View>
                        )}
                      </View>
                      <Text numberOfLines={1} style={[styles.accountSub, { color: colors.textTertiary }]}>
                        {[accUsage?.plan ?? acc.plan, isSelectedManual && accounts.length > 1 ? 'Selected' : undefined]
                          .filter(Boolean)
                          .join(' · ') || 'Signed in'}
                      </Text>
                    </View>
                    {accounts.length === 1 && <Feather name="check-circle" size={18} color={colors.success} />}
                  </Pressable>

                  <SubscriptionUsageCard
                    usage={accUsage}
                    loading={accLoading}
                    compact
                    onRefresh={() => void useSubscriptionUsage.getState().refreshAccount(draft(), acc, { force: true })}
                  />

                  <View style={[styles.accountActions, { borderTopColor: colors.border }]}>
                    <Pressable
                      onPress={() => void startSignIn(acc.id)}
                      disabled={!!busy}
                      style={({ pressed }) => [styles.accountBtn, pressed && { opacity: 0.6 }]}
                    >
                      <Feather name="log-in" size={14} color={colors.link} />
                      <Text style={{ color: colors.link, fontSize: 14, fontWeight: '500' }}>Re-authenticate</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => removeAccount(acc)}
                      disabled={!!busy}
                      style={({ pressed }) => [styles.accountBtn, pressed && { opacity: 0.6 }]}
                    >
                      <Feather name="log-out" size={14} color={colors.danger} />
                      <Text style={{ color: colors.danger, fontSize: 14, fontWeight: '500' }}>Sign out</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}

            {accounts.length > 0 && !showAddAccount && !deviceSession && !browserSession && !googleSession && (
              <Pressable
                onPress={() => {
                  setReauthAccountId(null);
                  setShowAddAccount(true);
                }}
                style={({ pressed }) => [styles.addAccountBtn, { borderColor: colors.border }, pressed && { opacity: 0.6 }]}
              >
                <Feather name="user-plus" size={16} color={colors.link} />
                <Text style={{ color: colors.link, fontSize: 15, fontWeight: '500' }}>Add another {meta.name} account</Text>
              </Pressable>
            )}

            {(showAddAccount || accounts.length === 0) && !deviceSession && !browserSession && !googleSession && (
              <View style={[styles.accountCard, { backgroundColor: colors.surface }]}>
                <Text style={[styles.signInNote, { color: colors.textSecondary }]}>
                  {accounts.length === 0
                    ? `Use your existing ${meta.subtitle.toLowerCase()} with OAuth — no API key required. Tokens stay in the device keychain.`
                    : `Sign in with another ${meta.name} account to auto load-balance usage or switch between accounts manually.`}
                </Text>
                <Pressable
                  onPress={() => void startSignIn(null)}
                  disabled={!!busy}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    { backgroundColor: colors.sendBg },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  {busy === 'auth' ? (
                    <ActivityIndicator size="small" color={colors.sendFg} />
                  ) : (
                    <Feather name="external-link" size={16} color={colors.sendFg} />
                  )}
                  <Text style={[styles.primaryBtnText, { color: colors.sendFg }]}>{meta.signInLabel}</Text>
                </Pressable>
                {accounts.length > 0 && (
                  <Pressable onPress={() => setShowAddAccount(false)} style={{ alignSelf: 'center', paddingTop: 2 }}>
                    <Text style={{ color: colors.textTertiary, fontSize: 14 }}>Cancel</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        )}

        {/* Active Codex device-code step */}
        {deviceSession && (
          <View style={[styles.stepCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.stepTitle, { color: colors.text }]}>Enter this code on OpenAI</Text>
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(deviceSession.userCode);
                void Linking.openURL(deviceSession.verificationUrl);
              }}
              style={[styles.codeBox, { backgroundColor: colors.background }]}
            >
              <Text selectable style={[styles.deviceCode, { color: colors.text }]}>
                {deviceSession.userCode}
              </Text>
              <Feather name="copy" size={16} color={colors.textSecondary} />
            </Pressable>
            <Text style={[styles.hint, { color: colors.textTertiary, marginTop: 4 }]}>
              Code copied to clipboard. Open {deviceSession.verificationUrl.replace(/^https?:\/\//, '')} and approve the
              request.
            </Text>
            <View style={styles.stepActions}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <ActivityIndicator size="small" color={colors.link} />
                <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Waiting for approval…</Text>
              </View>
              <Pressable onPress={() => void Linking.openURL(deviceSession.verificationUrl)} hitSlop={8}>
                <Text style={{ color: colors.link, fontSize: 14, fontWeight: '500' }}>Open browser</Text>
              </Pressable>
              <Pressable onPress={cancelSignIn} hitSlop={8}>
                <Text style={{ color: colors.textTertiary, fontSize: 14 }}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Active Google (Antigravity) in-app consent — code is captured from the loopback redirect. */}
        {googleSession && (
          <View style={[styles.stepCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.stepTitle, { color: colors.text }]}>Sign in with Google</Text>
            {!!googleError && (
              <Text style={[styles.hint, { color: colors.danger, marginHorizontal: 0, marginTop: 4 }]}>{googleError}</Text>
            )}
            <View style={[styles.webviewBox, { backgroundColor: colors.background }]}>
              <WebView
                source={{ uri: googleSession.authorizeUrl, headers: { 'User-Agent': ANTIGRAVITY_OAUTH.webviewUserAgent } }}
                customUserAgent={ANTIGRAVITY_OAUTH.webviewUserAgent.replace('; wv', '')}
                javaScriptEnabled
                domStorageEnabled
                sharedCookiesEnabled={false}
                onShouldStartLoadWithRequest={(request) => {
                  if (!request.url.startsWith(ANTIGRAVITY_OAUTH.redirectUri)) return request.isTopFrame !== false;
                  // Synthetic loopback redirect — never actually loads; grab ?code= and exchange it here.
                  void (async () => {
                    try {
                      const { code } = parseAntigravityCallback(request.url, googleSession.pkce.state);
                      const tokens = await exchangeAntigravityAuthCode(code, googleSession);
                      setGoogleSession(null);
                      setGoogleError('');
                      await afterSignIn(tokens, 'antigravity');
                    } catch (e) {
                      setGoogleError(e instanceof Error ? e.message : String(e));
                    }
                  })();
                  return false;
                }}
                onHttpError={(event) => {
                  if (!event.nativeEvent.url?.startsWith(ANTIGRAVITY_OAUTH.redirectUri)) {
                    setGoogleError(`Google sign-in page returned ${event.nativeEvent.statusCode}.`);
                  }
                }}
                onError={(event) => {
                  if (!event.nativeEvent.url?.startsWith(ANTIGRAVITY_OAUTH.redirectUri)) {
                    setGoogleError(event.nativeEvent.description || 'Failed to load the Google sign-in page.');
                  }
                }}
              />
            </View>
            <View style={styles.stepActions}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <ActivityIndicator size="small" color={colors.link} />
                <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Complete sign-in above…</Text>
              </View>
              <Pressable onPress={cancelSignIn} hitSlop={8}>
                <Text style={{ color: colors.textTertiary, fontSize: 14 }}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Active Claude PKCE copy-code step */}
        {browserSession && (
          <View style={[styles.stepCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.stepTitle, { color: colors.text }]}>Paste the sign-in code</Text>
            <Text style={[styles.hint, { color: colors.textTertiary, marginTop: 2, marginHorizontal: 0 }]}>
              Finish signing in in your browser, copy the code shown on the page, and paste it below.
            </Text>
            <View style={styles.addRow}>
              <Input
                value={pastedCode}
                onChangeText={setPastedCode}
                placeholder="Paste code#state"
                style={{ flex: 1, backgroundColor: colors.background }}
                onSubmitEditing={completeBrowserSignIn}
                returnKeyType="done"
              />
              <Pressable
                onPress={async () => {
                  const text = await Clipboard.getStringAsync();
                  if (text) setPastedCode(text.trim());
                }}
                style={[styles.pasteBtn, { borderColor: colors.border }]}
              >
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '500' }}>Paste</Text>
              </Pressable>
            </View>
            <View style={styles.stepActions}>
              <Pressable
                onPress={completeBrowserSignIn}
                disabled={busy === 'auth'}
                style={[styles.completeBtn, { backgroundColor: colors.sendBg }]}
              >
                {busy === 'auth' ? (
                  <ActivityIndicator size="small" color={colors.sendFg} />
                ) : (
                  <Text style={{ color: colors.sendFg, fontSize: 14, fontWeight: '600' }}>Complete sign-in</Text>
                )}
              </Pressable>
              <Pressable onPress={() => void Linking.openURL(browserSession.authorizeUrl)} hitSlop={8}>
                <Text style={{ color: colors.link, fontSize: 14, fontWeight: '500' }}>Reopen browser</Text>
              </Pressable>
              <Pressable onPress={cancelSignIn} hitSlop={8}>
                <Text style={{ color: colors.textTertiary, fontSize: 14 }}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.modelsHeader}>
          <Label>Models ({models.length})</Label>
          <Pressable onPress={fetchModels} disabled={!!busy || !accounts.length} hitSlop={8} style={styles.inlineButton}>
            {busy === 'fetch' ? (
              <ActivityIndicator size="small" color={colors.link} />
            ) : (
              <Feather name="download-cloud" size={16} color={accounts.length ? colors.link : colors.textTertiary} />
            )}
            <Text style={{ color: accounts.length ? colors.link : colors.textTertiary, fontSize: 15, fontWeight: '500' }}>
              Fetch models
            </Text>
          </Pressable>
        </View>

        <View style={styles.addRow}>
          <Input
            value={newModel}
            onChangeText={setNewModel}
            placeholder="Add model name manually"
            onSubmitEditing={addModel}
            returnKeyType="done"
            style={{ flex: 1 }}
          />
          <Pressable onPress={addModel} style={[styles.addButton, { backgroundColor: colors.sendBg }]}>
            <Feather name="plus" size={20} color={colors.sendFg} />
          </Pressable>
        </View>

        {models.length > 0 && (
          <Text style={[styles.hint, { color: colors.textTertiary }]}>
            Tap a model to edit its effort levels, lowest first, or tap its context budget to override how much history
            to keep.
          </Text>
        )}

        {models.length > 10 && (
          <Input value={modelFilter} onChangeText={setModelFilter} placeholder="Filter models" style={{ marginTop: 8 }} />
        )}

        {models.length > 0 && (
          <View style={[styles.modelList, { backgroundColor: colors.surface }]}>
            {visibleModels.slice(0, 200).map((m, i) => (
              <Pressable
                key={m}
                onPress={() => setEditing({ model: m, field: 'effort', text: (efforts[m] ?? []).join(', ') })}
                style={[styles.modelRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={[styles.modelName, { color: colors.text }]}>
                    {m}
                  </Text>
                  {editing?.model === m && editing.field === 'effort' ? (
                    <Input
                      autoFocus
                      value={editing.text}
                      onChangeText={(text) => setEditing({ ...editing, text })}
                      onSubmitEditing={commitEdit}
                      onBlur={commitEdit}
                      placeholder="low, medium, high"
                      returnKeyType="done"
                      style={[styles.effortInput, { backgroundColor: colors.background }]}
                    />
                  ) : (
                    <Text numberOfLines={1} style={[styles.effortLevels, { color: colors.textTertiary }]}>
                      {efforts[m]?.length ? `Effort: ${efforts[m].join(' · ')}` : 'No effort control'}
                    </Text>
                  )}
                  {editing?.model === m && editing.field === 'budget' ? (
                    <Input
                      autoFocus
                      value={editing.text}
                      onChangeText={(text) => setEditing({ ...editing, text })}
                      onSubmitEditing={commitEdit}
                      onBlur={commitEdit}
                      placeholder="128K, 1M… (empty for auto)"
                      returnKeyType="done"
                      style={[styles.effortInput, { backgroundColor: colors.background }]}
                    />
                  ) : (
                    <Pressable
                      onPress={() => {
                        const short = budgets[m] ? formatTokens(budgets[m]) : '';
                        const text = !short || parseTokens(short) === budgets[m] ? short : String(budgets[m]);
                        setEditing({ model: m, field: 'budget', text });
                      }}
                      hitSlop={4}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      <Text numberOfLines={1} style={[styles.effortLevels, { color: colors.textTertiary }]}>
                        Context budget: {formatTokens(resolveBudget({ baseUrl: meta.baseUrl, contexts, budgets }, m))}
                        {budgets[m] ? '' : ' (auto)'}
                      </Text>
                    </Pressable>
                  )}
                </View>
                <Pressable onPress={() => setModels(models.filter((x) => x !== m))} hitSlop={8}>
                  <Feather name="x" size={16} color={colors.textTertiary} />
                </Pressable>
              </Pressable>
            ))}
          </View>
        )}

        <Disclosure title="Advanced & CLI import">
          <Label>Display name</Label>
          <Input value={name} onChangeText={setName} placeholder={meta.name} autoCapitalize="words" />

          <Label>Import CLI credentials as {accounts.length ? 'another' : 'an'} account</Label>
          <Input
            value={importText}
            onChangeText={setImportText}
            placeholder={meta.importPlaceholder}
            multiline
            style={{ minHeight: 80, textAlignVertical: 'top', fontFamily: fonts.mono, fontSize: 13 }}
          />
          <Text style={[styles.hint, { color: colors.textTertiary }]}>{meta.importHint}</Text>
          <Pressable
            onPress={importCredentials}
            disabled={!!busy || !importText.trim()}
            style={({ pressed }) => [
              styles.secondaryBtn,
              { borderColor: colors.border, opacity: !importText.trim() ? 0.5 : pressed ? 0.6 : 1 },
            ]}
          >
            <Feather name="key" size={15} color={colors.text} />
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>Import credentials</Text>
          </Pressable>
        </Disclosure>

        <Animated.View layout={LinearTransition.duration(220)}>
          <Pressable
            onPress={testConnection}
            disabled={!!busy || !accounts.length}
            style={({ pressed }) => [
              styles.button,
              { borderColor: colors.border, opacity: !accounts.length ? 0.4 : pressed ? 0.6 : 1 },
            ]}
          >
            {busy === 'test' ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Feather name="zap" size={16} color={colors.text} />
            )}
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '500' }}>Test connection</Text>
          </Pressable>

          {status && (
            <View style={[styles.status, { backgroundColor: status.ok ? colors.surface : colors.dangerBg }]}>
              <Feather
                name={status.ok ? 'check-circle' : 'alert-circle'}
                size={16}
                color={status.ok ? colors.text : colors.danger}
              />
              <Text selectable style={{ flex: 1, color: status.ok ? colors.text : colors.danger, fontSize: 14, lineHeight: 20 }}>
                {status.text}
              </Text>
            </View>
          )}

          {savedOnce && (
            <Pressable onPress={remove} style={({ pressed }) => [styles.button, styles.delete, pressed && { opacity: 0.6 }]}>
              <Feather name="trash-2" size={16} color={colors.danger} />
              <Text style={{ color: colors.danger, fontSize: 16, fontWeight: '500' }}>Remove subscription</Text>
            </Pressable>
          )}
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 60 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 },
  providerGrid: { gap: 8 },
  providerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  providerName: { fontSize: 16, fontWeight: '600' },
  providerSub: { fontSize: 13, marginTop: 2 },
  authCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, padding: 16 },
  accountStack: { gap: 12 },
  accountCard: { borderRadius: 16, padding: 16, gap: 12 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  accountTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accountTitle: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  accountSub: { fontSize: 13, marginTop: 2 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: '600' },
  accountActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  accountBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addAccountBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingVertical: 13,
  },
  signInNote: { fontSize: 14, lineHeight: 20 },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 12,
  },
  primaryBtnText: { fontSize: 15, fontWeight: '600' },
  stepCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginTop: 12,
    gap: 10,
  },
  stepTitle: { fontSize: 15, fontWeight: '600' },
  webviewBox: {
    height: 460,
    borderRadius: 12,
    overflow: 'hidden',
  },
  codeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  deviceCode: { fontSize: 22, fontWeight: '700', letterSpacing: 2, fontFamily: fonts.mono },
  stepActions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 4 },
  pasteBtn: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completeBtn: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9 },
  modelsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  inlineButton: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  addRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  addButton: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modelList: { borderRadius: 12, marginTop: 8, overflow: 'hidden' },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  modelName: { fontSize: 15, fontFamily: fonts.mono },
  effortLevels: { fontSize: 13, marginTop: 3 },
  effortInput: { marginTop: 8, paddingVertical: 8, fontSize: 14 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 11,
    marginTop: 12,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 13,
    marginTop: 28,
  },
  status: { flexDirection: 'row', gap: 10, borderRadius: 12, padding: 12, marginTop: 12 },
  delete: { borderWidth: 0, marginTop: 16 },
});
