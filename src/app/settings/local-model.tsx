import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirm } from '@/components/Dialogs';
import { Row, Section, ToggleRow } from '@/components/Form';
import { FitLabel, repoTitle } from '@/components/LocalModels';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Slider } from '@/components/Slider';
import { formatTokens } from '@/lib/context';
import { fitMessage, fitOf, formatBytes, totalRam } from '@/lib/local/device';
import { deleteModel } from '@/lib/local/downloads';
import { inspectModel } from '@/lib/local/runtime';
import { useTheme } from '@/lib/theme';
import {
  contextFor,
  contextSteps,
  KV_CACHE_TYPES,
  kvCacheBytes,
  LOCAL_ENDPOINT_ID,
  maxContext,
  useLocalModels,
  type KvCacheType,
} from '@/store/localModels';
import { useSettings } from '@/store/settings';

const CACHE_FOOTERS: Record<KvCacheType, string> = {
  f16: 'Full precision. The most memory, and the safest choice for quality.',
  q8_0: 'About half the memory of F16, with hardly any loss in quality. Turns on flash attention.',
  q4_0: 'About a quarter of the memory of F16. Long chats may get less accurate. Turns on flash attention.',
};

/** Settings → On-device → a downloaded model: its context length, KV cache, and deleting it. */
export default function LocalModelScreen() {
  const { colors } = useTheme();
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const model = useLocalModels((s) => s.models.find((m) => m.id === id));
  const active = useSettings((s) => s.active);

  // The memory estimate needs the model's attention shape, read from its file header once.
  useEffect(() => {
    if (model && !model.kv) void inspectModel(model);
  }, [model]);

  if (!model) {
    return (
      <View style={[styles.gone, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: '' }} />
        <Text style={{ color: colors.textTertiary, fontSize: 15 }}>This model is no longer on the phone.</Text>
      </View>
    );
  }

  const steps = contextSteps(model);
  const context = contextFor(model);
  // The step at or just under the current context, so a value from elsewhere still lands on the slider.
  const index = Math.max(0, steps.reduce((best, n, i) => (n <= context ? i : best), 0));
  const cache = model.cacheType ?? 'f16';
  const kv = kvCacheBytes(model, context, cache);
  const total = model.size + (kv ?? 0);
  const fit = fitOf(total);
  const ram = totalRam();
  const selected = active?.endpointId === LOCAL_ENDPOINT_ID && active.model === model.id;

  // Read from the store rather than from render, since a drag can outlive the render it began in.
  const setContext = (i: number) => useLocalModels.getState().updateModel(id, { context: steps[i] });
  const setCache = (type: KvCacheType) => useLocalModels.getState().updateModel(id, { cacheType: type });

  const remove = () =>
    confirm({
      title: 'Delete model?',
      message: `${repoTitle(model.repo)} ${model.quant} (${formatBytes(model.size)}) will be removed from this phone. You can download it again later.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        router.back();
        void deleteModel(model.id);
      },
    });

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: repoTitle(model.repo) }} />
      <Text style={[styles.intro, { color: colors.textTertiary }]} selectable>
        {model.repo} · {model.quant}
        {model.mmproj ? ' · Vision' : ''}
      </Text>

      <Section
        title="Memory"
        footer={
          fitMessage(fit) ??
          (kv == null
            ? 'The context cache size shows once the model has been read; open this again after using the model if it stays unknown.'
            : ram
              ? `This phone has ${formatBytes(ram)} of RAM.`
              : undefined)
        }
      >
        <Row icon="box" title="Model" value={formatBytes(model.size)} />
        <Row icon="layers" title="Context cache" detail={`${formatTokens(context)} tokens at ${cache.toUpperCase()}`} value={kv == null ? 'Unknown' : `≈ ${formatBytes(kv)}`} />
        <Row
          icon="cpu"
          title="Total"
          value={`${kv == null ? '≥ ' : '≈ '}${formatBytes(total)}`}
          trailing={() => <FitLabel bytes={total} />}
        />
      </Section>

      <Section
        title="Context length"
        footer={`How much of the chat the model can read at once, up to the ${formatTokens(maxContext(model))} it was ${
          model.contextLength ? 'trained for' : 'assumed to handle'
        }. Longer contexts take more memory and make the model slower to load.`}
      >
        <View style={styles.card}>
          <Text style={[styles.value, { color: colors.text }]}>
            {formatTokens(context)}
            <Text style={[styles.unit, { color: colors.textTertiary }]}> tokens</Text>
          </Text>
          {steps.length > 1 ? (
            <Slider
              value={index}
              min={0}
              max={steps.length - 1}
              step={1}
              format={(i) => `${formatTokens(steps[i])} tokens`}
              accessibilityLabel="Context length"
              onChange={setContext}
            />
          ) : null}
        </View>
      </Section>

      <Section
        title="Tools"
        footer={
          model.tools
            ? 'Chats give this model the file, code, web and phone tools. Their instructions add several thousand tokens to every prompt, so replies start much later and generate more slowly on a phone.'
            : 'Off: chats with this model get a short prompt and no tools, so replies start sooner and generate faster. Small models rarely use tools well.'
        }
      >
        <ToggleRow
          icon="tool"
          title="Use tools"
          value={!!model.tools}
          onValueChange={(on) => useLocalModels.getState().updateModel(id, { tools: on })}
        />
      </Section>

      <Section title="KV cache" footer={CACHE_FOOTERS[cache]}>
        <View style={styles.segment}>
          <SegmentedControl options={KV_CACHE_TYPES} value={cache} onChange={setCache} />
        </View>
      </Section>

      <Section footer="Changes apply the next time the model loads.">
        <Row
          icon="check-circle"
          title="Use in new chats"
          selected={selected}
          onPress={() => useSettings.getState().setActive({ endpointId: LOCAL_ENDPOINT_ID, model: model.id })}
        />
        <Row
          icon="download-cloud"
          title="Other quantizations"
          onPress={() => router.push({ pathname: '/settings/local-repo', params: { id: model.repo } })}
        />
        <Row icon="trash-2" title="Delete from phone" detail={`Frees ${formatBytes(model.size)}`} tint="danger" onPress={remove} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  intro: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginBottom: 24 },
  gone: { flex: 1, alignItems: 'center', paddingTop: 48 },
  card: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8, gap: 6 },
  value: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  unit: { fontSize: 15, fontWeight: '400' },
  segment: { padding: 12 },
});
