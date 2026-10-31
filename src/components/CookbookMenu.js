import { ScrollView, TouchableOpacity, Text, TextInput, StyleSheet, View, Platform } from 'react-native';
import { useState, useEffect } from 'react';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FEATURES,
  NO_FILTERS,
  SIZE_BUCKETS,
  chipCounts,
  fitsPhone,
  fromHfModel,
  hfModelsUrl,
  matchesFilters,
  matchesQuery,
  parseRecommended,
} from '../cookbook/catalog';
import { README_RAW_URL } from '../repo';
import { theme, themed } from '../theme';
import LoadingWave from './LoadingWave';

const TRENDING_CACHE_KEY = '@odysseus_cookbook_cache_v2';
const RECOMMENDED_CACHE_KEY = '@odysseus_recommended_cache';
const OK_GREEN = '#6bc46d';
const CARD_COLORS = themed(() => [theme.colors.fg, theme.colors.red, theme.colors.border, theme.colors.fg]);

const formatDownloads = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// Fetch and parse, falling back to the last parsed copy saved for offline use.
async function fetchCached(url, cacheKey, { asText = false, parse }) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = parse(await (asText ? response.text() : response.json()));
    await AsyncStorage.setItem(cacheKey, JSON.stringify(value)).catch(() => {});
    return { value, offline: false };
  } catch (err) {
    const cached = await AsyncStorage.getItem(cacheKey).catch(() => null);
    if (cached !== null) return { value: JSON.parse(cached), offline: true };
    throw err;
  }
}

function Chip({ label, count, active, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && { color: theme.colors.red }]}>
        {label}
        {count !== undefined && <Text style={styles.chipCount}>  {count}</Text>}
      </Text>
    </TouchableOpacity>
  );
}

function ModelCard({ model, color, phoneRamGb, onPress }) {
  const isUnsupported = !fitsPhone(model, phoneRamGb);
  const facts = [
    model.paramsB ? `${model.paramsB}B` : null,
    model.architecture,
    model.contextLength ? `${Math.round(model.contextLength / 1024)}k ctx` : null,
    model.downloads ? `${formatDownloads(model.downloads)} downloads` : null,
  ].filter(Boolean);

  return (
    <TouchableOpacity
      style={[
        styles.card,
        { borderLeftColor: isUnsupported ? theme.colors.border : color, borderLeftWidth: 4 },
        isUnsupported && styles.cardDisabled,
      ]}
      onPress={() => onPress(model)}
      disabled={isUnsupported}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle}>{model.name}</Text>
        <Text style={[styles.badge, {
          backgroundColor: isUnsupported ? theme.colors.bg : color + '20',
          color: isUnsupported ? theme.colors.border : color,
        }]}>
          {model.ramGb ? `≈${model.ramGb}GB RAM` : 'RAM ?'}
        </Text>
      </View>
      <Text style={styles.cardQuant} numberOfLines={1}>
        {isUnsupported ? `Requires ${model.ramGb}GB RAM` : model.id}
      </Text>
      {facts.length > 0 && <Text style={styles.cardDesc} numberOfLines={1}>{facts.join(' · ')}</Text>}
      {(model.recommended || model.features.length > 0) && (
        <View style={styles.tagRow}>
          {model.recommended && <Text style={[styles.tag, { color: OK_GREEN, borderColor: OK_GREEN }]}>tested</Text>}
          {model.features.map((f) => (
            <Text key={f} style={styles.tag}>{FEATURES.find((x) => x.key === f)?.label ?? f}</Text>
          ))}
        </View>
      )}
      {!!model.testedOn && <Text style={[styles.cardDesc, { marginTop: 6 }]}>Tested on {model.testedOn}</Text>}
    </TouchableOpacity>
  );
}

