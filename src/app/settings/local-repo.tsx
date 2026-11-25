import Feather from '@expo/vector-icons/Feather';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirm, notify } from '@/components/Dialogs';
import { Row, Section, ToggleRow } from '@/components/Form';
import { DownloadRow, FitLabel, repoTitle } from '@/components/LocalModels';
import { formatTokens } from '@/lib/context';
import { fitMessage, fitOf, formatBytes, freeStorage, totalRam } from '@/lib/local/device';
import { modelIdFor, startDownload, storageCheck, storageMessage } from '@/lib/local/downloads';
import { formatCount, formatParams, getRepo, recommendedQuant, type Quant, type RepoInfo } from '@/lib/local/hf';
import { useTheme } from '@/lib/theme';
import { useLocalModels } from '@/store/localModels';

/** Settings → On-device → a Hugging Face repo: its quantizations, to download one. */
export default function LocalRepoScreen() {
  const { colors } = useTheme();
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const [retry, setRetry] = useState(0);
  const key = `${id}#${retry}`;
  const [answer, setAnswer] = useState<{ key: string; repo?: RepoInfo; error?: string } | null>(null);
  const repo = answer?.key === key ? answer.repo ?? null : null;
  const error = answer?.key === key ? answer.error ?? null : null;
  const [withProjector, setWithProjector] = useState(true);
  const models = useLocalModels((s) => s.models);
  const downloads = useLocalModels((s) => s.downloads);

  useEffect(() => {
    const controller = new AbortController();
    getRepo(id, controller.signal)
      .then((info) => setAnswer({ key, repo: info }))
      .catch((e) => {
        if (!controller.signal.aborted) setAnswer({ key, error: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [id, key]);

  const projector = repo?.mmproj && withProjector ? repo.mmproj.size : 0;
  const recommended = useMemo(
    () => (repo ? recommendedQuant(repo.quants, (bytes) => fitOf(bytes + projector) === 'ok') : undefined),
    [repo, projector]
  );
  const repoDownloads = Object.values(downloads).filter((d) => d.repo === id);

  const download = (q: Quant) => {
    if (!repo) return;
    const bytes = q.size + projector;
    const check = storageCheck(bytes);
    if (!check.ok) return notify('Not enough storage', storageMessage(check.free, check.need));
    const go = () => startDownload(repo, q, withProjector && !!repo.mmproj);
    const fit = fitOf(bytes);
    const free = freeStorage();
    if (fit === 'over' || fit === 'tight') {
      return confirm({
        title: fit === 'over' ? 'Larger than this phone’s RAM' : 'Tight on memory',
        message: `${q.label} is ${formatBytes(bytes)}. ${fitMessage(fit)}${
          recommended && recommended.key !== q.key ? `\n\n${recommended.label} (${formatBytes(recommended.size + projector)}) should run better.` : ''
        }`,
        confirmLabel: 'Download anyway',
        destructive: fit === 'over',
        onConfirm: go,
      });
    }
    confirm({
      title: `Download ${q.label}?`,
      message: `${formatBytes(bytes)} from Hugging Face${free != null ? `, leaving about ${formatBytes(free - bytes)} free` : ''}. Use Wi-Fi for large models.`,
      confirmLabel: 'Download',
      onConfirm: go,
    });
  };

  const ram = totalRam();
  const facts = repo
    ? [
        repo.params ? `${formatParams(repo.params)} parameters` : undefined,
        repo.architecture,
        repo.contextLength ? `${formatTokens(repo.contextLength)} context` : undefined,
        repo.mmproj ? 'Vision' : undefined,
        `${formatCount(repo.downloads)} downloads`,
      ].filter(Boolean)
    : [];

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: repoTitle(id) }} />
      <Text style={[styles.repo, { color: colors.textTertiary }]} selectable>
        {id}
      </Text>

      {error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.danger, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>{error}</Text>
          <Pressable onPress={() => setRetry((n) => n + 1)} hitSlop={8}>
            <Text style={{ color: colors.link, fontSize: 15, fontWeight: '500' }}>Try again</Text>
          </Pressable>
        </View>
      ) : !repo ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={colors.textSecondary} />
      ) : (
        <>
          {facts.length > 0 && <Text style={[styles.facts, { color: colors.textSecondary }]}>{facts.join(' · ')}</Text>}
          {repo.gated && (
            <View style={[styles.notice, { backgroundColor: colors.surface }]}>
              <Feather name="lock" size={16} color={colors.textSecondary} />
              <Text style={{ flex: 1, color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>
                This repo is gated. Accept its terms on huggingface.co, then add your access token in On-device settings.
              </Text>
            </View>
          )}

          {repoDownloads.length > 0 && (
            <Section title="Downloading">
              {repoDownloads.map((d) => (
                <DownloadRow key={d.id} download={d} />
              ))}
            </Section>
          )}

          {repo.mmproj && (
            <Section footer="Lets the model see images you attach. Downloaded alongside the quantization you pick.">
              <ToggleRow
                icon="image"
                title="Include vision projector"
                detail={`Adds ${formatBytes(repo.mmproj.size)}`}
                value={withProjector}
                onValueChange={setWithProjector}
              />
            </Section>
          )}

          {repo.quants.length ? (
            <Section
              title="Quantizations"
              footer={`Smaller quantizations download and run faster at some cost to quality; Q4_K_M is a good balance. A model needs about its size in free memory, plus room for its context${ram ? `. This phone has ${formatBytes(ram)} of RAM` : ''}.`}
            >
              {repo.quants.map((q) => {
                const modelId = modelIdFor(repo.id, q.label);
                const have = models.some((m) => m.id === modelId);
                const pending = downloads[modelId];
                const bytes = q.size + projector;
                return (
                  <Row
                    key={q.key}
                    icon={have ? 'check-circle' : 'box'}
                    title={q.label}
                    detail={[
                      formatBytes(bytes),
                      q.files.length > 1 ? `${q.files.length} parts` : undefined,
                      recommended?.key === q.key && !have ? 'Recommended' : undefined,
                      have ? 'Downloaded' : pending ? 'Downloading' : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    trailing={() =>
                      have || pending ? null : (
                        <View style={styles.trailing}>
                          <FitLabel bytes={bytes} />
                          <Feather name="download" size={18} color={colors.link} />
                        </View>
                      )
                    }
                    onPress={have ? () => router.push('/settings/local') : pending ? undefined : () => download(q)}
                  />
                );
              })}
            </Section>
          ) : (
            <Text style={[styles.facts, { color: colors.textTertiary }]}>This repo has no GGUF files.</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 60 },
  repo: { fontSize: 13, marginHorizontal: 16, marginBottom: 6 },
  facts: { fontSize: 14, lineHeight: 20, marginHorizontal: 16, marginBottom: 24 },
  center: { alignItems: 'center', gap: 12, marginTop: 32, paddingHorizontal: 16 },
  notice: { flexDirection: 'row', gap: 10, borderRadius: 12, padding: 12, marginBottom: 24 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
