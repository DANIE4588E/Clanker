import Feather from '@expo/vector-icons/Feather';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { notify } from '@/components/Dialogs';
import {
  buildSkillMd,
  MAX_DESCRIPTION_CHARS,
  MAX_SKILL_CHARS,
  parseSkillMd,
  readSkillMd,
  saveSkill,
  slugify,
  updateSkillMd,
  withSkillFields,
} from '@/lib/skills';
import { useTheme } from '@/lib/theme';
import { useSkills } from '@/store/skills';

function initial(name: string | undefined) {
  if (!name) return { description: '', body: '' };
  try {
    const parsed = parseSkillMd(readSkillMd(name));
    return { description: parsed.description, body: parsed.body };
  } catch {
    return { description: '', body: '' };
  }
}

/** Writes a new skill, or edits one's description and instructions (with a `name` param). */
export default function EditSkillScreen() {
  const { colors } = useTheme();
  const { name: editing } = useLocalSearchParams<{ name?: string }>();
  const existing = useSkills((s) => (editing ? s.skills[editing] : undefined));
  const [start] = useState(() => initial(editing));
  const [name, setName] = useState(editing ?? '');
  const [description, setDescription] = useState(start.description);
  const [body, setBody] = useState(start.body);

  const save = () => {
    try {
      if (existing) {
        updateSkillMd(existing.name, withSkillFields(readSkillMd(existing.name), { description, body }), 'user');
        router.back();
      } else {
        const slug = slugify(name);
        const skill = saveSkill({ skillMd: buildSkillMd(slug, description, body), name: slug, source: 'user' });
        router.replace({ pathname: '/skills/skill', params: { name: skill.name } });
      }
    } catch (e) {
      notify("Couldn't save", e instanceof Error ? e.message : String(e));
    }
  };

  const field = [styles.input, { color: colors.text, backgroundColor: colors.surface, borderBottomColor: colors.textSecondary }];

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: existing ? `Edit ${existing.name}` : 'New skill',
          headerRight: () => (
            <Pressable onPress={save} hitSlop={10} accessibilityLabel="Save">
              <Feather name="check" size={24} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!existing && (
          <>
            <Text style={[styles.label, { color: colors.text }]}>Name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              onBlur={() => setName(slugify(name))}
              placeholder="e.g. weekly-report"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              maxLength={64}
              style={[field, styles.single]}
            />
            <Text style={[styles.hint, { color: colors.textTertiary }]}>Lowercase letters, digits and hyphens.</Text>
          </>
        )}

        <Text style={[styles.label, { color: colors.text }]}>When to use it</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="e.g. Builds the weekly sales report from the CRM export. Use when asked for the weekly report or sales summary."
          placeholderTextColor={colors.textTertiary}
          multiline
          maxLength={MAX_DESCRIPTION_CHARS}
          style={[field, styles.description]}
        />
        <Text style={[styles.hint, { color: colors.textTertiary }]}>
          Models see only this until they load the skill, so say what it does and when it applies.
        </Text>

        <Text style={[styles.label, { color: colors.text }]}>Instructions</Text>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder={'Markdown. The steps to follow, commands or code that work, pitfalls to avoid and how to check the result.'}
          placeholderTextColor={colors.textTertiary}
          multiline
          maxLength={MAX_SKILL_CHARS}
          autoCapitalize="sentences"
          style={[field, styles.body]}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 48 },
  label: { fontSize: 15, fontWeight: '600', marginBottom: 8, marginTop: 8 },
  hint: { fontSize: 12, marginTop: 6, marginBottom: 16 },
  input: {
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    borderBottomWidth: 1,
    textAlignVertical: 'top',
  },
  single: { lineHeight: undefined },
  description: { minHeight: 88 },
  body: { minHeight: 260, fontSize: 15, marginBottom: 24 },
});