export default function CookbookMenu({ onSelectModel }) {
  const [trending, setTrending] = useState(null);
  const [recommended, setRecommended] = useState([]);
  const [isOffline, setIsOffline] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Results are kept with the query they answer, so a stale reply is never shown.
  const [search, setSearch] = useState({ query: '', models: [], error: null });
  const [filters, setFilters] = useState(NO_FILTERS);

  // Device.totalMemory returns bytes. Convert to GB and round up/down.
  const totalRamGB = Device.totalMemory ? Math.round(Device.totalMemory / (1024 * 1024 * 1024)) : null;

  useEffect(() => {
    // Trending GGUF models straight from Hugging Face; the last list is kept for offline use.
    fetchCached(hfModelsUrl(), TRENDING_CACHE_KEY, { parse: (raw) => raw.map(fromHfModel) })
      .then(({ value, offline }) => {
        setTrending(value);
        setIsOffline(offline);
      })
      .catch((err) => {
        console.log(`App Alert: Failed to fetch cookbook: ${err.message}`);
        setError(err.message || 'Offline. No cached models found.');
        setTrending([]);
      });
    // Recommended = the "Tested models" table in the repo README, so it's updated by editing the README.
    fetchCached(README_RAW_URL, RECOMMENDED_CACHE_KEY, { asText: true, parse: parseRecommended })
      .then(({ value }) => setRecommended(value))
      .catch((err) => console.log(`App Alert: Failed to fetch recommended models: ${err.message}`));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const searchActive = debouncedQuery.length >= 2;

  useEffect(() => {
    if (!searchActive || isOffline) return;
    let cancelled = false;
    fetch(hfModelsUrl({ search: debouncedQuery, limit: 50 }))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((raw) => !cancelled && setSearch({ query: debouncedQuery, models: raw.map(fromHfModel), error: null }))
      .catch((err) => !cancelled && setSearch({ query: debouncedQuery, models: [], error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, searchActive, isOffline]);

  // Offline (or if the search request fails), search the saved list instead.
  const searchFailed = search.query === debouncedQuery && !!search.error;
  const localSearch = isOffline || searchFailed;
  const isSearching = searchActive && !localSearch && search.query !== debouncedQuery;
  const base = !searchActive
    ? trending ?? []
    : localSearch
      ? (trending ?? []).filter((m) => matchesQuery(m, debouncedQuery))
      : search.query === debouncedQuery
        ? search.models
        : [];
  const recommendedBase = query.trim() ? recommended.filter((m) => matchesQuery(m, query.trim())) : recommended;

  const counts = chipCounts([...recommendedBase, ...base], totalRamGB);
  const recommendedIds = new Set(recommended.map((m) => m.id));
  const recommendedShown = recommendedBase.filter((m) => matchesFilters(m, filters, totalRamGB));
  const listShown = base
    .filter((m) => !recommendedIds.has(m.id) && matchesFilters(m, filters, totalRamGB))
    .map((m, index) => ({ m, index }))
    // Models that fit come first. The trending list then goes smallest first (the old order);
    // search results keep Hugging Face's ranking.
    .sort((a, b) => {
      const af = fitsPhone(a.m, totalRamGB);
      const bf = fitsPhone(b.m, totalRamGB);
      if (af !== bf) return af ? -1 : 1;
      return searchActive ? a.index - b.index : (a.m.ramGb ?? 99) - (b.m.ramGb ?? 99);
    })
    .map(({ m }) => m);

  const toggle = (key, value) => setFilters((f) => ({ ...f, [key]: f[key] === value ? (key === 'fitsPhone' ? false : null) : value }));
  const noFilters = !filters.fitsPhone && !filters.size && !filters.feature && !filters.family;

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

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={isOffline ? 'Search saved models…' : 'Search Hugging Face GGUF models…'}
          placeholderTextColor={theme.colors.border}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {isSearching && <LoadingWave color={theme.colors.fg} style={styles.searchSpinner} />}
        {!!query && !isSearching && (
          <TouchableOpacity onPress={() => setQuery('')} style={styles.searchClear} hitSlop={8}>
            <Text style={styles.chipText}>[x]</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chipRow} keyboardShouldPersistTaps="handled">
        <Chip label="All" count={counts.all} active={noFilters} onPress={() => setFilters(NO_FILTERS)} />
        {totalRamGB !== null && (
          <Chip label="fits phone" count={counts.fitsPhone} active={filters.fitsPhone} onPress={() => toggle('fitsPhone', true)} />
        )}
        <View style={styles.chipDivider} />
        {SIZE_BUCKETS.filter((b) => counts.sizes[b.key] || filters.size === b.key).map((b) => (
          <Chip key={b.key} label={b.label} count={counts.sizes[b.key]} active={filters.size === b.key} onPress={() => toggle('size', b.key)} />
        ))}
        <View style={styles.chipDivider} />
        {FEATURES.filter((f) => counts.features[f.key] || filters.feature === f.key).map((f) => (
          <Chip key={f.key} label={f.label} count={counts.features[f.key]} active={filters.feature === f.key} onPress={() => toggle('feature', f.key)} />
        ))}
        {counts.families.length > 0 && <View style={styles.chipDivider} />}
        {counts.families.map(([family, count]) => (
          <Chip key={family} label={family} count={count} active={filters.family === family} onPress={() => toggle('family', family)} />
        ))}
      </ScrollView>

      {trending === null ? (
        <LoadingWave label="Fetching models" size={13} style={{ paddingVertical: 20, textAlign: 'center' }} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          style={styles.scrollView}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {recommendedShown.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Recommended</Text>
              <Text style={styles.sectionSub}>Tested and working in this app.</Text>
              {recommendedShown.map((model) => (
                <ModelCard key={`rec-${model.id}-${model.file ?? ''}`} model={model} color={OK_GREEN} phoneRamGb={totalRamGB} onPress={onSelectModel} />
              ))}
            </>
          )}

          <Text style={styles.sectionTitle}>
            {searchActive ? `Results for "${debouncedQuery}"` : 'Trending'}
          </Text>
          {(isOffline || searchFailed) && (
            <Text style={styles.sectionSub}>Offline: showing the last saved list.</Text>
          )}
          {error && !base.length && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>Could not load the Odysseus cookbook.</Text>
              <Text style={styles.errorSubText}>{error}</Text>
            </View>
          )}
          {!isSearching && !error && listShown.length === 0 && (
            <Text style={styles.sectionSub}>No models match{noFilters ? '' : ' these filters'}.</Text>
          )}
          {listShown.map((model, index) => (
            <ModelCard key={model.id} model={model} color={CARD_COLORS[index % CARD_COLORS.length]} phoneRamGb={totalRamGB} onPress={onSelectModel} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = themed(() => StyleSheet.create({
  container: {
    flex: 1, // Allow it to fill vertical space if placed in a flex parent
    paddingTop: 15,
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
  searchRow: {
    marginHorizontal: 15,
    justifyContent: 'center',
  },
  searchInput: {
    backgroundColor: theme.colors.panel,
    color: theme.colors.fg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingRight: 44,
    paddingVertical: 10,
    fontFamily: monoFont,
    fontSize: 13,
  },
  searchSpinner: {
    position: 'absolute',
    right: 12,
  },
  searchClear: {
    position: 'absolute',
    right: 12,
  },
  chipScroll: {
    flexGrow: 0,
    marginTop: 10,
    marginBottom: 6,
  },
  chipRow: {
    paddingHorizontal: 15,
    gap: 8,
    alignItems: 'center',
  },
  chip: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: theme.colors.panel,
  },
  chipActive: {
    borderColor: theme.colors.red,
  },
  chipText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
  },
  chipCount: {
    color: theme.colors.border,
  },
  chipDivider: {
    width: 1,
    height: 18,
    backgroundColor: theme.colors.border,
    marginHorizontal: 2,
  },
  sectionTitle: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 14,
    fontWeight: 'bold',
    marginTop: 6,
  },
  sectionSub: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
    marginTop: -6,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 15,
    paddingTop: 6,
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
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  tag: {
    color: theme.colors.border,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: monoFont,
    fontSize: 11,
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
}));
