import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Modal, Platform } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useState, useEffect, useRef } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useLlama } from './src/hooks/useLlama';
import CookbookMenu from './src/components/CookbookMenu';
import theme from './theme.json';

export default function App() {
  const [modelUri, setModelUri] = useState('');
  const [inputText, setInputText] = useState('');
  const [chatLog, setChatLog] = useState([]);

  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [isCookbookVisible, setIsCookbookVisible] = useState(false);
  const [modalTab, setModalTab] = useState('cookbook');
  const [localModels, setLocalModels] = useState([]);

  const { isReady, isInitializing, isGenerating, error, loadModel, generate, releaseModel } = useLlama();

  const downloadResumableRef = useRef(null);

  const pauseResumeDownload = async () => {
    if (!downloadResumableRef.current) return;
    try {
      if (isPaused) {
        setIsPaused(false);
        setDownloadStatus(`Resuming download...`);
        const result = await downloadResumableRef.current.resumeAsync();
        if (result && result.uri) {
          setDownloadStatus(`Download complete! Loading into RAM...`);
          setModelUri(result.uri);
          await loadModel(result.uri);
          setIsDownloading(false);
        }
      } else {
        await downloadResumableRef.current.pauseAsync();
        setIsPaused(true);
        setDownloadStatus('Download paused.');
      }
    } catch (e) {
      console.log('Failed to toggle pause:', e);
    }
  };

  const cancelDownload = async () => {
    if (downloadResumableRef.current) {
      try {
        await downloadResumableRef.current.cancelAsync();
        setIsDownloading(false);
        setIsPaused(false);
        setDownloadStatus('Download cancelled.');
      } catch (e) {
        console.log('Failed to cancel download:', e);
      }
    }
  };

  // Clean up model from memory when app closes
  useEffect(() => {
    return () => {
      releaseModel();
    };
  }, []);

  useEffect(() => {
    scanLocalModels();
  }, [isDownloading]); // Re-scan when download finishes or cancels

  const scanLocalModels = async () => {
    try {
      const files = await FileSystem.readDirectoryAsync(FileSystem.documentDirectory);
      const ggufFiles = files.filter(f => f.toLowerCase().endsWith('.gguf'));

      const fileDetails = await Promise.all(ggufFiles.map(async f => {
        const info = await FileSystem.getInfoAsync(FileSystem.documentDirectory + f);
        return {
          name: f,
          uri: FileSystem.documentDirectory + f,
          size: info.size, // bytes
        };
      }));
      setLocalModels(fileDetails);
    } catch (e) {
      console.log('Failed to scan local models', e);
    }
  };

  const deleteLocalModel = async (uri) => {
    try {
      await FileSystem.deleteAsync(uri);
      scanLocalModels();
    } catch (e) {
      console.log('Failed to delete model', e);
    }
  };

  const pickModel = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true, // Needs to be local to device for llama.rn to read
      });

      if (!result.canceled && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        // In Expo, the URI from document picker usually has 'file://' prefix which llama.rn handles
        setModelUri(uri);
        await loadModel(uri);
      }
    } catch (err) {
      console.error('Failed to pick model:', err);
    }
  };

  const downloadAndLoadModel = async (model) => {
    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      setDownloadStatus(`Querying HuggingFace for ${model.name}...`);

      const treeRes = await fetch(`https://huggingface.co/api/models/${model.id}/tree/main`);
      if (!treeRes.ok) throw new Error("Failed to fetch model tree from HuggingFace");
      const tree = await treeRes.json();

      let file = tree.find(f => f.path.toLowerCase().includes('q4_k_m.gguf'));
      if (!file) file = tree.find(f => f.path.toLowerCase().endsWith('.gguf'));
      if (!file) throw new Error("No .gguf file found in this repo.");

      const downloadUrl = `https://huggingface.co/${model.id}/resolve/main/${file.path}`;
      const localUri = FileSystem.documentDirectory + file.path.split('/').pop();

      // @ts-ignore - Supress IDE warning (SDK >54 prefers File API but getInfoAsync is perfectly stable)
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (fileInfo.exists) {
        setDownloadStatus(`Found locally. Loading from cache...`);
        setModelUri(localUri);
        await loadModel(localUri);
        setIsDownloading(false);
        return;
      }

      setDownloadStatus(`Downloading ${file.path}...`);
      const downloadResumable = FileSystem.createDownloadResumable(
        downloadUrl,
        localUri,
        {},
        (progress) => {
          const percent = (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 100;
          setDownloadProgress(percent);
        }
      );
      downloadResumableRef.current = downloadResumable;

      const result = await downloadResumable.downloadAsync();

      if (result && result.uri) {
        setDownloadStatus(`Download complete! Loading into RAM...`);
        setModelUri(result.uri);
        await loadModel(result.uri);
        setIsDownloading(false);
      }
    } catch (err) {
      console.log(`App Alert: Download failed: ${err.message}`);
      if (err.message && err.message.toLowerCase().includes('cancel')) {
        // Ignored deliberate cancel
      } else {
        alert(`Download failed: ${err.message}`);
      }
      setIsDownloading(false);
    }
  };

  const sendMessage = async () => {
    if (!inputText.trim() || !isReady || isGenerating) return;

    const userMsg = inputText.trim();
    setInputText('');
    setChatLog(prev => [...prev, { role: 'user', text: userMsg }]);

    // Add an empty assistant message that we will stream into
    setChatLog(prev => [...prev, { role: 'assistant', text: '' }]);

    const prompt = `You are a helpful assistant running natively on a phone.\nUser: ${userMsg}\nAssistant:`;

    await generate(prompt, (token) => {
      setChatLog(prev => {
        const newLog = [...prev];
        const lastIndex = newLog.length - 1;
        newLog[lastIndex].text += token;
        return newLog;
      });
    });
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />

        {/* Header Area: Model Management */}
        <View style={styles.header}>
          <Text style={styles.title}>Odysseus Mobile</Text>
          <Text style={styles.subtitle}>On-Device LLM Inference</Text>

          {error && <Text style={styles.errorText}>Error: {error}</Text>}

          <TouchableOpacity
            style={[styles.modelBtn, { backgroundColor: theme.colors.panel, borderWidth: 1, borderColor: theme.colors.border }]}
            onPress={() => setIsCookbookVisible(true)}
            disabled={isInitializing || isGenerating}
          >
            <Text style={styles.modelBtnText}>Cookbook</Text>
          </TouchableOpacity>

          {isReady && <Text style={styles.statusText}>✅ Model Loaded in RAM</Text>}
        </View>

        <Modal
          visible={isCookbookVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setIsCookbookVisible(false)}
        >
          <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
            {/* Header & Close Button */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
              <View style={{ flexDirection: 'row', gap: 20 }}>
                <TouchableOpacity onPress={() => setModalTab('cookbook')}>
                  <Text style={{ color: modalTab === 'cookbook' ? theme.colors.red : theme.colors.border, fontSize: 16, fontWeight: 'bold', fontFamily: monoFont }}>[DOWNLOADS]</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setModalTab('local')}>
                  <Text style={{ color: modalTab === 'local' ? theme.colors.red : theme.colors.border, fontSize: 16, fontWeight: 'bold', fontFamily: monoFont }}>[MODELS]</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => setIsCookbookVisible(false)}>
                <Text style={{ color: theme.colors.fg, fontSize: 16, fontWeight: 'bold', fontFamily: monoFont }}>[X]</Text>
              </TouchableOpacity>
            </View>

            {modalTab === 'cookbook' ? (
              <CookbookMenu onSelectModel={(model) => {
                setModalTab('local');
                downloadAndLoadModel(model);
              }} />
            ) : (
              <ScrollView style={{ flex: 1, padding: 15 }}>
                <TouchableOpacity
                  style={[styles.modelBtn, { marginBottom: 20 }, isInitializing && styles.btnDisabled]}
                  onPress={() => { setIsCookbookVisible(false); pickModel(); }}
                  disabled={isInitializing || isGenerating}
                >
                  {isInitializing ? (
                    <ActivityIndicator color={theme.colors.fg} />
                  ) : (
                    <Text style={styles.modelBtnText}>
                      {isReady ? 'Load Different Model (.gguf)' : 'Pick & Load Model (.gguf)'}
                    </Text>
                  )}
                </TouchableOpacity>

                {isDownloading && (
                  <View style={[styles.downloadContainer, { marginHorizontal: 0, marginTop: 0, marginBottom: 20 }]}>
                    <Text style={styles.downloadStatus}>{downloadStatus}</Text>
                    <View style={styles.progressBarBg}>
                      <View style={[styles.progressBarFill, { width: `${downloadProgress}%` }]} />
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
                      <Text style={styles.downloadPercent}>{downloadProgress.toFixed(1)}%</Text>
                      <View style={{ flexDirection: 'row', gap: 15 }}>
                        <TouchableOpacity onPress={pauseResumeDownload}>
                          <Text style={{ color: theme.colors.fg, fontFamily: monoFont, fontSize: 12, fontWeight: 'bold' }}>
                            {isPaused ? '[RESUME]' : '[PAUSE]'}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={cancelDownload}>
                          <Text style={{ color: theme.colors.red, fontFamily: monoFont, fontSize: 12, fontWeight: 'bold' }}>[CANCEL]</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                )}
                {localModels.length === 0 && !isDownloading ? (
                  <Text style={{ color: theme.colors.border, fontFamily: monoFont, textAlign: 'center', marginTop: 20 }}>No models downloaded yet.</Text>
                ) : (
                  localModels.map((m, i) => (
                    <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, backgroundColor: theme.colors.panel, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }}>
                      <TouchableOpacity style={{ flex: 1 }} onPress={() => { setIsCookbookVisible(false); setModelUri(m.uri); loadModel(m.uri); }}>
                        <Text style={{ color: theme.colors.fg, fontFamily: monoFont, fontSize: 14 }} numberOfLines={1}>{m.name}</Text>
                        <Text style={{ color: theme.colors.border, fontFamily: monoFont, fontSize: 12, marginTop: 4 }}>{(m.size / 1e9).toFixed(2)} GB</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => deleteLocalModel(m.uri)} style={{ padding: 8 }}>
                        <Text style={{ color: theme.colors.red, fontFamily: monoFont, fontWeight: 'bold' }}>[DEL]</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </ScrollView>
            )}
          </SafeAreaView>
        </Modal>



        {/* Chat Area */}
        <ScrollView style={styles.chatArea} contentContainerStyle={{ paddingBottom: 20 }}>
          {chatLog.map((msg, index) => (
            <View key={index} style={[styles.messageBubble, msg.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
              <Text style={styles.messageText}>{msg.text}</Text>
            </View>
          ))}
          {isGenerating && <Text style={styles.generatingText}>Assistant is thinking...</Text>}
        </ScrollView>

        {/* Input Area */}
        <View style={styles.inputArea}>
          <TextInput
            style={styles.input}
            placeholder={isReady ? "Ask something..." : "Load a model first..."}
            placeholderTextColor="#355a66"
            value={inputText}
            onChangeText={setInputText}
            editable={isReady && !isGenerating}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!isReady || isGenerating || !inputText.trim()) && styles.btnDisabled]}
            onPress={sendMessage}
            disabled={!isReady || isGenerating || !inputText.trim()}
          >
            <Text style={styles.sendBtnText}>Send</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  header: {
    padding: 20,
    backgroundColor: theme.colors.panel,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    alignItems: 'flex-start',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: theme.colors.red,
    fontFamily: monoFont,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.border,
    marginBottom: 15,
    fontFamily: monoFont,
  },
  modelBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    width: '100%',
    alignItems: 'flex-start',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  modelBtnText: {
    color: theme.colors.fg,
    fontWeight: '600',
    fontSize: 16,
    fontFamily: monoFont,
  },
  statusText: {
    marginTop: 10,
    color: theme.colors.fg,
    fontWeight: '500',
    fontFamily: monoFont,
  },
  errorText: {
    color: theme.colors.red,
    marginBottom: 10,
    fontFamily: monoFont,
  },
  chatArea: {
    flex: 1,
    padding: 15,
  },
  messageBubble: {
    maxWidth: '85%',
    padding: 12,
    borderRadius: 16,
    marginBottom: 10,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderBottomLeftRadius: 4,
  },
  messageText: {
    fontSize: 16,
    color: theme.colors.fg,
    fontFamily: monoFont,
  },
  generatingText: {
    color: theme.colors.border,
    fontStyle: 'italic',
    marginTop: 5,
    fontFamily: monoFont,
  },
  inputArea: {
    flexDirection: 'row',
    padding: 15,
    backgroundColor: theme.colors.panel,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    color: theme.colors.fg,
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 10,
    fontSize: 16,
    marginRight: 10,
    fontFamily: monoFont,
  },
  sendBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 20,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  sendBtnText: {
    color: theme.colors.red,
    fontWeight: '600',
    fontFamily: monoFont,
  },
  downloadContainer: {
    padding: 20,
    backgroundColor: theme.colors.panel,
    marginHorizontal: 15,
    marginTop: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'flex-start',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  downloadStatus: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.fg,
    marginBottom: 12,
    textAlign: 'left',
    fontFamily: monoFont,
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
  downloadPercent: {
    fontSize: 12,
    color: theme.colors.fg,
    fontWeight: '700',
    fontFamily: monoFont,
  }
});
