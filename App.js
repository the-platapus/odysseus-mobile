import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Modal, Platform, KeyboardAvoidingView, Keyboard } from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useState, useEffect, useRef } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useLlama } from './src/hooks/useLlama';
import { useChatStore } from './src/hooks/useChatStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CookbookMenu from './src/components/CookbookMenu';
import theme from './theme.json';

const formatTime = (date) => {
  let h = date.getHours();
  let m = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  m = m < 10 ? '0' + m : m;
  return `${h}:${m} ${ampm}`;
};

export default function App() {
  const [modelUri, setModelUri] = useState('');
  const [inputText, setInputText] = useState('');
  
  const {
    isStoreReady,
    sessions,
    currentSessionId,
    chatLog,
    setChatLog,
    createNewSession,
    loadSession,
    deleteSession
  } = useChatStore();
  const [isSidebarVisible, setIsSidebarVisible] = useState(false);

  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const [isCookbookVisible, setIsCookbookVisible] = useState(false);
  const [modalTab, setModalTab] = useState('cookbook');
  const [localModels, setLocalModels] = useState([]);
  const [systemPrompt, setSystemPrompt] = useState('You are a helpful assistant running natively on a phone.');
  const [isMenuVisible, setIsMenuVisible] = useState(false);
  const [isSystemPromptModalVisible, setIsSystemPromptModalVisible] = useState(false);

  const { isReady, isInitializing, isGenerating, error, loadModel, generate, releaseModel } = useLlama();

  const downloadResumableRef = useRef(null);
  const scrollViewRef = useRef(null);


  const handleLoadModel = async (uri) => {
    setModelUri(uri);
    try {
      await AsyncStorage.setItem('last_model_uri', uri);
    } catch(e) {
      console.log(`App Alert: Failed to save last model: ${e.message}`);
      alert(`Failed to save last model: ${e.message}`);
    }
    await loadModel(uri);
  };

  // Load last model on startup
  useEffect(() => {
    AsyncStorage.getItem('last_model_uri').then(uri => {
      if (uri) {
        handleLoadModel(uri);
      }
    });
  }, []);

  const pauseResumeDownload = async () => {
    if (!downloadResumableRef.current) return;
    try {
      if (isPaused) {
        setIsPaused(false);
        setDownloadStatus(`Resuming download...`);
        const result = await downloadResumableRef.current.resumeAsync();
        if (result && result.uri) {
          setDownloadStatus(`Download complete! Loading into RAM...`);
          await handleLoadModel(result.uri);
          setIsDownloading(false);
        }
      } else {
        await downloadResumableRef.current.pauseAsync();
        setIsPaused(true);
        setDownloadStatus('Download paused.');
      }
    } catch (e) {
      console.log(`App Alert: Failed to toggle pause: ${e.message}`);
      alert(`Failed to toggle pause: ${e.message}`);
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
        console.log(`App Alert: Failed to cancel download: ${e.message}`);
        alert(`Failed to cancel download: ${e.message}`);
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
      console.log(`App Alert: Failed to scan local models: ${e.message}`);
      alert(`Failed to scan local models: ${e.message}`);
    }
  };

  const deleteLocalModel = async (uri) => {
    try {
      await FileSystem.deleteAsync(uri);
      scanLocalModels();
    } catch (e) {
      console.log(`App Alert: Failed to delete model: ${e.message}`);
      alert(`Failed to delete model: ${e.message}`);
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
        await handleLoadModel(uri);
      }
    } catch (err) {
      console.log(`App Alert: Failed to pick model: ${err.message}`);
      alert(`Failed to pick model: ${err.message}`);
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

      const expectedSize = file.size;
      const downloadUrl = `https://huggingface.co/${model.id}/resolve/main/${file.path}`;
      const localUri = FileSystem.documentDirectory + file.path.split('/').pop();

      // @ts-ignore
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (fileInfo.exists) {
        if (fileInfo.size === expectedSize) {
          setDownloadStatus(`Found locally. Loading from cache...`);
          await handleLoadModel(localUri);
          setIsDownloading(false);
          return;
        } else {
          // It's a partial file. It might be downloading natively in the background, or it was interrupted.
          // Since we can't safely resume a force-killed download without resumeData in Expo, we delete it to restart.
          await FileSystem.deleteAsync(localUri, { idempotent: true });
          setDownloadStatus(`Cleaning up partial download...`);
        }
      }

      setDownloadStatus(`Downloading ${file.path}...`);
      const downloadResumable = FileSystem.createDownloadResumable(
        downloadUrl,
        localUri,
        {
          sessionType: FileSystem.FileSystemSessionType.BACKGROUND
        },
        (progress) => {
          const percent = (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 100;
          setDownloadProgress(percent);
        }
      );
      downloadResumableRef.current = downloadResumable;

      const result = await downloadResumable.downloadAsync();

      if (result && result.uri) {
        // Double check size just to be bulletproof
        const finalInfo = await FileSystem.getInfoAsync(result.uri);
        if (finalInfo.exists && finalInfo.size >= expectedSize * 0.99) {
          setDownloadStatus(`Download complete! Loading into RAM...`);
          await handleLoadModel(result.uri);
        } else {
          throw new Error("Download completed but file size mismatch. It may have been corrupted.");
        }
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

    Keyboard.dismiss();

    const userMsg = inputText.trim();
    setInputText('');

    // Capture current log before adding new messages to build context
    const currentLog = [...chatLog];

    const timeStr = formatTime(new Date());
    setChatLog(prev => [...prev, { role: 'user', text: userMsg, time: timeStr }, { role: 'assistant', text: '', time: timeStr }]);

    // Build context-aware prompt
    let prompt = systemPrompt + "\n\n";
    currentLog.forEach(msg => {
      prompt += (msg.role === 'user' ? 'User: ' : 'Assistant: ') + msg.text + "\n";
    });
    prompt += `User: ${userMsg}\nAssistant:`;

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
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

          {/* Minimal Top Bar */}
          <View style={styles.topBar}>
            <View style={styles.logoContainer}>
              <TouchableOpacity onPress={() => setIsSidebarVisible(true)} style={{ marginRight: 15, padding: 4 }}>
                <Text style={{ color: theme.colors.fg, fontSize: 20 }}>☰</Text>
              </TouchableOpacity>
              <Text style={styles.appTitle}>odysseus-mobile</Text>
            </View>
            <View style={styles.topBarCenter}>
              {isReady && <Text style={styles.topBarStats}>ready • 0.0s</Text>}
            </View>
            <TouchableOpacity onPress={() => setIsCookbookVisible(true)} style={styles.cookbookHeaderBtn}>
              <Text style={styles.cookbookHeaderBtnText}>Cookbook</Text>
            </TouchableOpacity>
          </View>
          {error && <Text style={styles.errorText}>Error: {error}</Text>}


          {/* History Sidebar Modal */}
          <Modal
            visible={isSidebarVisible}
            animationType="fade"
            transparent={true}
            onRequestClose={() => setIsSidebarVisible(false)}
          >
            <SafeAreaView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', flexDirection: 'row' }}>
              <View style={{ width: '75%', height: '100%', backgroundColor: theme.colors.bg, borderRightWidth: 1, borderColor: theme.colors.border }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 15, borderBottomWidth: 1, borderColor: theme.colors.border, alignItems: 'center' }}>
                  <Text style={{ color: theme.colors.fg, fontSize: 16, fontFamily: monoFont, fontWeight: 'bold' }}>Chat History</Text>
                  <TouchableOpacity onPress={() => setIsSidebarVisible(false)}>
                    <Text style={{ color: theme.colors.fg, fontSize: 16, fontFamily: monoFont, fontWeight: 'bold' }}>[X]</Text>
                  </TouchableOpacity>
                </View>
                
                <TouchableOpacity 
                  style={{ margin: 15, padding: 12, backgroundColor: theme.colors.panel, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }} 
                  onPress={() => { createNewSession(); setIsSidebarVisible(false); }}
                >
                  <Text style={{ color: theme.colors.fg, fontFamily: monoFont, textAlign: 'center', fontWeight: 'bold' }}>+ New Conversation</Text>
                </TouchableOpacity>
                
                <ScrollView style={{ flex: 1 }}>
                  {sessions.map(s => (
                    <View key={s.id} style={{ flexDirection: 'row', padding: 15, borderBottomWidth: 1, borderColor: theme.colors.panel, backgroundColor: currentSessionId === s.id ? theme.colors.panel : 'transparent' }}>
                      <TouchableOpacity style={{ flex: 1 }} onPress={() => { loadSession(s.id); setIsSidebarVisible(false); }}>
                        <Text style={{ color: theme.colors.fg, fontFamily: monoFont, fontSize: 14, fontWeight: currentSessionId === s.id ? 'bold' : 'normal' }} numberOfLines={1}>{s.title}</Text>
                        <Text style={{ color: theme.colors.border, fontFamily: monoFont, fontSize: 12, marginTop: 4 }}>{new Date(s.updatedAt).toLocaleDateString()}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => deleteSession(s.id)} style={{ paddingLeft: 10, justifyContent: 'center' }}>
                        <Text style={{ color: theme.colors.red, fontFamily: monoFont, fontSize: 12, fontWeight: 'bold' }}>[DEL]</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                  {sessions.length === 0 && (
                     <Text style={{ color: theme.colors.border, fontFamily: monoFont, textAlign: 'center', marginTop: 20 }}>No history yet.</Text>
                  )}
                </ScrollView>
              </View>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => setIsSidebarVisible(false)} />
            </SafeAreaView>
          </Modal>

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
                        <TouchableOpacity style={{ flex: 1 }} onPress={() => { setIsCookbookVisible(false); handleLoadModel(m.uri); }}>
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
          <ScrollView
            ref={scrollViewRef}
            onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
            style={styles.chatArea}
            contentContainerStyle={{ paddingBottom: 100 }}
          >
            {chatLog.map((msg, index) => (
              <View key={index} style={[styles.messageWrapper, msg.role === 'user' ? styles.userWrapper : styles.assistantWrapper]}>
                <View style={styles.messageHeader}>
                  <Text style={[styles.messageSender, { color: msg.role === 'user' ? theme.colors.fg : '#6bc46d' }]}>
                    • {msg.role === 'user' ? 'You' : (modelUri ? decodeURIComponent(modelUri.split('/').pop()) : 'Assistant')}
                    {msg.time && <Text style={{ color: theme.colors.border, fontWeight: 'normal' }}>  {msg.time}</Text>}
                  </Text>
                </View>
                <Text style={styles.messageText} selectable={true}>
                  {msg.text || (isGenerating && index === chatLog.length - 1 ? "..." : "")}
                </Text>
              </View>
            ))}
          </ScrollView>

          {/* System Prompt Modal */}
          <Modal
            visible={isSystemPromptModalVisible}
            animationType="fade"
            transparent={true}
            onRequestClose={() => setIsSystemPromptModalVisible(false)}
          >
            <View style={styles.modalOverlay}>
              <View style={styles.promptModalContent}>
                <Text style={styles.promptModalTitle}>System Prompt</Text>
                <TextInput
                  style={styles.promptInput}
                  value={systemPrompt}
                  onChangeText={setSystemPrompt}
                  multiline
                />
                <TouchableOpacity
                  style={styles.promptSaveBtn}
                  onPress={() => setIsSystemPromptModalVisible(false)}
                >
                  <Text style={styles.promptSaveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>

          {/* Floating Input Area */}
          <View style={styles.inputContainer}>
            {/* Dropdown Menu */}
            {isMenuVisible && (
              <View style={styles.dropdownMenu}>
                <TouchableOpacity onPress={() => { setIsMenuVisible(false); setIsSystemPromptModalVisible(true); }} style={styles.dropdownItem}>
                  <Text style={styles.dropdownItemText}>System Prompt</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.inputWrapper}>
              <View style={{ flexDirection: 'row', marginBottom: 2, marginLeft: 42 }}>
                <View style={[styles.modelPill, { borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0, backgroundColor: 'transparent', height: 16 }]}>
                  <Text style={[styles.modelPillText, { fontSize: 10, color: theme.colors.border }]} numberOfLines={1}>
                    {modelUri ? decodeURIComponent(modelUri.split('/').pop()) : 'No Model Loaded'}
                  </Text>
                  <Text style={[styles.modelPillIcon, { fontSize: 8 }]}>v</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                <TouchableOpacity
                  style={styles.plusBtn}
                  onPress={() => setIsMenuVisible(!isMenuVisible)}
                >
                  <Text style={styles.plusBtnText}>+</Text>
                </TouchableOpacity>
                <TextInput
                  style={styles.input}
                  placeholder={!isReady ? "Load a model first..." : isGenerating ? "Assistant is thinking..." : "Message Odysseus..."}
                  placeholderTextColor={theme.colors.border}
                  value={inputText}
                  onChangeText={setInputText}
                  editable={isReady && !isGenerating}
                  multiline
                />
                <TouchableOpacity
                  style={[styles.sendBtn, (!isReady || isGenerating || !inputText.trim()) && styles.btnDisabled]}
                  onPress={sendMessage}
                  disabled={!isReady || isGenerating || !inputText.trim()}
                >
                  <Text style={styles.sendBtnText}>{'↑'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
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
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: 12,
    backgroundColor: theme.colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  appTitle: {
    color: theme.colors.red,
    fontFamily: monoFont,
    fontWeight: 'bold',
    fontSize: 16,
  },
  cookbookHeaderBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.colors.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    width: 100,
    alignItems: 'center',
  },
  cookbookHeaderBtnText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: '600',
  },
  topBarCenter: {
    flex: 1,
    alignItems: 'center',
  },
  topBarModelText: {
    color: theme.colors.fg,
    fontSize: 12,
    fontFamily: monoFont,
    fontWeight: '600',
  },
  topBarStats: {
    color: theme.colors.border,
    fontSize: 10,
    fontFamily: monoFont,
    marginTop: 2,
  },
  errorText: {
    color: theme.colors.red,
    padding: 15,
    fontFamily: monoFont,
    textAlign: 'center',
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
  chatArea: {
    flex: 1,
    padding: 15,
  },
  messageWrapper: {
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  userWrapper: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.bg,
    maxWidth: '85%',
  },
  assistantWrapper: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.panel,
    maxWidth: '95%',
  },
  messageHeader: {
    marginBottom: 8,
  },
  messageSender: {
    fontSize: 12,
    fontFamily: monoFont,
    fontWeight: 'bold',
  },
  messageText: {
    fontSize: 14,
    color: theme.colors.fg,
    fontFamily: monoFont,
    lineHeight: 20,
  },
  inputContainer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
  },
  inputWrapper: {
    flexDirection: 'column',
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  input: {
    flex: 1,
    color: theme.colors.fg,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 14,
    fontFamily: monoFont,
    maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: theme.colors.border,
    borderRadius: 20,
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  sendBtnText: {
    color: theme.colors.fg,
    fontSize: 16,
    fontWeight: 'bold',
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
  },
  plusBtn: {
    backgroundColor: theme.colors.bg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 4,
  },
  plusBtnText: {
    color: theme.colors.fg,
    fontSize: 18,
    fontFamily: monoFont,
  },
  dropdownMenu: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 8,
    position: 'absolute',
    bottom: '100%',
    left: 0,
    marginBottom: 8,
    width: 150,
  },
  dropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  dropdownItemText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  promptModalContent: {
    width: '80%',
    backgroundColor: theme.colors.panel,
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  promptModalTitle: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 15,
  },
  promptInput: {
    backgroundColor: theme.colors.bg,
    color: theme.colors.fg,
    borderRadius: 8,
    padding: 12,
    minHeight: 100,
    fontFamily: monoFont,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 15,
  },
  promptSaveBtn: {
    backgroundColor: theme.colors.bg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  promptSaveBtnText: {
    color: theme.colors.red,
    fontFamily: monoFont,
    fontWeight: 'bold',
  },
  modelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    maxWidth: 200,
  },
  modelPillText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    marginRight: 6,
  },
  modelPillIcon: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 10,
  }
});
