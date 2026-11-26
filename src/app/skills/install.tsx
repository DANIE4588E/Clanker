import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { confirm, notify } from '@/components/Dialogs';
import { Row, Section } from '@/components/Form';
import { findSkills, installPackage, pickSkillFile, type SkillPackage } from '@/lib/skills/install';
import { useTheme } from '@/lib/theme';
import { useSkills } from '@/store/skills';

const SUGGESTED = [{ source: 'anthropics/skills', detail: "Anthropic's example skills: documents, design, testing and more" }];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Finds skills in a GitHub repository, a link or a file, and installs the ones picked. */
export default function InstallSkillScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const installed = useSkills((s) => s.skills);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<'finding' | 'installing' | null>(null);
  const [error, setError] = useState('');
  const [found, setFound] = useState<SkillPackage[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const show = (packages: SkillPackage[]) => {
    setFound(packages);
    // A lone skill is picked already; from a collection, the user chooses.
    setPicked(new Set(packages.length === 1 ? [packages[0].name] : []));
  };

  const find = async (from = source) => {
    if (busy) return;
    setSource(from);
    setError('');
    setFound(null);
    setBusy('finding');
    try {
      show(await findSkills(from));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const pickFile = async () => {
    setError('');
    try {
      const packages = await pickSkillFile();
      if (packages.length) show(packages);
    } catch (e) {
      setError(message(e));
    }
  };

  const toggle = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setPicked(next);
  };

  const install = async () => {
    const chosen = (found ?? []).filter((p) => picked.has(p.name));
    setBusy('installing');
    const failed: string[] = [];
    const done: string[] = [];
    for (const pkg of chosen) {
      try {
        await installPackage(pkg, true);
        done.push(pkg.name);
      } catch (e) {
        failed.push(`${pkg.name}: ${message(e)}`);
      }
    }
    setBusy(null);
    if (failed.length) {
      notify(done.length ? `Installed ${done.length}, ${failed.length} failed` : "Couldn't install", failed.join('\n'));
      return;
    }
    if (done.length === 1) router.replace({ pathname: '/skills/skill', params: { name: done[0] } });
    else router.back();
  };

  const confirmInstall = () => {
    const replacing = (found ?? []).filter((p) => picked.has(p.name) && installed[p.name]).map((p) => p.name);
    if (!replacing.length) return void install();
    confirm({
      title: replacing.length === 1 ? `Replace "${replacing[0]}"?` : `Replace ${replacing.length} skills?`,
      message: `${replacing.length === 1 ? 'A skill' : 'Skills'} with ${replacing.length === 1 ? 'this name is' : 'these names are'} already installed: ${replacing.join(', ')}. Installing replaces ${replacing.length === 1 ? 'it' : 'them'}, along with any changes made since.`,
      confirmLabel: 'Replace',
      destructive: true,
      onConfirm: () => void install(),
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.intro, { color: colors.textTertiary }]}>
          Skills use the SKILL.md format shared by Claude Code, Hermes Agent and other agents, so most published skills work
          here. Only install skills from sources you trust: models follow their instructions and may run their scripts.
        </Text>

        <View style={[styles.search, { backgroundColor: colors.surface }]}>
          <Feather name="github" size={16} color={colors.textTertiary} />
          <TextInput
            value={source}
            onChangeText={setSource}
            onSubmitEditing={() => find()}
            placeholder="owner/repo, or a link"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="search"
            style={[styles.searchInput, { color: colors.text }]}
          />
          <Pressable
            onPress={() => find()}
            disabled={!source.trim() || !!busy}
            hitSlop={8}
            style={[styles.find, { backgroundColor: colors.sendBg, opacity: source.trim() && !busy ? 1 : 0.4 }]}
            accessibilityLabel="Find skills"
          >
            <Feather name="arrow-right" size={18} color={colors.sendFg} />
          </Pressable>
        </View>

        {!found && !busy && (
          <>
            <Section title="Suggested">
              {SUGGESTED.map((s) => (
                <Row key={s.source} icon="github" title={s.source} detail={s.detail} onPress={() => find(s.source)} />
              ))}
            </Section>
            <Section footer="A .zip or .skill archive holding one or more skill folders, or a single SKILL.md.">
              <Row icon="file-plus" title="Choose a file" onPress={pickFile} />
            </Section>
          </>
        )}

        {busy === 'finding' && (
          <View style={styles.status}>
            <ActivityIndicator color={colors.textTertiary} />
            <Text style={{ color: colors.textTertiary }}>Looking for skills…</Text>
          </View>
        )}
        {!!error && <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>}

        {found && (
          <Section
            title={found.length === 1 ? 'Found 1 skill' : `Found ${found.length} skills`}
            footer={found.length > 1 ? 'Pick the skills to install.' : undefined}
          >
            {found.map((p) => (
              <Row
                key={p.name}
                icon={picked.has(p.name) ? 'check-square' : 'square'}
                title={p.name}
                detail={p.description || 'No description'}
                value={installed[p.name] ? 'Installed' : undefined}
                onPress={() => toggle(p.name)}
                chevron={false}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked.has(p.name) }}
              />
            ))}
          </Section>
        )}
      </ScrollView>

      {found && (
        <View
          style={[
            styles.bar,
            { borderTopColor: colors.border, backgroundColor: colors.background, paddingBottom: insets.bottom + 12 },
          ]}
        >
          <Pressable onPress={() => setFound(null)} style={styles.secondary} disabled={!!busy}>
            <Text style={{ color: colors.textSecondary, fontSize: 16 }}>Back</Text>
          </Pressable>
          <Pressable
            onPress={confirmInstall}
            disabled={!picked.size || !!busy}
            style={[styles.primary, { backgroundColor: colors.sendBg, opacity: picked.size && !busy ? 1 : 0.4 }]}
          >
            {busy === 'installing' ? (
              <ActivityIndicator color={colors.sendFg} />
            ) : (
              <Text style={{ color: colors.sendFg, fontSize: 16, fontWeight: '600' }}>
                {picked.size > 1 ? `Install ${picked.size} skills` : 'Install'}
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  intro: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginBottom: 20 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingLeft: 12, padding: 4, marginBottom: 24 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 7 },
  find: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 24 },
  error: { fontSize: 14, lineHeight: 20, marginHorizontal: 16, marginBottom: 16 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  secondary: { paddingHorizontal: 16, paddingVertical: 12 },
  primary: { minWidth: 120, alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 999 },
});
