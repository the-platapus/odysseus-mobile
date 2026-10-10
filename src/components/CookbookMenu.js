import { ScrollView, TouchableOpacity, Text, StyleSheet, View, Platform, ActivityIndicator } from 'react-native';
import { useState, useEffect } from 'react';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import theme from '../../theme.json';

export default function CookbookMenu({ onSelectModel }) {
  const [models, setModels] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Device.totalMemory returns bytes. Convert to GB and round up/down.
  const totalRamGB = Device.totalMemory ? Math.round(Device.totalMemory / (1024 * 1024 * 1024)) : null;

  useEffect(() => {
    async function fetchCookbook() {
      try {
        // Fetch trending GGUF models directly from HuggingFace, entirely bypassing the PC
        const response = await fetch('https://huggingface.co/api/models?filter=gguf&pipeline_tag=text-generation&sort=trendingScore&direction=-1&limit=100');

        if (response.ok) {
          const rawModels = await response.json();
          // Map HuggingFace's JSON to our Cookbook format
          const mappedModels = rawModels.map((m, index) => {
            // Rough heuristic to extract parameter count (e.g. "3B", "1.5B") from model ID
            const match = m.id.match(/[-_/](\d+(?:\.\d+)?)[Bb](?![a-zA-Z])/i);
            const paramsB = match ? parseFloat(match[1]) : 0;
            const estSizeGb = paramsB ? (paramsB * 0.7) : 0; // Approx size for Q4 quant
            const estRam = estSizeGb ? Math.ceil(estSizeGb + 1.5) : 4; // Add OS overhead

            return {
              id: m.id,
              name: m.id.split('/').pop().replace('-GGUF', '').replace(/-/g, ' '),
              quant: 'GGUF (Various)',
              ram: estSizeGb ? `≈${estSizeGb.toFixed(1)}GB` : 'Unknown',
              minTotalRam: estRam,
              desc: `${(m.downloads || 0).toLocaleString()} downloads.`,
              color: [theme.colors.fg, theme.colors.red, theme.colors.border, theme.colors.fg][index % 4]
            };
          });
          // Sort models: supported first, then by size ascending (smallest models top)
          mappedModels.sort((a, b) => {
            const aSupported = totalRamGB === null || totalRamGB >= a.minTotalRam;
            const bSupported = totalRamGB === null || totalRamGB >= b.minTotalRam;
            if (aSupported !== bSupported) {
              return aSupported ? -1 : 1; // Supported go to the top
            }
            // Within same support tier, sort by RAM requirement ascending (smallest to largest)
            return a.minTotalRam - b.minTotalRam;
          });

          setModels(mappedModels);
          // Persist to local device storage for offline use!
          await AsyncStorage.setItem('@odysseus_cookbook_cache', JSON.stringify(mappedModels));
        } else {
          throw new Error('Failed to fetch remote catalog');
        }
      } catch (err) {
        // We are offline or the PC is off. Load from AsyncStorage instead of a hardcoded fallback!
        try {
          const cachedModels = await AsyncStorage.getItem('@odysseus_cookbook_cache');
          if (cachedModels !== null) {
            setModels(JSON.parse(cachedModels));
          } else {
            setError('Offline. No cached models found.');
          }
        } catch (storageErr) {
          const msg = err.message || 'Network error fetching cookbook';
          console.log(`App Alert: Failed to fetch cookbook: ${msg}`);
          alert(`Failed to fetch cookbook: ${msg}`);
          setError(msg);
        }
      } finally {
        setIsLoading(false);
      }
    }

    fetchCookbook();
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Hardware-Aware Cookbook</Text>
        <Text style={styles.subHeader}>
          {totalRamGB
            ? `Detected ${totalRamGB}GB RAM on this ${Device.modelName || 'device'}`
            : 'Select a model profile to download/load'}
        </Text>
      </View>

      {isLoading ? (
        <ActivityIndicator style={{ paddingVertical: 20 }} color="#007AFF" />
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Could not load the Odysseus cookbook.</Text>
          <Text style={styles.errorSubText}>{error}</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          style={styles.scrollView}
        >
          {models.map((model) => {
            const isUnsupported = totalRamGB !== null && totalRamGB < model.minTotalRam;

            return (
              <TouchableOpacity
                key={model.id}
                style={[
                  styles.card,
                  { borderLeftColor: isUnsupported ? theme.colors.border : model.color, borderLeftWidth: 4 },
                  isUnsupported && styles.cardDisabled
                ]}
                onPress={() => onSelectModel(model)}
                disabled={isUnsupported}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.cardTitle}>{model.name}</Text>
                  <Text style={[styles.badge, {
                    backgroundColor: isUnsupported ? theme.colors.bg : model.color + '20',
                    color: isUnsupported ? theme.colors.border : model.color
                  }]}>
                    {model.ram}
                  </Text>
                </View>
                <Text style={styles.cardQuant}>
                  {isUnsupported ? `Requires ${model.minTotalRam}GB RAM` : `Format: GGUF (${model.quant})`}
                </Text>
                <Text style={styles.cardDesc} numberOfLines={2}>{model.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  container: {
    flex: 1, // Allow it to fill vertical space if placed in a flex parent
    paddingVertical: 15,
    backgroundColor: theme.colors.bg,
  },
  headerRow: {
    paddingHorizontal: 15,
    marginBottom: 12,
  },
  header: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.fg,
    letterSpacing: 0.3,
    fontFamily: monoFont,
  },
  subHeader: {
    fontSize: 13,
    color: theme.colors.border,
    marginTop: 2,
    fontFamily: monoFont,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 15,
    paddingBottom: 20,
    gap: 12,
  },
  card: {
    backgroundColor: theme.colors.panel,
    padding: 15,
    borderRadius: 12,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  cardDisabled: {
    opacity: 0.6,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.fg,
    flex: 1,
    fontFamily: monoFont,
  },
  badge: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    fontFamily: monoFont,
  },
  cardQuant: {
    fontSize: 12,
    fontFamily: monoFont,
    color: theme.colors.border,
    marginBottom: 8,
  },
  cardDesc: {
    fontSize: 13,
    color: theme.colors.fg,
    lineHeight: 18,
    opacity: 0.8,
    fontFamily: monoFont,
  },
  errorContainer: {
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.red,
    fontFamily: monoFont,
  },
  errorSubText: {
    fontSize: 12,
    color: theme.colors.border,
    marginTop: 4,
    fontFamily: monoFont,
  }
});
