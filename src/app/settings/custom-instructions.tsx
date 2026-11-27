import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Input } from '@/components/Form';
import { useTheme } from '@/lib/theme';
import { MAX_CUSTOM_INSTRUCTIONS_CHARS, useSettings } from '@/store/settings';

export default function CustomInstructionsScreen() {
  const { colors } = useTheme();
  const saved = useSettings((s) => s.customInstructions);
  const [text, setText] = useState(saved);
  const changed = text.trim() !== saved;

  const save = () => {
    useSettings.getState().setCustomInstructions(text);
    if (router.canGoBack()) router.back();
    else router.replace('/settings/general');
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={save} disabled={!changed} hitSlop={10} accessibilityRole="button" accessibilityState={{ disabled: !changed }}>
              <Text style={[styles.save, { color: changed ? colors.link : colors.textSecondary }]}>Save</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.label, { color: colors.text }]}>How should models respond?</Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          Set preferences for tone, format, or context to send to the model with your chats. Project instructions take precedence.
        </Text>
        <Input
          accessibilityLabel="Custom instructions"
          value={text}
          onChangeText={setText}
          placeholder="Keep answers concise and explain unfamiliar terms."
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="sentences"
          autoCorrect
          multiline
          maxLength={MAX_CUSTOM_INSTRUCTIONS_CHARS}
          style={styles.input}
        />
        <Text style={[styles.count, { color: colors.textSecondary }]}>{text.length} / {MAX_CUSTOM_INSTRUCTIONS_CHARS}</Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          Changes apply to the next reply in Clanker chats. Remote chats keep the instructions they start with.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 48 },
  label: { fontSize: 17, fontWeight: '600', marginBottom: 6 },
  description: { fontSize: 15, lineHeight: 22 },
  input: { height: 200, lineHeight: 23, marginTop: 16, textAlignVertical: 'top' },
  count: { fontSize: 12, marginTop: 6, marginBottom: 16, textAlign: 'right' },
  save: { fontSize: 17, fontWeight: '600' },
});
