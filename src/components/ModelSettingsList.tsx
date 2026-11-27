import Feather from '@expo/vector-icons/Feather';
import { memo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { parseTokens } from '@/lib/context';
import { defaultMediaInputs, modelMediaInputs, supportsVideoInput } from '@/lib/providers/modelOptions';
import type { ModelMediaInput, ModelOptions, ProviderType } from '@/lib/providers/types';
import { fonts, useTheme } from '@/lib/theme';
import { resolveBudget } from '@/store/settings';
import { choose, notify, prompt } from './Dialogs';
import { Input } from './Form';
import { Toggle } from './Toggle';

type Update<T> = Dispatch<SetStateAction<T>>;
type PendingEdit = RefObject<(() => void) | null>;

const LEVELS = ['off', 'none', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EMPTY_LEVELS: string[] = [];

type ModelSettingsListProps = {
  models: string[];
  type: ProviderType;
  baseUrl: string;
  budgets: Record<string, number>;
  contexts: Record<string, number>;
  efforts: Record<string, string[]>;
  options: Record<string, ModelOptions>;
  setModels: Update<string[]>;
  setBudgets: Update<Record<string, number>>;
  setEfforts: Update<Record<string, string[]>>;
  setOptions: Update<Record<string, ModelOptions>>;
};

export function ModelSettingsList({ models, baseUrl, budgets, contexts, efforts, options, ...actions }: ModelSettingsListProps) {
  const { colors } = useTheme();

  return (
    <View style={[styles.list, { backgroundColor: colors.surface }]}>
      {models.slice(0, 200).map((model, index) => (
        <ModelSettingsRow
          key={model}
          model={model}
          baseUrl={baseUrl}
          separated={index > 0}
          budget={budgets[model]}
          autoBudget={resolveBudget({ baseUrl, contexts }, model)}
          levels={efforts[model] ?? EMPTY_LEVELS}
          options={options[model]}
          {...actions}
        />
      ))}
      {models.length > 200 && (
        <Text style={[styles.more, { color: colors.textSecondary }]}>
          {models.length - 200} more. Use the filter to find them.
        </Text>
      )}
    </View>
  );
}

type RowProps = Pick<ModelSettingsListProps, 'type' | 'baseUrl' | 'setModels' | 'setBudgets' | 'setEfforts' | 'setOptions'> & {
  model: string;
  separated: boolean;
  budget?: number;
  autoBudget: number;
  levels: string[];
  options?: ModelOptions;
};

const ModelSettingsRow = memo(function ModelSettingsRow({
  model, separated, type, baseUrl, budget, autoBudget, levels, options, setModels, setBudgets, setEfforts, setOptions,
}: RowProps) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const endpoint = { type, baseUrl };
  const inputs = modelMediaInputs(endpoint, options);
  const videoAvailable = supportsVideoInput(endpoint);
  const reasoningOn = levels.length > 0 && !options?.reasoningDisabled;

  const finishEditing = () => {
    pendingRef.current?.();
    Keyboard.dismiss();
  };
  const editOptions = (update: (current: ModelOptions) => ModelOptions) => {
    setOptions((current) => ({ ...current, [model]: update(current[model] ?? {}) }));
  };
  const changeMedia = (input: ModelMediaInput) => {
    finishEditing();
    editOptions((current) => {
      const values = current.mediaInputs ?? defaultMediaInputs(type);
      return { ...current, mediaInputs: values.includes(input) ? values.filter((value) => value !== input) : [...values, input] };
    });
  };
  const setLevel = (level: string, previous?: string) => {
    const next = level.trim().toLowerCase();
    if (!next || next === previous) return;
    if (levels.includes(next)) return notify('Level already added');
    const rank = LEVELS.indexOf(next);
    const before = rank < 0 ? -1 : levels.findIndex((value) => LEVELS.indexOf(value) > rank);
    const order = previous ? levels.map((value) => value === previous ? next : value) : [...levels];
    if (!previous) order.splice(before === -1 ? order.length : before, 0, next);
    setEfforts((current) => ({ ...current, [model]: order }));
    if (previous) editOptions((current) => {
      const { [previous]: apiValue, ...rest } = current.effortValues ?? {};
      return { ...current, effortValues: apiValue && apiValue !== next ? { ...rest, [next]: apiValue } : rest };
    });
  };
  const chooseLevel = (previous?: string) => {
    finishEditing();
    choose({
      title: previous ? 'Change reasoning level' : 'Add reasoning level',
      choices: [
        ...LEVELS.filter((level) => level === previous || !levels.includes(level)).map((level) => ({
          label: level,
          icon: { feather: 'sliders' as const },
          selected: level === previous,
          onPress: () => setLevel(level, previous),
        })),
        { label: 'Custom level…', icon: { feather: 'edit-2' }, onPress: () => prompt({
          title: 'Custom reasoning level', initial: previous, placeholder: 'Level name', confirmLabel: 'Save',
          onSubmit: (value) => setLevel(value, previous),
        }) },
      ],
    });
  };
  const removeLevel = (level: string) => {
    finishEditing();
    setEfforts((current) => ({ ...current, [model]: levels.filter((value) => value !== level) }));
    editOptions((current) => {
      const { [level]: _, ...rest } = current.effortValues ?? {};
      return { ...current, effortValues: rest };
    });
  };

  return (
    <View style={separated && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Settings for ${model}`}
          accessibilityState={{ expanded }}
          onPress={() => {
            if (expanded) finishEditing();
            setExpanded(!expanded);
          }}
          style={({ pressed }) => [styles.expand, pressed && { backgroundColor: colors.surfaceHover }]}
        >
          <Text numberOfLines={2} style={[styles.model, { color: colors.text }]}>{model}</Text>
          <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textSecondary} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${model}`}
          onPress={() => setModels((current) => current.filter((value) => value !== model))}
          style={styles.iconButton}
        >
          <Feather name="trash-2" size={16} color={colors.textSecondary} />
        </Pressable>
      </View>

      {expanded && (
        <View style={styles.details}>
          <View style={styles.tokenFields}>
            <TokenField label="Context budget" value={budget} placeholder={`${autoBudget} (auto)`} pendingRef={pendingRef}
              onCommit={(value) => setBudgets((current) => {
                const { [model]: _, ...rest } = current;
                return value === undefined ? rest : { ...rest, [model]: value };
              })}
            />
            <TokenField label="Max output tokens" value={options?.maxOutputTokens} placeholder="Provider default"
              pendingRef={pendingRef} onCommit={(value) => editOptions((current) => ({ ...current, maxOutputTokens: value }))}
            />
          </View>

          <View>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Input types</Text>
            <View style={styles.inputTypes}>
              <InputType label="Text" checked />
              <InputType label="Images" checked={inputs.image} onPress={() => changeMedia('image')} />
              <InputType label="Videos" checked={inputs.video}
                onPress={videoAvailable ? () => changeMedia('video') : undefined}
                hint={videoAvailable ? undefined : 'Video input is unavailable for this provider format'}
              />
            </View>
          </View>

          <View style={styles.reasoning}>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: reasoningOn }}
              onPress={() => {
                finishEditing();
                if (!levels.length) setEfforts((current) => ({ ...current, [model]: ['low'] }));
                editOptions((current) => ({ ...current, reasoningDisabled: reasoningOn }));
              }}
              style={styles.switchRow}
            >
              {({ pressed }) => <>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Reasoning levels</Text>
                <Toggle value={reasoningOn} pressed={pressed} />
              </>}
            </Pressable>
            {reasoningOn && <>
              <View style={styles.levelRow}>
                <Text style={[styles.column, styles.label, { color: colors.textSecondary }]}>Level</Text>
                <Text style={[styles.column, styles.label, { color: colors.textSecondary }]}>API value</Text>
                <View style={styles.iconButton} />
              </View>
              {levels.map((level) => (
                <View key={level} style={styles.levelRow}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Change ${level} level`} onPress={() => chooseLevel(level)}
                    style={[styles.column, styles.level, { borderColor: colors.border, backgroundColor: colors.background }]}
                  >
                    <Text numberOfLines={1} style={[styles.column, { color: colors.text }]}>{level}</Text>
                    <Feather name="chevron-down" size={15} color={colors.textSecondary} />
                  </Pressable>
                  <ValueInput label={`API value for ${level}`} value={options?.effortValues?.[level] ?? level} placeholder={level}
                    pendingRef={pendingRef} style={styles.column} onCommit={(value) => editOptions((current) => {
                      const { [level]: _, ...rest } = current.effortValues ?? {};
                      return { ...current, effortValues: value && value !== level ? { ...rest, [level]: value } : rest };
                    })}
                  />
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${level} level`} onPress={() => removeLevel(level)} style={styles.iconButton}>
                    <Feather name="trash-2" size={16} color={colors.textSecondary} />
                  </Pressable>
                </View>
              ))}
              <Pressable accessibilityRole="button" onPress={() => chooseLevel()} style={styles.addLevel}>
                <Feather name="plus" size={17} color={colors.link} />
                <Text style={{ color: colors.link, fontWeight: '600' }}>Add level</Text>
              </Pressable>
            </>}
          </View>
        </View>
      )}
    </View>
  );
});

