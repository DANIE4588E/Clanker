import Feather from '@expo/vector-icons/Feather';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { newModels } from '@/lib/providers/modelImport';
import type { ModelInfo, ModelList } from '@/lib/providers/types';
import { useTheme } from '@/lib/theme';

export type FetchedProviderModels = ModelList & { source?: string };
export type LoadProviderModels = () => Promise<FetchedProviderModels>;

export function FetchModelsDialog({
  load,
  addedModels,
  onAdd,
  onClose,
}: {
  load: LoadProviderModels;
  addedModels: string[];
  onAdd: (selected: ModelInfo[], result: FetchedProviderModels) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const [result, setResult] = useState<FetchedProviderModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState(() => new Set<string>());
  const request = useRef<Promise<FetchedProviderModels> | null>(null);

  useEffect(() => {
    let active = true;
    request.current ??= load();
    void request.current.then(
      (value) => {
        if (active) setResult(value);
      },
      (reason: unknown) => {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message || 'Could not fetch models.');
      }
    );
    return () => {
      active = false;
    };
  }, [load]);

  const available = useMemo(() => (result ? newModels(addedModels, result.models) : []), [addedModels, result]);
  const selected = useMemo(() => available.filter(({ id }) => !unchecked.has(id)), [available, unchecked]);
  const allSelected = selected.length === available.length;
  const loading = !result && error === null;
  const emptyMessage = result?.models.length ? 'All fetched models are already added.' : 'No models found.';
  const toggle = (id: string) => {
    setUnchecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={styles.center}>
        <Pressable
          accessible={false}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
          onPress={onClose}
        />
        <View
          accessibilityViewIsModal
          style={[styles.dialog, { backgroundColor: colors.background, borderColor: colors.border }]}
        >
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Select models</Text>

          {result && available.length > 0 ? (
            <>
              <View style={styles.actions}>
                <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
                  {selected.length} of {available.length} selected
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setUnchecked(allSelected ? new Set(available.map(({ id }) => id)) : new Set())}
                  style={styles.button}
                >
                  <Text style={[styles.buttonText, { color: colors.link }]}>
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </Text>
                </Pressable>
              </View>
              <FlatList
                style={[styles.list, { borderColor: colors.border }]}
                data={available}
                extraData={unchecked}
                keyExtractor={({ id }) => id}
                ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />}
                renderItem={({ item: { id } }) => {
                  const checked = !unchecked.has(id);
                  return (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={id}
                      accessibilityState={{ checked }}
                      onPress={() => toggle(id)}
                      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }]}
                    >
                      <Feather name={checked ? 'check-square' : 'square'} size={20} color={checked ? colors.link : colors.textSecondary} />
                      <Text style={[styles.model, { color: colors.text }]}>{id}</Text>
                    </Pressable>
                  );
                }}
              />
            </>
          ) : (
            <View style={styles.message}>
              {loading && <ActivityIndicator size="small" color={colors.link} />}
              <Text
                selectable={error !== null}
                accessibilityLiveRegion="polite"
                style={{ color: error === null ? colors.textSecondary : colors.danger, flex: 1 }}
              >
                {loading ? 'Fetching models…' : error ?? emptyMessage}
              </Text>
            </View>
          )}

          <View style={styles.footer}>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.button}>
              <Text style={[styles.buttonText, { color: colors.textSecondary }]}>
                {error !== null || (result && !available.length) ? 'Close' : 'Cancel'}
              </Text>
            </Pressable>
            {result && available.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !selected.length }}
                disabled={!selected.length}
                onPress={() => onAdd(selected, result)}
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: colors.sendBg, opacity: !selected.length ? 0.4 : pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[styles.buttonText, { color: colors.sendFg }]}>
                  Add {selected.length} {selected.length === 1 ? 'model' : 'models'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 480, maxHeight: '85%', padding: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12 },
  title: { fontSize: 19, fontWeight: '600', marginBottom: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' },
  list: { flexGrow: 0, flexShrink: 1, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, paddingVertical: 10 },
  model: { flex: 1, fontSize: 15 },
  message: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
