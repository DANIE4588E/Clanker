import Feather from '@expo/vector-icons/Feather';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Disclosure, Input, Label, Row, Section, ToggleRow } from '@/components/Form';
import { DownloadRow, FitLabel, repoTitle } from '@/components/LocalModels';
import { fitOf, formatBytes, freeStorage, totalRam } from '@/lib/local/device';
import { hfToken } from '@/lib/local/hf';
import { runtimeAvailable, unloadAll } from '@/lib/local/runtime';
import { formatTokens } from '@/lib/context';
import { useTheme } from '@/lib/theme';
import { contextFor, kvCacheBytes, useLocalModels } from '@/store/localModels';

/** Settings → Providers → On-device: downloaded GGUF models, downloads, and how models run. */
export default function LocalModelsScreen() {
  const { colors } = useTheme();
  const models = useLocalModels((s) => s.models);
  const downloads = useLocalModels((s) => s.downloads);
  const gpu = useLocalModels((s) => s.gpu);
  const vision = useLocalModels((s) => s.vision);
  // Bumped to read free space again on focus, such as back from deleting a model.
  const [storageTick, setStorageTick] = useState(0);
  const [token, setToken] = useState('');
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const ram = totalRam();
  const available = runtimeAvailable();
  const list = Object.values(downloads).sort((a, b) => a.startedAt - b.startedAt);
  const used = models.reduce((n, m) => n + m.size, 0);

  useFocusEffect(useCallback(() => setStorageTick((n) => n + 1), []));
  // Free space also moves as downloads land.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const free = useMemo(() => freeStorage(), [storageTick, models.length, list.length]);

  useEffect(() => {
    hfToken.get().then((t) => {
      if (t) setToken(t);
      setTokenLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (!tokenLoaded) return;
    const timer = setTimeout(() => void hfToken.set(token), 400);
    return () => clearTimeout(timer);
  }, [token, tokenLoaded]);

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.notice, { backgroundColor: colors.surface }]}>
          <Feather name="alert-triangle" size={16} color={colors.textSecondary} />
          <Text style={{ flex: 1, color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>
            <Text style={{ fontWeight: '600', color: colors.text }}>Experimental.</Text> Running models on the phone is new:
            speed and memory use vary a lot between phones and models, and some models may not load or reply correctly.
          </Text>
        </View>

        {!available && (
          <View style={[styles.notice, { backgroundColor: colors.dangerBg }]}>
            <Feather name="alert-circle" size={16} color={colors.danger} />
            <Text style={{ flex: 1, color: colors.danger, fontSize: 14, lineHeight: 20 }}>
              This build of Clanker doesn&apos;t include the on-device runtime. You can download models now, but running them
              needs a newer build of the app.
            </Text>
          </View>
        )}

        <Section title="This phone">
          <Row icon="cpu" title="Memory" value={ram ? formatBytes(ram) : 'Unknown'} />
          <Row
            icon="hard-drive"
            title="Free storage"
            value={free != null ? formatBytes(free) : 'Unknown'}
            detail={used ? `Models use ${formatBytes(used)}` : undefined}
          />
        </Section>

        {list.length > 0 && (
          <Section title="Downloading" footer="Keep Clanker open while models download. Downloads stopped by closing the app can be resumed.">
            {list.map((d) => (
              <DownloadRow key={d.id} download={d} />
            ))}
          </Section>
        )}

        <Section
          title="Models"
          footer={
            models.length
              ? 'Downloaded models appear under On-device in the model picker. Tap one to set its context length and KV cache, or to delete it.'
              : 'Download GGUF models from Hugging Face to chat without a connection. Smaller quantizations load faster and need less memory.'
          }
        >
          {[...models]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((m) => {
              // The weights plus the KV cache at its context, where that can be worked out.
              const need = m.size + (kvCacheBytes(m, contextFor(m), m.cacheType) ?? 0);
              return (
                <Row
                  key={m.id}
                  icon="smartphone"
                  title={repoTitle(m.repo)}
                  detail={[m.quant, formatBytes(m.size), `${formatTokens(contextFor(m))} context`, m.mmproj ? 'Vision' : undefined]
                    .filter(Boolean)
                    .join(' · ')}
                  trailing={() => (fitOf(need) === 'ok' ? null : <FitLabel bytes={need} />)}
                  onPress={() => router.push({ pathname: '/settings/local-model', params: { id: m.id } })}
                />
              );
            })}
          <Row icon="search" title="Browse Hugging Face" tint="link" onPress={() => router.push('/settings/local-browse')} />
        </Section>

        <Section
          title="Performance"
          footer="GPU offload uses Metal on iPhone and OpenCL on recent Snapdragon (Adreno) phones, where it is tuned mainly for Q4_0 and Q8_0 models; other quantizations can run slower on it than on the CPU. If replies come out garbled or the app closes, turn it off."
        >
          <ToggleRow
            icon="zap"
            title="Use GPU"
            value={gpu}
            onValueChange={(on) => {
              useLocalModels.getState().setGpu(on);
              void unloadAll();
            }}
          />
          <ToggleRow
            icon="image"
            title="Vision"
            detail="Load the image projector with models that have one"
            value={vision}
            onValueChange={(on) => {
              useLocalModels.getState().setVision(on);
              void unloadAll();
            }}
          />
        </Section>

        <Disclosure title="Hugging Face token" initiallyOpen={!!token}>
          <Label>Access token</Label>
          <Input value={token} onChangeText={setToken} placeholder="hf_… (optional)" secureTextEntry />
          <Text style={[styles.hint, { color: colors.textTertiary }]}>
            Needed only for gated repos, after accepting their terms on huggingface.co. Stays in the device keychain.
          </Text>
        </Disclosure>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 60 },
  notice: { flexDirection: 'row', gap: 10, borderRadius: 12, padding: 12, marginBottom: 24 },
  hint: { fontSize: 13, lineHeight: 18, marginTop: 6, marginHorizontal: 4 },
});