function InputType({ label, checked, onPress, hint }: { label: string; checked: boolean; onPress?: () => void; hint?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityHint={hint} accessibilityState={{ checked, disabled: !onPress }}
      disabled={!onPress} onPress={onPress} style={styles.inputType}
    >
      <Feather name={checked ? 'check-square' : 'square'} size={19} color={onPress && checked ? colors.link : colors.textSecondary} />
      <Text style={{ color: onPress || checked ? colors.text : colors.textTertiary }}>{label}</Text>
    </Pressable>
  );
}

function TokenField({ label, value, placeholder, pendingRef, onCommit }: {
  label: string; value?: number; placeholder: string; pendingRef: PendingEdit; onCommit: (value: number | undefined) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.tokenField}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>
      <ValueInput label={label} value={value === undefined ? '' : String(value)} placeholder={placeholder} pendingRef={pendingRef}
        onCommit={(text) => {
          if (!text) return onCommit(undefined);
          const tokens = parseTokens(text);
          if (tokens === null || !Number.isSafeInteger(tokens)) {
            return notify('Invalid token count', 'Enter a positive token count such as 32000 or 128K.');
          }
          onCommit(tokens);
        }}
      />
    </View>
  );
}

function ValueInput({ label, value, placeholder, pendingRef, style, onCommit }: {
  label: string; value: string; placeholder: string; pendingRef: PendingEdit;
  style?: React.ComponentProps<typeof Input>['style']; onCommit: (value: string) => void;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState<string | null>(null);
  const commitRef = useRef<(() => void) | null>(null);

  return (
    <Input accessibilityLabel={label} value={draft ?? value} placeholder={placeholder} returnKeyType="done"
      style={[styles.field, { backgroundColor: colors.background, borderColor: colors.border }, style]}
      onChangeText={(text) => {
        setDraft(text);
        const commit = () => {
          commitRef.current = null;
          if (pendingRef.current === commit) pendingRef.current = null;
          if (text.trim() !== value) onCommit(text.trim());
          setDraft(null);
        };
        commitRef.current = commit;
        pendingRef.current = commit;
      }}
      onBlur={() => commitRef.current?.()}
      onEndEditing={() => commitRef.current?.()}
    />
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: 12, marginTop: 8, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 },
  expand: { flex: 1, minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 6, paddingVertical: 10 },
  model: { flex: 1, fontFamily: fonts.mono, fontSize: 14 },
  iconButton: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  more: { padding: 12, fontSize: 13 },
  details: { paddingHorizontal: 14, paddingBottom: 12, gap: 14 },
  tokenFields: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tokenField: { flex: 1, flexBasis: 120, gap: 6 },
  label: { fontSize: 14, fontWeight: '500' },
  field: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, fontSize: 15, paddingHorizontal: 10, paddingVertical: 8 },
  inputTypes: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 },
  inputType: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  reasoning: { gap: 6 },
  switchRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  level: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  column: { flex: 1 },
  addLevel: { minHeight: 44, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6 },
});
