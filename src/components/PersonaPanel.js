// The Persona screen (+ → Persona), laid out like Odysseus' persona picker: Default (no persona),
// the personas people saved, then the presets from persona.ts. A new persona starts from the one
// in use, so a preset can be tweaked into a saved one.
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { DEFAULT_SYSTEM_PROMPT, PERSONAS } from '../../persona';
import { theme, themed } from '../theme';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const DEFAULT_TEMPERATURE = 1.0; // a new persona's, as in Odysseus

const runSafely = async (fn, label) => {
  try {
    await fn();
  } catch (e) {
    console.log(`App Alert: ${label}: ${e.message}`);
    alert(`${label}: ${e.message}`);
  }
};

const parseTemperature = (text) => {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 2 ? value : null;
};

function PersonaCard({ title, details, prompt, inUse, onPress, onEdit, onDelete }) {
  return (
    <TouchableOpacity style={[styles.card, inUse && { borderColor: theme.colors.red }]} onPress={onPress}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
        {inUse && <Text style={[styles.muted, { color: theme.colors.red }]}>● in use</Text>}
      </View>
      {!!details && <Text style={[styles.muted, { marginTop: 4 }]}>{details}</Text>}
      <Text style={styles.prompt} numberOfLines={3}>{prompt}</Text>
      {(onEdit || onDelete) && (
        <View style={styles.actions}>
          <TouchableOpacity onPress={onEdit}>
            <Text style={styles.actionText}>[EDIT]</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete}>
            <Text style={[styles.actionText, { color: theme.colors.red }]}>[DEL]</Text>
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
}

function PersonaEditor({ draft, setDraft, error, onCancel, onSave }) {
  const canSave = !!draft.name.trim() && !!draft.prompt.trim() && parseTemperature(draft.temperature) !== null;
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        value={draft.name}
        onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
        placeholder="My persona"
        placeholderTextColor={theme.colors.border}
        maxLength={40}
      />
      <Text style={styles.muted}>The model is told this name, and its replies are labelled with it.</Text>
      <Text style={[styles.label, { marginTop: 8 }]}>Temperature (0 to 2)</Text>
      <TextInput
        style={[styles.input, styles.temperatureInput, parseTemperature(draft.temperature) === null && { borderColor: theme.colors.red }]}
        value={draft.temperature}
        onChangeText={(temperature) => setDraft((d) => ({ ...d, temperature }))}
        keyboardType="decimal-pad"
        maxLength={4}
      />
      <Text style={styles.muted}>Lower is more focused, higher is more varied.</Text>
      <Text style={[styles.label, { marginTop: 8 }]}>System prompt</Text>
      <TextInput
        style={[styles.input, styles.promptInput]}
        value={draft.prompt}
        onChangeText={(prompt) => setDraft((d) => ({ ...d, prompt }))}
        placeholder="How the assistant should behave"
        placeholderTextColor={theme.colors.border}
        multiline
      />
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

/** `personas` is the usePersona() hook's state. */
export default function PersonaPanel({ personas, onClose }) {
  // While making or editing a persona: { name, prompt, temperature (text), replacing? }.
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const { persona, custom } = personas;

  const startEditing = (next) => {
    setError('');
    setDraft(next);
  };

  const startNew = () =>
    startEditing({
      name: '',
      prompt: persona?.prompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature: String(persona?.temperature ?? DEFAULT_TEMPERATURE),
    });

  const save = () =>
    runSafely(async () => {
      const name = draft.name.trim();
      const entry = { name, prompt: draft.prompt.trim(), temperature: parseTemperature(draft.temperature) };
      const result = await personas.saveCustomPersona(entry, draft.replacing);
      if (result === 'builtin') return setError(`"${name}" is a preset. Pick another name.`);
      setDraft(null);
    }, 'Failed to save persona');

  const select = (name) => runSafely(() => personas.select(name), 'Failed to switch persona');

  const details = (p) => `temperature ${p.temperature.toFixed(1)}${p.noName ? ' · no name' : ''}`;
  const title = !draft ? '[PERSONAS]' : draft.replacing ? '[EDIT PERSONA]' : '[NEW PERSONA]';

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <Text style={[styles.headerText, { color: theme.colors.red }]}>{title}</Text>
        <TouchableOpacity onPress={onClose}>
          <Text style={[styles.headerText, { color: theme.colors.fg }]}>[X]</Text>
        </TouchableOpacity>
      </View>
      {draft ? (
        <PersonaEditor draft={draft} setDraft={setDraft} error={error} onCancel={() => setDraft(null)} onSave={save} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <PersonaCard title="Default (no persona)" prompt={DEFAULT_SYSTEM_PROMPT} inUse={!persona} onPress={() => select(null)} />

          <Text style={styles.sectionTitle}>Saved</Text>
          {custom.map((p) => (
            <PersonaCard
              key={p.name}
              title={p.name}
              details={details(p)}
              prompt={p.prompt}
              inUse={persona?.name === p.name}
              onPress={() => select(p.name)}
              onEdit={() => startEditing({ name: p.name, prompt: p.prompt, temperature: String(p.temperature), replacing: p.name })}
              onDelete={() => runSafely(() => personas.deleteCustomPersona(p.name), 'Failed to delete persona')}
            />
          ))}
          <TouchableOpacity style={styles.newButton} onPress={startNew}>
            <Text style={styles.newButtonText}>+ New Persona</Text>
          </TouchableOpacity>
          <Text style={styles.muted}>Starts from the persona in use.</Text>

          <Text style={styles.sectionTitle}>Presets</Text>
          {PERSONAS.map((p) => (
            <PersonaCard
              key={p.name}
              title={p.name}
              details={details(p)}
              prompt={p.prompt}
              inUse={persona?.name === p.name}
              onPress={() => select(p.name)}
            />
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
  prompt: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
    opacity: 0.85,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 14,
    marginTop: 10,
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
  temperatureInput: {
    width: 80,
  },
  promptInput: {
    minHeight: 180,
    textAlignVertical: 'top',
  },
  errorText: {
    color: theme.colors.red,
    fontFamily: monoFont,
    fontSize: 12,
  },
}));
