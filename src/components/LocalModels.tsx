import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { confirm } from '@/components/Dialogs';
import { fitOf, formatBytes, type Fit } from '@/lib/local/device';
import { cancelDownload, pauseDownload, resumeDownload } from '@/lib/local/downloads';
import { useTheme } from '@/lib/theme';
import type { Download } from '@/store/localModels';

/** Pieces shared by the on-device model screens. */

/** "unsloth/Qwen3-4B-GGUF" → "Qwen3-4B". */
export function repoTitle(repo: string) {
  const name = repo.split('/').pop() ?? repo;
  return name.replace(/[-_.]?gguf$/i, '');
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const { colors } = useTheme();
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={[styles.track, { backgroundColor: colors.border }]}>
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color ?? colors.accent }]} />
    </View>
  );
}

const FIT_LABEL: Record<Fit, string | undefined> = {
  ok: 'Fits in RAM',
  tight: 'Tight on RAM',
  over: 'Larger than RAM',
  unknown: undefined,
};

/** A short note on how a model of `bytes` fits this phone's memory, coloured by how risky it is. */
export function FitLabel({ bytes }: { bytes: number }) {
  const { colors } = useTheme();
  const fit = fitOf(bytes);
  const label = FIT_LABEL[fit];
  if (!label) return null;
  const color = fit === 'over' ? colors.danger : fit === 'tight' ? '#D97706' : colors.success;
  return (
    <View style={styles.fit}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.fitText, { color }]}>{label}</Text>
    </View>
  );
}

function IconButton({ icon, label, onPress, color }: { icon: keyof typeof Feather.glyphMap; label: string; onPress: () => void; color?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.iconButton, { backgroundColor: colors.background }, pressed && { opacity: 0.6 }]}
    >
      <Feather name={icon} size={16} color={color ?? colors.text} />
    </Pressable>
  );
}

const STATUS: Record<Download['status'], string> = {
  downloading: '',
  paused: 'Paused',
  interrupted: 'Stopped when the app closed',
  error: 'Failed',
};

/** A download in progress, with its progress and buttons to pause, resume or cancel it. */
export function DownloadRow({ download: d }: { download: Download }) {
  const { colors } = useTheme();
  const progress = d.total ? d.received / d.total : 0;
  const shards = d.files.length - (d.mmproj ? 1 : 0);
  const fileNote = d.files.length > 1 ? ` · file ${Math.min(d.files.filter((f) => f.done).length + 1, d.files.length)} of ${d.files.length}` : '';
  const status =
    d.status === 'downloading'
      ? `${formatBytes(d.received)} of ${formatBytes(d.total)} · ${Math.floor(progress * 100)}%${fileNote}`
      : `${STATUS[d.status]} · ${formatBytes(d.received)} of ${formatBytes(d.total)}`;
  const cancel = () =>
    confirm({
      title: 'Cancel download?',
      message: `${repoTitle(d.repo)} ${d.quant} and what it has downloaded so far will be removed.`,
      confirmLabel: 'Cancel download',
      cancelLabel: 'Keep',
      destructive: true,
      onConfirm: () => cancelDownload(d.id),
    });
  return (
    <View style={styles.download}>
      <Feather name="download" size={20} color={colors.textSecondary} />
      <View style={{ flex: 1, gap: 6 }}>
        <View>
          <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
            {repoTitle(d.repo)} · {d.quant}
          </Text>
          <Text numberOfLines={1} style={[styles.detail, { color: colors.textTertiary }]}>
            {status}
            {shards > 1 && d.status !== 'downloading' ? ` · ${shards} parts` : ''}
          </Text>
        </View>
        <ProgressBar value={progress} color={d.status === 'downloading' ? undefined : colors.textTertiary} />
        {d.status === 'error' && d.error ? (
          <Text style={[styles.detail, { color: colors.danger }]}>{d.error}</Text>
        ) : null}
      </View>
      {d.status === 'downloading' ? (
        <IconButton icon="pause" label="Pause download" onPress={() => pauseDownload(d.id)} />
      ) : (
        <IconButton icon={d.status === 'paused' ? 'play' : 'rotate-cw'} label="Resume download" onPress={() => resumeDownload(d.id)} />
      )}
      <IconButton icon="x" label="Cancel download" onPress={cancel} color={colors.textSecondary} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  fit: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  fitText: { fontSize: 13 },
  download: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 16 },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  iconButton: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
