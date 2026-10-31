// "Update available", shown at most once per launch when this repo's GitHub releases have a
// newer build of the app (src/update/). Android downloads the APK here and opens the system
// installer; iOS can't install apps from inside an app, so it links to the release page.
// Render it once, anywhere in App: it checks a few seconds after launch and shows nothing else.
import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme, themed } from '../theme';
import {
  canInstallApk,
  dismissUpdate,
  downloadApk,
  findUpdateToOffer,
  installApk,
  openInstallSettings,
  openReleasePage,
  runningBuild,
} from '../update/appUpdate';
import { runningLabel } from '../update/releases';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
// Launch is busy enough: loading the last model, and any crash report from last time.
const CHECK_DELAY_MS = 4000;
const MB = 1024 ** 2;

function Button({ label, onPress, primary }) {
  return (
    <TouchableOpacity onPress={onPress} hitSlop={8}>
      <Text style={[styles.button, primary && { color: theme.colors.red }]}>[{label}]</Text>
    </TouchableOpacity>
  );
}

export default function UpdatePrompt() {
  const [update, setUpdate] = useState(null);
  // 'offer' -> 'downloading' -> 'installing' -> 'notInstalled' (back without it), or 'failed'
  const [step, setStep] = useState('offer');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const downloadRef = useRef(null);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      findUpdateToOffer().then((found) => active && found && setUpdate(found));
    }, CHECK_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  if (!update) return null;

  const close = () => setUpdate(null);
  const later = () => {
    dismissUpdate(update);
    close();
  };

  const startUpdate = async () => {
    setStep('downloading');
    setProgress(0);
    const download = downloadApk(update.asset, setProgress);
    downloadRef.current = download;
    let file;
    try {
      file = await download.done;
    } catch (e) {
      if (downloadRef.current !== download) return; // cancelled
      downloadRef.current = null;
      setError(e.message);
      setStep('failed');
      return;
    }
    downloadRef.current = null;
    setStep('installing');
    try {
      await installApk(file);
      setStep('notInstalled');
    } catch (e) {
      setError(`Android's installer didn't open: ${e.message}`);
      setStep('failed');
    }
  };

  const cancelDownload = () => {
    const download = downloadRef.current;
    downloadRef.current = null;
    download?.cancel();
    setStep('offer');
  };

  const sizeMb = update.asset ? Math.round(update.asset.size / MB) : 0;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={step === 'downloading' ? () => {} : close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Update available: {update.label}</Text>
          <Text style={styles.muted}>You have {runningLabel(runningBuild())}.</Text>

          {step === 'offer' && (
            <>
              {!!update.notes && (
                <ScrollView style={styles.notes}>
                  <Text style={styles.notesText}>{update.notes}</Text>
                </ScrollView>
              )}
              {Platform.OS === 'android' && update.asset && canInstallApk() ? (
                <>
                  <Text style={styles.text}>{`Downloads the ${sizeMb} MB APK and opens Android's installer. Your models and chats stay.`}</Text>
                  <View style={styles.buttons}>
                    <Button label="LATER" onPress={later} />
                    <Button label="UPDATE" onPress={startUpdate} primary />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.text}>
                    {Platform.OS === 'ios'
                      ? "iPhones can't install updates from inside an app. Download the .ipa from the release page and sideload it again with Sideloadly or AltStore."
                      : !update.asset
                        ? 'This release has no APK attached (its Android build may have failed). The release page has what there is.'
                        : "This build of the app can't install updates itself. Download the APK from the release page and open it."}
                  </Text>
                  <View style={styles.buttons}>
                    <Button label="LATER" onPress={later} />
                    <Button label="RELEASE PAGE" onPress={() => openReleasePage(update)} primary />
                  </View>
                </>
              )}
            </>
          )}

          {step === 'downloading' && (
            <>
              <Text style={styles.text}>Downloading {update.asset.name}…</Text>
              <View style={styles.progressBarBg}>
                <View style={[styles.progressBarFill, { width: `${Math.min(100, progress * 100)}%` }]} />
              </View>
              <View style={styles.buttons}>
                <Text style={[styles.muted, { flex: 1, marginBottom: 0 }]}>
                  {(progress * 100).toFixed(1)}% of {sizeMb} MB
                </Text>
                <Button label="CANCEL" onPress={cancelDownload} />
              </View>
            </>
          )}

          {step === 'installing' && <Text style={styles.text}>{"Opening Android's installer…"}</Text>}

          {step === 'notInstalled' && (
            <>
              <Text style={styles.text}>{"The update wasn't installed."}</Text>
              <Text style={styles.text}>
                {"If Android said this app isn't allowed to install apps: open Settings, turn on \"Allow from this source\" " +
                  'for Odysseus, come back and tap Try again.'}
              </Text>
              <Text style={styles.text}>
                {'If it said the app conflicts with an existing package, the copy on this phone was signed with a different ' +
                  'key (an EAS build). It has to be uninstalled first, which deletes its models and chats.'}
              </Text>
              <View style={styles.buttons}>
                <Button label="CLOSE" onPress={close} />
                <Button label="SETTINGS" onPress={openInstallSettings} />
                <Button label="TRY AGAIN" onPress={startUpdate} primary />
              </View>
            </>
          )}

          {step === 'failed' && (
            <>
              <Text style={styles.text}>The update failed: {error}</Text>
              <View style={styles.buttons}>
                <Button label="CLOSE" onPress={close} />
                <Button label="RELEASE PAGE" onPress={() => openReleasePage(update)} />
                <Button label="TRY AGAIN" onPress={startUpdate} primary />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = themed(() => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 16,
    maxHeight: '85%',
  },
  title: {
    color: theme.colors.red,
    fontFamily: monoFont,
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  muted: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
    marginBottom: 12,
  },
  notes: {
    maxHeight: 220,
    backgroundColor: theme.colors.bg,
    borderRadius: 6,
    padding: 10,
    marginBottom: 12,
  },
  notesText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 18,
  },
  text: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 18,
  },
  button: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 13,
    fontWeight: 'bold',
  },
  progressBarBg: {
    width: '100%',
    height: 8,
    backgroundColor: theme.colors.bg,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: theme.colors.red,
  },
}));
