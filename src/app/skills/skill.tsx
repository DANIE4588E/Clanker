import Feather from '@expo/vector-icons/Feather';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as Linking from 'expo-linking';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirm, notify } from '@/components/Dialogs';
import { Row, Section, ToggleRow } from '@/components/Form';
import { Markdown } from '@/components/Markdown';
import { openChat } from '@/components/ReplyNotifications';
import { SKILL_SOURCES } from '@/components/SkillActions';
import { deleteSkill, listSkillFiles, parseSkillMd, readSkillMd, skillFile } from '@/lib/skills';
import { findSkills, installPackage } from '@/lib/skills/install';
import { useTheme } from '@/lib/theme';
import { formatSize } from '@/lib/workspace';
import { useChats } from '@/store/chats';
import { useSkills } from '@/store/skills';

const TEXT_PREVIEW_BYTES = 200_000;

function when(ms: number) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString();
}

/** One skill: what it says, its files, and switches to offer, update or remove it. */
export default function SkillScreen() {
  const { colors } = useTheme();
  const { name } = useLocalSearchParams<{ name: string }>();
  const skill = useSkills((s) => s.skills[name]);
  const setEnabled = useSkills((s) => s.setEnabled);
  const chat = useChats((s) => (skill?.conversationId ? s.conversations[skill.conversationId] : undefined));
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [updating, setUpdating] = useState(false);

  // Read again whenever the skill changes.
  const { body, files } = useMemo(() => {
    if (!skill) return { body: '', files: [] as { path: string; size: number }[] };
    try {
      return { body: parseSkillMd(readSkillMd(skill.name)).body, files: listSkillFiles(skill.name) };
    } catch {
      return { body: '', files: [] };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill?.name, skill?.updatedAt]);

  if (!skill) {
    return (
      <View style={[styles.gone, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: '' }} />
        <Text style={{ color: colors.textTertiary }}>This skill was removed.</Text>
      </View>
    );
  }

  const openFile = (path: string, size: number) => {
    if (size > TEXT_PREVIEW_BYTES) return notify(path, `${formatSize(size)}: too large to show here.`);
    const bytes = skillFile(skill.name, path).bytesSync();
    if (bytes.slice(0, 8000).includes(0)) return notify(path, `A binary file (${formatSize(size)}).`);
    setPreview({ path, text: new TextDecoder().decode(bytes) });
  };

  const remove = () =>
    confirm({
      title: `Delete "${skill.name}"?`,
      message: 'Models will no longer be offered it. Chats that already loaded it keep what they read.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        deleteSkill(skill.name);
        router.back();
      },
    });

  const update = async () => {
    if (!skill.origin) return;
    setUpdating(true);
    try {
      const found = await findSkills(skill.origin);
      const pkg = found.find((p) => p.name === skill.name) ?? (found.length === 1 ? found[0] : undefined);
      if (!pkg) throw new Error(`"${skill.name}" is no longer at ${skill.origin}.`);
      await installPackage({ ...pkg, name: skill.name }, true);
      notify('Skill updated', `"${skill.name}" now matches its source.`);
    } catch (e) {
      notify("Couldn't update", e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  };

  const changedBy = skill.updatedBy === 'model' || skill.updatedBy === 'auto' ? 'Improved by a model' : 'Updated';
  const fromWeb = !!skill.origin && /^https?:\/\//.test(skill.origin);

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{
          title: skill.name,
          headerRight: () => (
            <Pressable
              onPress={() => router.push({ pathname: '/skills/edit', params: { name: skill.name } })}
              hitSlop={10}
              accessibilityLabel="Edit skill"
            >
              <Feather name="edit-2" size={21} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <Text style={[styles.description, { color: colors.text }]}>{skill.description}</Text>
      <Text style={[styles.meta, { color: colors.textTertiary }]}>
        {SKILL_SOURCES[skill.source]} {when(skill.createdAt)}
        {skill.updatedAt !== skill.createdAt ? ` · ${changedBy} ${when(skill.updatedAt)}` : ''}
      </Text>

      <Section footer={skill.enabled ? undefined : "Models aren't offered this skill while it's off."}>
        <ToggleRow
          icon="power"
          title="Offer to models"
          detail="Listed in chats with tools, loaded when a task matches"
          value={skill.enabled}
          onValueChange={(v) => setEnabled(skill.name, v)}
        />
        {chat && (
          <Row
            icon="message-circle"
            title={skill.source === 'model' || skill.source === 'auto' ? 'Learned in' : 'Last improved in'}
            detail={chat.title}
            onPress={() => {
              if (router.canDismiss()) router.dismissAll();
              openChat(chat.id);
            }}
          />
        )}
        {fromWeb && (
          <Row icon="external-link" title="Source" detail={skill.origin} onPress={() => Linking.openURL(skill.origin!)} />
        )}
        {fromWeb && (
          <Row
            icon="refresh-cw"
            title={updating ? 'Updating…' : 'Update from source'}
            detail="Replaces it with the version there, dropping any changes made here"
            onPress={updating ? undefined : update}
            trailing={updating ? () => <ActivityIndicator color={colors.textTertiary} /> : undefined}
          />
        )}
      </Section>

      <Text style={[styles.heading, { color: colors.textTertiary }]}>Instructions</Text>
      <View style={[styles.body, { backgroundColor: colors.surface }]}>
        {body ? <Markdown value={body} /> : <Text style={{ color: colors.textTertiary }}>No instructions.</Text>}
      </View>

      {files.length > 0 && (
        <Section title={`Files · ${files.length}`} footer="Copied into a chat's workspace when a model loads the skill.">
          {files.map((f) => (
            <Row key={f.path} icon="file-text" title={f.path} value={formatSize(f.size)} onPress={() => openFile(f.path, f.size)} />
          ))}
        </Section>
      )}

      <Pressable onPress={remove} style={styles.delete} hitSlop={6}>
        <Text style={{ color: colors.danger, fontSize: 16 }}>Delete skill</Text>
      </Pressable>

      <Modal visible={!!preview} animationType="slide" onRequestClose={() => setPreview(null)}>
        <View style={[styles.previewWrap, { backgroundColor: colors.background }]}>
          <View style={[styles.previewHeader, { borderBottomColor: colors.border }]}>
            <Text numberOfLines={1} style={[styles.previewTitle, { color: colors.text }]}>
              {preview?.path}
            </Text>
            <Pressable onPress={() => setPreview(null)} hitSlop={10} accessibilityLabel="Close">
              <Feather name="x" size={24} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.previewBody}>
            <Text selectable style={[styles.code, { color: colors.text }]}>
              {preview?.text}
            </Text>
          </ScrollView>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  gone: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  description: { fontSize: 16, lineHeight: 23, marginHorizontal: 4 },
  meta: { fontSize: 13, marginHorizontal: 4, marginTop: 8, marginBottom: 24 },
  heading: { fontSize: 13, fontWeight: '600', marginHorizontal: 16, marginBottom: 8 },
  body: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 8, marginBottom: 24 },
  delete: { alignSelf: 'center', marginTop: 4, padding: 8 },
  previewWrap: { flex: 1, paddingTop: 48 },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  previewTitle: { flex: 1, fontSize: 17, fontWeight: '600' },
  previewBody: { padding: 16, paddingBottom: 48 },
  code: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
});
