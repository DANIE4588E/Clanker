import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Chip, Input } from '@/components/Form';
import { repoTitle } from '@/components/LocalModels';
import { SegmentedControl } from '@/components/SegmentedControl';
import { formatCount, searchModels, type HfModel, type HfSort } from '@/lib/local/hf';
import { useTheme } from '@/lib/theme';
import { useLocalModels } from '@/store/localModels';

const SORTS: { value: HfSort; label: string }[] = [
  { value: 'trendingScore', label: 'Trending' },
  { value: 'downloads', label: 'Popular' },
  { value: 'likes', label: 'Liked' },
  { value: 'lastModified', label: 'Recent' },
];

/** Accounts that publish well-made GGUF quantizations of most new models. */
const SOURCES: { author?: string; label: string }[] = [
  { label: 'All' },
  { author: 'unsloth', label: 'Unsloth' },
  { author: 'bartowski', label: 'bartowski' },
  { author: 'ggml-org', label: 'ggml-org' },
  { author: 'lmstudio-community', label: 'LM Studio' },
];

const isVision = (m: HfModel) => m.pipeline === 'image-text-to-text' || m.tags.includes('image-text-to-text');

/** Settings → On-device → Browse: GGUF repos on Hugging Face, searchable and sorted. */
export default function LocalBrowseScreen() {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<HfSort>('trendingScore');
  const [author, setAuthor] = useState<string | undefined>();
  const [retry, setRetry] = useState(0);
  const installed = useLocalModels((s) => s.models);
  // Results remember the search they answer, so a newer search shows as loading until it lands.
  const key = JSON.stringify([query, sort, author ?? '', retry]);
  const [answer, setAnswer] = useState<{ key: string; results: HfModel[]; error?: string } | null>(null);
  const loading = answer?.key !== key;
  const results = loading ? [] : answer.results;
  const error = loading ? null : answer.error;

  useEffect(() => {
    const controller = new AbortController();
    // Waits for typing to settle before asking the Hub.
    const timer = setTimeout(
      () => {
        searchModels({ query, sort, author, signal: controller.signal })
          .then((list) => setAnswer({ key, results: list }))
          .catch((e) => {
            if (!controller.signal.aborted) setAnswer({ key, results: [], error: e instanceof Error ? e.message : String(e) });
          });
      },
      query ? 350 : 0
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, query, sort, author]);

  const header = (
    <View style={styles.header}>
      <View>
        <Input value={query} onChangeText={setQuery} placeholder="Search GGUF models, e.g. qwen, gemma" returnKeyType="search" style={{ paddingLeft: 40 }} />
        <View style={styles.searchIcon} pointerEvents="none">
          <Feather name="search" size={18} color={colors.textTertiary} />
        </View>
      </View>
      <SegmentedControl options={SORTS} value={sort} onChange={setSort} />
      <View style={styles.chips}>
        {SOURCES.map((s) => (
          <Chip key={s.label} label={s.label} selected={author === s.author} onPress={() => setAuthor(s.author)} />
        ))}
      </View>
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      data={results}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={header}
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator style={{ marginTop: 32 }} color={colors.textSecondary} />
        ) : error ? (
          <View style={styles.empty}>
            <Text style={{ color: colors.danger, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>{error}</Text>
            <Pressable onPress={() => setRetry((n) => n + 1)} hitSlop={8}>
              <Text style={{ color: colors.link, fontSize: 15, fontWeight: '500' }}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={[styles.emptyText, { color: colors.textTertiary }]}>No GGUF models found.</Text>
        )
      }
      renderItem={({ item, index }) => {
        const owner = item.id.split('/')[0];
        const have = installed.filter((m) => m.repo === item.id).length;
        const first = index === 0;
        const last = index === results.length - 1;
        return (
          <Pressable
            onPress={() => router.push({ pathname: '/settings/local-repo', params: { id: item.id } })}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? colors.surfaceHover : colors.surface },
              first && styles.top,
              last && styles.bottom,
              !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
                {repoTitle(item.id)}
              </Text>
              <Text numberOfLines={1} style={[styles.detail, { color: colors.textTertiary }]}>
                {[owner, `${formatCount(item.downloads)} downloads`, `${formatCount(item.likes)} likes`, isVision(item) ? 'Vision' : undefined]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            {have > 0 && <Feather name="check-circle" size={16} color={colors.success} />}
            <Feather name="chevron-right" size={18} color={colors.textTertiary} />
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  header: { gap: 12, marginBottom: 16 },
  searchIcon: { position: 'absolute', left: 14, top: 0, bottom: 0, justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56 },
  top: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  bottom: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  title: { fontSize: 16 },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  empty: { alignItems: 'center', gap: 12, marginTop: 32, paddingHorizontal: 16 },
  emptyText: { textAlign: 'center', marginTop: 32, fontSize: 14 },
});
