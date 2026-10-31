import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_SYSTEM_PROMPT, PERSONAS } from '../../persona';

// The persona in use (+ → Persona) and the ones people made, saved on the phone. Custom
// personas are always named, like Odysseus' saved templates; built-in names are taken.
const SELECTED_KEY = 'persona_v1';
const CUSTOM_KEY = 'custom_personas_v1';

// What the model is told, as Odysseus does it: a named persona introduces itself first.
export const personaPrompt = (persona) => (persona.noName ? persona.prompt : `Your name is ${persona.name}. ${persona.prompt}`);

export const isBuiltInPersona = (name) => PERSONAS.some(p => p.name === name);

export function usePersona() {
  const [selectedName, setSelectedName] = useState(null); // null: Default (no persona)
  const [custom, setCustom] = useState([]);

  useEffect(() => {
    (async () => {
      const [name, saved] = await Promise.all([AsyncStorage.getItem(SELECTED_KEY), AsyncStorage.getItem(CUSTOM_KEY)]);
      if (saved) setCustom(JSON.parse(saved));
      if (name) setSelectedName(name);
    })().catch(e => console.log(`App Alert: Failed to load personas: ${e.message}`));
  }, []);

  const persona = custom.find(p => p.name === selectedName) ?? PERSONAS.find(p => p.name === selectedName) ?? null;

  const select = async (name) => {
    setSelectedName(name);
    if (name) await AsyncStorage.setItem(SELECTED_KEY, name);
    else await AsyncStorage.removeItem(SELECTED_KEY);
  };

  const saveCustom = async (next) => {
    await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
    setCustom(next);
  };

  /** Save a custom persona and switch to it. `replacing` is its old name when it's renamed. */
  const saveCustomPersona = async (entry, replacing) => {
    if (isBuiltInPersona(entry.name)) return 'builtin';
    const kept = custom.filter(p => p.name !== entry.name && p.name !== replacing);
    const at = custom.findIndex(p => p.name === (replacing ?? entry.name));
    await saveCustom(at === -1 ? [...kept, entry] : [...kept.slice(0, at), entry, ...kept.slice(at)]);
    await select(entry.name);
    return 'ok';
  };

  const deleteCustomPersona = async (name) => {
    await saveCustom(custom.filter(p => p.name !== name));
    if (selectedName === name) await select(null);
  };

  return {
    persona, // null for Default (no persona)
    custom,
    systemPrompt: persona ? personaPrompt(persona) : DEFAULT_SYSTEM_PROMPT,
    temperature: persona?.temperature, // undefined: llama.rn's default
    displayName: persona && !persona.noName ? persona.name : null, // labels its replies
    select,
    saveCustomPersona,
    deleteCustomPersona,
  };
}
