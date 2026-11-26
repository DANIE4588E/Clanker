import Feather from '@expo/vector-icons/Feather';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Row, Section, ToggleRow } from '@/components/Form';
import { addSkill, SKILL_ICONS } from '@/components/SkillActions';
import { friendlyModelName } from '@/lib/modelNames';
import { useTheme } from '@/lib/theme';
import { resolveTaskModel, useSettings } from '@/store/settings';
import { useSkills } from '@/store/skills';

/** Every skill, with switches for which ones models are offered and for learning new ones. */
export default function SkillsScreen() {
  const { colors } = useTheme();
  const skills = useSkills((s) => s.skills);
  const setEnabled = useSkills((s) => s.setEnabled);
  const learn = useSettings((s) => s.skillsAuto);
  const setLearn = useSettings((s) => s.setSkillsAuto);
  const tools = useSettings((s) => s.tools);
  const skillModel = useSettings((s) => resolveTaskModel(s.endpoints, s.skillModel)?.model);
  const friendly = useSettings((s) => s.friendlyModelNames);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(skills)
      .filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  }, [skills, query]);
  const total = Object.keys(skills).length;
  const on = Object.values(skills).filter((s) => s.enabled).length;

  const open = (name: string) => router.push({ pathname: '/skills/skill', params: { name } });
  const modelName = skillModel && (friendly ? friendlyModelName(skillModel) || skillModel : skillModel);

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={addSkill} hitSlop={10} accessibilityLabel="Add skill">
              <Feather name="plus" size={24} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <Text style={[styles.intro, { color: colors.textTertiary }]}>
        {'Skills teach models how to do particular kinds of task: the steps, scripts and know-how that worked before. ' +
          "Models see each skill's description and load the whole skill when a task calls for it." +
          (tools ? '' : ' Turn on files & code in Settings → Agent for models to use them.')}
      </Text>

      <Section footer="After a reply with five or more tool calls, one extra request asks a model whether the task is worth keeping as a skill, or showed a skill it used to be wrong. Models with tools can also save and fix skills as they work.">
        <ToggleRow
          icon="zap"
          title="Learn from tasks"
          detail={modelName ? `Save and improve skills, with ${modelName}` : 'Models save and improve skills as they work'}
          value={learn}
          onValueChange={setLearn}
          onPress={() => router.push({ pathname: '/settings/task-model', params: { task: 'skills' } })}
        />
      </Section>

      {total > 4 && (
        <View style={[styles.search, { backgroundColor: colors.surface }]}>
          <Feather name="search" size={16} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search skills"
            placeholderTextColor={colors.textTertiary}
            style={[styles.searchInput, { color: colors.text }]}
          />
        </View>
      )}

      <Section title={total ? `Skills · ${on} of ${total} on` : 'Skills'} footer={total ? 'Tap a skill to read, edit or remove it.' : undefined}>
        {list.map((s) => (
          <ToggleRow
            key={s.name}
            icon={SKILL_ICONS[s.source]}
            title={s.name}
            detail={s.description}
            muted={!s.enabled}
            value={s.enabled}
            onValueChange={(v) => setEnabled(s.name, v)}
            onPress={() => open(s.name)}
          />
        ))}
        {!total && (
          <View style={styles.empty}>
            <Feather name="book-open" size={24} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
              No skills yet. Install some, write your own, or let models learn them from your tasks.
            </Text>
          </View>
        )}
        {!!total && !list.length && <Text style={[styles.none, { color: colors.textTertiary }]}>No skills found</Text>}
        <Row icon="plus" title="Add skill" tint="link" onPress={addSkill} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  intro: { fontSize: 13, lineHeight: 18, marginHorizontal: 16, marginBottom: 24 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, marginBottom: 16 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 9 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 28, paddingHorizontal: 28 },
  emptyText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  none: { textAlign: 'center', paddingVertical: 20, fontSize: 14 },
});
