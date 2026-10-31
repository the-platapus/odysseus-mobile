// The Theme screen (☰ → Theme): pick a built-in theme from theme.ts, or make, edit and delete
// custom ones. A custom theme starts from the colors in use and is applied when saved.
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  MAX_CUSTOM_THEMES,
  THEMES,
  deleteCustomTheme,
  isHexColor,
  loadCustomThemes,
  saveCustomTheme,
  selectTheme,
  theme,
  themed,
} from '../theme';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// The colors a theme sets, in the order the editor shows them.
const COLOR_FIELDS = [
  ['bg', 'Background'],
  ['fg', 'Text'],
  ['panel', 'Panels'],
  ['border', 'Borders and muted text'],
  ['red', 'Accent'],
];

const runSafely = async (fn, label) => {
  try {
    await fn();
  } catch (e) {
    console.log(`App Alert: ${label}: ${e.message}`);
    alert(`${label}: ${e.message}`);
  }
};

function Swatches({ colors }) {
  return (
    <View style={styles.swatches}>
      {COLOR_FIELDS.map(([key]) => (
        <View key={key} style={[styles.swatch, { backgroundColor: colors[key] }]} />
      ))}
    </View>
  );
}

function ThemeCard({ name, colors, onPress, onEdit, onDelete }) {
  const inUse = theme.name === name;
  return (
    <TouchableOpacity style={[styles.card, inUse && { borderColor: theme.colors.red }]} onPress={onPress}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle} numberOfLines={1}>{name}</Text>
        {inUse && <Text style={[styles.cardSub, { color: theme.colors.red, marginTop: 0 }]}>● in use</Text>}
      </View>
      <View style={[styles.rowBetween, { marginTop: 10 }]}>
        <Swatches colors={colors} />
        {(onEdit || onDelete) && (
          <View style={{ flexDirection: 'row', gap: 14 }}>
            {onEdit && (
              <TouchableOpacity onPress={onEdit}>
                <Text style={styles.actionText}>[EDIT]</Text>
              </TouchableOpacity>
            )}
            {onDelete && (
              <TouchableOpacity onPress={onDelete}>
                <Text style={[styles.actionText, { color: theme.colors.red }]}>[DEL]</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// A slice of the chat in the colors being edited, so changes show before they're saved.
function Preview({ colors }) {
  const c = Object.fromEntries(COLOR_FIELDS.map(([key]) => [key, isHexColor(colors[key]) ? colors[key] : theme.colors[key]]));
  return (
    <View style={[styles.preview, { backgroundColor: c.bg, borderColor: c.border }]}>
      <Text style={[styles.previewTitle, { color: c.red }]}>odysseus-mobile</Text>
      <View style={[styles.previewBubble, { backgroundColor: c.panel, borderColor: c.border }]}>
        <Text style={[styles.previewSender, { color: c.fg }]}>
          • You <Text style={{ color: c.border, fontWeight: 'normal' }}>12:04 PM</Text>
        </Text>
        <Text style={[styles.previewText, { color: c.fg }]}>How does this look?</Text>
      </View>
    </View>
  );
}

function ThemeEditor({ draft, setDraft, error, onCancel, onSave }) {
  const setColor = (key, value) => setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value.trim() } }));
  const canSave = !!draft.name.trim() && COLOR_FIELDS.every(([key]) => isHexColor(draft.colors[key]));

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        value={draft.name}
        onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
        placeholder="My theme"
        placeholderTextColor={theme.colors.border}
        maxLength={30}
      />
      <Text style={[styles.label, { marginTop: 8 }]}>Colors (#rrggbb)</Text>
      {COLOR_FIELDS.map(([key, label]) => {
        const valid = isHexColor(draft.colors[key]);
        return (
          <View key={key} style={styles.colorRow}>
            <View style={[styles.swatchLarge, { backgroundColor: valid ? draft.colors[key] : 'transparent' }]} />
            <Text style={[styles.muted, { flex: 1 }]}>{label}</Text>
            <TextInput
              style={[styles.input, styles.hexInput, !valid && { borderColor: theme.colors.red }]}
              value={draft.colors[key]}
              onChangeText={(value) => setColor(key, value)}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={7}
            />
          </View>
        );
      })}
      <Text style={[styles.label, { marginTop: 8 }]}>Preview</Text>
      <Preview colors={draft.colors} />
      {!!error && <Text style={styles.errorText}>{error}</Text>}
      <View style={[styles.rowBetween, { marginTop: 8 }]}>
        <TouchableOpacity onPress={onCancel}>
          <Text style={styles.actionText}>[CANCEL]</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onSave} disabled={!canSave}>
          <Text style={[styles.actionText, { color: canSave ? theme.colors.red : theme.colors.border }]}>[SAVE]</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

export default function ThemePanel({ onClose }) {
  const [custom, setCustom] = useState({});
  // While making or editing a custom theme: { name, colors, replacing? }.
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    loadCustomThemes().then(setCustom);
  }, []);

  const customCount = Object.keys(custom).length;

  const startEditing = (next) => {
    setError('');
    setDraft(next);
  };

  const save = () =>
    runSafely(async () => {
      const name = draft.name.trim();
      const result = await saveCustomTheme(name, draft.colors, draft.replacing);
      if (result === 'builtin') return setError(`"${name}" is a built-in theme. Pick another name.`);
      if (result === 'limit') return setError(`You can keep up to ${MAX_CUSTOM_THEMES} custom themes. Delete one first.`);
      setCustom(await loadCustomThemes());
      setDraft(null);
    }, 'Failed to save theme');

  const remove = (name) =>
    runSafely(async () => {
      await deleteCustomTheme(name);
      setCustom(await loadCustomThemes());
    }, 'Failed to delete theme');

  const title = !draft ? '[THEMES]' : draft.replacing ? '[EDIT THEME]' : '[NEW THEME]';

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={[styles.headerText, { color: theme.colors.red }]}>{title}</Text>
        <TouchableOpacity onPress={onClose}>
          <Text style={[styles.headerText, { color: theme.colors.fg }]}>[X]</Text>
        </TouchableOpacity>
      </View>
      {draft ? (
        <ThemeEditor draft={draft} setDraft={setDraft} error={error} onCancel={() => setDraft(null)} onSave={save} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.sectionTitle}>Custom ({customCount}/{MAX_CUSTOM_THEMES})</Text>
          {Object.entries(custom).map(([name, t]) => (
            <ThemeCard
              key={name}
              name={name}
              colors={t.colors}
              onPress={() => runSafely(() => selectTheme(name, t), 'Failed to apply theme')}
              onEdit={() => startEditing({ name, colors: { ...t.colors }, replacing: name })}
              onDelete={() => remove(name)}
            />
          ))}
          <TouchableOpacity
            style={[styles.newButton, customCount >= MAX_CUSTOM_THEMES && { opacity: 0.4 }]}
            disabled={customCount >= MAX_CUSTOM_THEMES}
            onPress={() => startEditing({ name: '', colors: { ...theme.colors } })}
          >
            <Text style={styles.newButtonText}>+ New Custom Theme</Text>
          </TouchableOpacity>

          <Text style={styles.sectionTitle}>Built-in</Text>
          {Object.entries(THEMES).map(([name, t]) => (
            <ThemeCard key={name} name={name} colors={t.colors} onPress={() => runSafely(() => selectTheme(name, t), 'Failed to apply theme')} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerText: {
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: monoFont,
  },
  content: {
    padding: 15,
    gap: 12,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 14,
    fontWeight: 'bold',
    marginTop: 8,
  },
  card: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 12,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    flexShrink: 1,
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 14,
    fontWeight: 'bold',
  },
  cardSub: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
    marginTop: 4,
  },
  swatches: {
    flexDirection: 'row',
    gap: 6,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  swatchLarge: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginRight: 10,
  },
  actionText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  newButton: {
    padding: 12,
    backgroundColor: theme.colors.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  newButtonText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    textAlign: 'center',
    fontWeight: 'bold',
  },
  label: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  muted: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
  },
  input: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  hexInput: {
    width: 100,
  },
  errorText: {
    color: theme.colors.red,
    fontFamily: monoFont,
    fontSize: 12,
  },
  preview: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  previewTitle: {
    fontFamily: monoFont,
    fontSize: 16,
    fontWeight: 'bold',
  },
  previewBubble: {
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  previewSender: {
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  previewText: {
    fontFamily: monoFont,
    fontSize: 13,
  },
}));
