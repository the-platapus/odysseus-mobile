import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Modal,
  Platform,
  KeyboardAvoidingView,
  Keyboard,
  Animated,
  LayoutAnimation,
  UIManager,
  Easing,
  Alert,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { useState, useEffect, useRef, useCallback } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Device from 'expo-device';
import { useLlama, LOAD_SETTINGS } from './src/hooks/useLlama';
import { useChatStore } from './src/hooks/useChatStore';
import { useMcp } from './src/hooks/useMcp';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CookbookMenu from './src/components/CookbookMenu';
import McpPanel from './src/components/McpPanel';
import ToolCallCard from './src/components/ToolCallCard';
import ThinkingBlock from './src/components/ThinkingBlock';
import { runAgentTurn, buildAgentSystemPrompt, trimHistory } from './src/mcp/agentLoop';
import { chatLogToMessages } from './src/mcp/chatLog';
import { setAgentMode } from './src/mcp/runtime';
import { pickGgufFile } from './src/cookbook/ggufPicker';
import { SYSTEM_RAM_GB } from './src/cookbook/catalog';
import { collectLoadFailure, offerLoadFailureReport, recordModelSource, takeInterruptedLoad } from './src/diagnostics/loadDiagnostics';
import theme from './theme.json';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Clean dampened ease-in / ease-out (smooth, cushioned motion without bounce)
const dampenedEase = Easing.bezier(0.25, 0.1, 0.25, 1);

// Characters of earlier conversation sent with an agent turn (~1.5k tokens), leaving room in
// the 4k context for tool schemas, tool results and the reply.
const AGENT_HISTORY_CHARS = 6000;

const GB = 1024 ** 3;

// Ask before downloading a file that's bigger than the phone can likely hold.
const confirmLargeDownload = (file) => new Promise(resolve => {
  const ram = Device.totalMemory ? `${Math.round(Device.totalMemory / GB)} GB` : 'an unknown amount';
  Alert.alert(
    'Model may be too big',
    `${file.path.split('/').pop()} is ${(file.size / GB).toFixed(1)} GB and this phone has ${ram} of RAM, so it will probably fail to load. Download anyway?`,
    [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Download', onPress: () => resolve(true) },
    ],
    { cancelable: true, onDismiss: () => resolve(false) }
  );
});

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
  const [isMcpVisible, setIsMcpVisible] = useState(false);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [pendingApprovalIds, setPendingApprovalIds] = useState(() => new Set());

  const [isThinkingOn, setIsThinkingOn] = useState(false);

  const { isReady, isInitializing, isGenerating, error, toolSupport, supportsThinking, loadModel, generate, chat, stop, releaseModel } = useLlama();
  const mcp = useMcp();
  const isBusy = isGenerating || isAgentRunning;
  // The switch is remembered for every model; it only applies to models that can think.
  const thinking = supportsThinking && isThinkingOn;

  // Agent turn bookkeeping: tool-call id -> resolver of its approval prompt, tool names the
  // user allowed for the whole chat, the stop flag, and a token for the running turn.
  const approvalResolversRef = useRef(new Map());
  const chatApprovalsRef = useRef(new Set());
  const stopRequestedRef = useRef(false);
  const activeAgentRunRef = useRef(null);

  const inputRef = useRef(null);
  const downloadResumableRef = useRef(null);
  // The model and file being downloaded, for when the download finishes (directly or after a resume).
  const currentDownloadRef = useRef(null);
  const scrollViewRef = useRef(null);

  const menuAnim = useRef(new Animated.Value(0)).current;
  const sidebarAnim = useRef(new Animated.Value(0)).current;
  const promptModalAnim = useRef(new Animated.Value(0)).current;

  const toggleMenu = (show) => {
    const nextVal = typeof show === 'boolean' ? show : !isMenuVisible;
    if (nextVal) {
      setIsMenuVisible(true);
      Animated.timing(menuAnim, {
        toValue: 1,
        duration: 200,
        easing: dampenedEase,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(menuAnim, {
        toValue: 0,
        duration: 150,
        easing: dampenedEase,
        useNativeDriver: true,
      }).start(() => {
        setIsMenuVisible(false);
      });
    }
  };

  const openSidebar = () => {
    setIsSidebarVisible(true);
    Animated.timing(sidebarAnim, {
      toValue: 1,
      duration: 240,
      easing: dampenedEase,
      useNativeDriver: true,
    }).start();
  };

  const closeSidebar = () => {
    Animated.timing(sidebarAnim, {
      toValue: 0,
      duration: 180,
      easing: dampenedEase,
      useNativeDriver: true,
    }).start(() => {
      setIsSidebarVisible(false);
    });
  };

  const openPromptModal = () => {
    setIsSystemPromptModalVisible(true);
    Animated.timing(promptModalAnim, {
      toValue: 1,
      duration: 220,
      easing: dampenedEase,
      useNativeDriver: true,
    }).start();
  };

  const closePromptModal = () => {
    Animated.timing(promptModalAnim, {
      toValue: 0,
      duration: 160,
      easing: dampenedEase,
      useNativeDriver: true,
    }).start(() => {
      setIsSystemPromptModalVisible(false);
    });
  };

  const changeModalTab = (tab) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setModalTab(tab);
  };


  const handleLoadModel = async (uri) => {
    setModelUri(uri);
    try {
      await AsyncStorage.setItem('last_model_uri', uri);
    } catch(e) {
      console.log(`App Alert: Failed to save last model: ${e.message}`);
      alert(`Failed to save last model: ${e.message}`);
    }
    const failure = await loadModel(uri);
    if (failure) {
      // Don't retry a failing model on every launch.
      AsyncStorage.removeItem('last_model_uri').catch(() => {});
      offerLoadFailureReport(await collectLoadFailure({
        kind: 'error',
        uri,
        error: failure.message,
        log: failure.log,
        settings: LOAD_SETTINGS,
      }));
    }
  };

  useEffect(() => {
    AsyncStorage.getItem('thinking_mode').then(value => setIsThinkingOn(value === 'on')).catch(() => {});
  }, []);

  const toggleThinking = () => {
    const next = !isThinkingOn;
    setIsThinkingOn(next);
    AsyncStorage.setItem('thinking_mode', next ? 'on' : 'off').catch(e => {
      console.log(`App Alert: Failed to save thinking mode: ${e.message}`);
    });
  };

  // Load last model on startup, unless loading it last time never finished: then it probably
  // crashed the app, and loading it again would crash it again.
  useEffect(() => {
    (async () => {
      const interrupted = await takeInterruptedLoad();
      if (interrupted) {
        await AsyncStorage.removeItem('last_model_uri').catch(() => {});
        offerLoadFailureReport(await collectLoadFailure({
          kind: 'crash',
          uri: interrupted.uri,
          log: interrupted.log,
          settings: LOAD_SETTINGS,
        }));
        return;
      }
      const uri = await AsyncStorage.getItem('last_model_uri');
      if (uri) {
        handleLoadModel(uri);
      }
    })().catch(e => console.log(`App Alert: Startup model load failed: ${e.message}`));
  }, []);

  const pauseResumeDownload = async () => {
    if (!downloadResumableRef.current) return;
    try {
      if (isPaused) {
        setIsPaused(false);
        setDownloadStatus(`Resuming download...`);
        const result = await downloadResumableRef.current.resumeAsync();
        if (result && result.uri) {
          await finishDownload(result.uri);
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

  // Auto-scroll when keyboard appears or disappears
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 50);
    });

    const hideSub = Keyboard.addListener(hideEvent, () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Auto-scroll when new messages appear in chatLog
  useEffect(() => {
    if (chatLog.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 60);
    }
  }, [chatLog.length]);

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

  // Shared by a straight download and one resumed after a pause. The size must match
  // exactly: even a slightly short GGUF fails to load.
  const finishDownload = async (uri) => {
    const { model, file } = currentDownloadRef.current ?? {};
    const info = await FileSystem.getInfoAsync(uri);
    if (file?.size && (!info.exists || info.size !== file.size)) {
      const got = info.exists ? (info.size / GB).toFixed(2) : '0';
      throw new Error(`The download is incomplete (${got} of ${(file.size / GB).toFixed(2)} GB). Please download it again.`);
    }
    if (model && file) {
      await recordModelSource(uri, { origin: model.recommended ? 'recommended' : 'cookbook', repo: model.id, path: file.path, expectedSize: file.size });
    }
    setDownloadStatus(`Download complete! Loading into RAM...`);
    await handleLoadModel(uri);
  };

  const downloadAndLoadModel = async (model) => {
    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      setDownloadStatus(`Querying HuggingFace for ${model.name}...`);

      // recursive=true: some repos keep each quantization in its own folder.
      const treeRes = await fetch(`https://huggingface.co/api/models/${model.id}/tree/main?recursive=true`);
      if (!treeRes.ok) throw new Error("Failed to fetch model tree from HuggingFace");
      const tree = await treeRes.json();

      // Leave room for the system, like the Cookbook's RAM estimate does.
      const maxBytes = Device.totalMemory ? Device.totalMemory - SYSTEM_RAM_GB * GB : undefined;
      const pick = pickGgufFile(tree, model.file, maxBytes);
      if (!pick.ok) throw new Error(pick.error);
      const file = pick.file;
      if (!pick.fits && !(await confirmLargeDownload(file))) {
        setIsDownloading(false);
        return;
      }
      currentDownloadRef.current = { model, file };

      const expectedSize = file.size;
      const downloadUrl = `https://huggingface.co/${model.id}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      const localUri = FileSystem.documentDirectory + file.path.split('/').pop();

      // @ts-ignore
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (fileInfo.exists) {
        if (fileInfo.size === expectedSize) {
          setDownloadStatus(`Found locally. Loading from cache...`);
          await finishDownload(localUri);
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
        await finishDownload(result.uri);
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

  const handleKeyPress = (e) => {
    // Only send on Ctrl+Enter or Cmd+Enter from physical keyboards
    // On virtual keyboards, Enter/Return key always inserts a newline!
    if (e.nativeEvent.key === 'Enter' && (e.nativeEvent.ctrlKey || e.nativeEvent.metaKey)) {
      if (inputText.trim() && isReady && !isBusy) {
        if (e.preventDefault) e.preventDefault();
        sendMessage();
      }
    }
  };

  const clearPendingApprovals = useCallback((approved) => {
    for (const resolve of approvalResolversRef.current.values()) resolve(approved);
    approvalResolversRef.current.clear();
    setPendingApprovalIds(new Set());
  }, []);

  const resolveApproval = (id, approved, allowToolForChat) => {
    const resolve = approvalResolversRef.current.get(id);
    if (!resolve) return;
    approvalResolversRef.current.delete(id);
    setPendingApprovalIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (allowToolForChat) chatApprovalsRef.current.add(allowToolForChat);
    resolve(approved);
  };

  const stopGeneration = useCallback(async () => {
    stopRequestedRef.current = true;
    clearPendingApprovals(false);
    try {
      await stop();
    } catch (e) {
      console.log(`App Alert: Failed to stop: ${e.message}`);
    }
  }, [clearPendingApprovals, stop]);

  // Approvals given "for this chat" end with the chat, and so does a running agent turn, so
  // its remaining events can't land in the chat being opened.
  useEffect(() => {
    chatApprovalsRef.current = new Set();
    if (activeAgentRunRef.current) {
      activeAgentRunRef.current = null;
      stopGeneration();
    }
  }, [currentSessionId, stopGeneration]);

  const updateLastAssistant = (patch) => setChatLog(prev => {
    const next = [...prev];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role === 'assistant') {
        next[i] = { ...next[i], ...patch };
        break;
      }
    }
    return next;
  });

  const updateToolEntry = (id, patch) =>
    setChatLog(prev => prev.map(entry => (entry.role === 'tool' && entry.id === id ? { ...entry, ...patch } : entry)));

  // Agent mode: the agent loop drives llama.rn with the MCP tools and reports each step,
  // which becomes assistant bubbles and tool cards in the chat log. With offerTools false it
  // is a single templated chat turn (used for thinking, which needs the model's template).
  const runAgent = async (userMsg, currentLog, { offerTools = true } = {}) => {
    const run = {};
    activeAgentRunRef.current = run;
    const isLive = () => activeAgentRunRef.current === run;
    stopRequestedRef.current = false;
    setIsAgentRunning(true);

    const system = offerTools ? buildAgentSystemPrompt(systemPrompt, mcp.manager, mcp.disabled) : systemPrompt;
    const messages = trimHistory(chatLogToMessages([...currentLog, { role: 'user', text: userMsg }], system), AGENT_HISTORY_CHARS);

    const onEvent = (event) => {
      if (!isLive()) return;
      const time = formatTime(new Date());
      switch (event.type) {
        case 'round_start':
          if (event.round > 1) setChatLog(prev => [...prev, { role: 'assistant', text: '', time }]);
          break;
        case 'content':
          updateLastAssistant({ text: event.text });
          scrollViewRef.current?.scrollToEnd({ animated: false });
          break;
        case 'reasoning':
          updateLastAssistant({ reasoning: event.text });
          scrollViewRef.current?.scrollToEnd({ animated: false });
          break;
        case 'assistant':
          updateLastAssistant({
            text: event.content,
            ...(event.reasoning ? { reasoning: event.reasoning } : {}),
            ...(event.toolCalls.length ? { toolCalls: event.toolCalls } : {}),
          });
          break;
        case 'tool_call':
          setChatLog(prev => [...prev, {
            role: 'tool',
            id: event.call.id,
            name: event.call.name,
            args: event.call.rawArgs,
            status: event.needsApproval ? 'approval' : 'running',
            time,
          }]);
          break;
        case 'tool_running':
          updateToolEntry(event.id, { status: 'running' });
          break;
        case 'tool_result':
          updateToolEntry(event.id, {
            status: event.denied ? 'denied' : event.result.isError ? 'error' : 'done',
            output: event.result.output,
          });
          break;
      }
    };

    try {
      await runAgentTurn({
        complete: (request) => chat(request, { thinking }),
        manager: mcp.manager,
        messages,
        disabled: mcp.disabled,
        offerTools,
        requestApproval: (call) => new Promise(resolve => {
          if (stopRequestedRef.current || !isLive()) return resolve(false);
          approvalResolversRef.current.set(call.id, resolve);
          setPendingApprovalIds(prev => new Set(prev).add(call.id));
        }),
        isPreApproved: (call) => chatApprovalsRef.current.has(call.name),
        isStopped: () => stopRequestedRef.current || !isLive(),
        onEvent,
      });
    } catch (err) {
      const msg = err.message || 'Agent turn failed';
      console.log(`App Alert: Agent turn failed: ${msg}`);
      alert(`Agent turn failed: ${msg}`);
    } finally {
      if (isLive()) {
        activeAgentRunRef.current = null;
        clearPendingApprovals(false);
      }
      setIsAgentRunning(false);
    }
  };

  const sendMessage = async () => {
    if (!inputText.trim() || !isReady || isBusy) return;

    const userMsg = inputText.trim();
    setInputText('');

    // Capture current log before adding new messages to build context
    const currentLog = [...chatLog];

    const timeStr = formatTime(new Date());
    setChatLog(prev => [...prev, { role: 'user', text: userMsg, time: timeStr }, { role: 'assistant', text: '', time: timeStr }]);

    // Keep input focused so keyboard stays open without dismissal
    inputRef.current?.focus();

    // Scroll to the new message immediately
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 50);

    if (mcp.settings.agentMode && toolSupport !== 'none') {
      await runAgent(userMsg, currentLog);
      return;
    }
    // Thinking goes through the model's chat template, so the turn takes the agent path without tools.
    if (thinking) {
      await runAgent(userMsg, currentLog, { offerTools: false });
      return;
    }

    // Build context-aware prompt (tool cards and empty tool-calling turns from agent mode are skipped)
    let prompt = systemPrompt + "\n\n";
    currentLog.filter(msg => (msg.role === 'user' || msg.role === 'assistant') && msg.text).forEach(msg => {
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
      scrollViewRef.current?.scrollToEnd({ animated: false });
    });
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>

          {/* Minimal Top Bar */}
          <View style={styles.topBar}>
            <View style={styles.logoContainer}>
              <TouchableOpacity onPress={openSidebar} style={{ marginRight: 15, padding: 4 }}>
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
            animationType="none"
            transparent={true}
            onRequestClose={closeSidebar}
          >
            <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', flexDirection: 'row', opacity: sidebarAnim }}>
              <Animated.View
                style={{
                  width: '75%',
                  height: '100%',
                  backgroundColor: theme.colors.bg,
                  borderRightWidth: 1,
                  borderColor: theme.colors.border,
                  transform: [
                    {
                      translateX: sidebarAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-300, 0],
                      }),
                    },
                  ],
                }}
              >
                <SafeAreaView style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 15, borderBottomWidth: 1, borderColor: theme.colors.border, alignItems: 'center' }}>
                    <Text style={{ color: theme.colors.fg, fontSize: 16, fontFamily: monoFont, fontWeight: 'bold' }}>Chat History</Text>
                    <TouchableOpacity onPress={closeSidebar}>
                      <Text style={{ color: theme.colors.fg, fontSize: 16, fontFamily: monoFont, fontWeight: 'bold' }}>[X]</Text>
                    </TouchableOpacity>
                  </View>
                  
                  <TouchableOpacity 
                    style={{ margin: 15, padding: 12, backgroundColor: theme.colors.panel, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }} 
                    onPress={() => { createNewSession(); closeSidebar(); }}
                  >
                    <Text style={{ color: theme.colors.fg, fontFamily: monoFont, textAlign: 'center', fontWeight: 'bold' }}>+ New Conversation</Text>
                  </TouchableOpacity>
                  
                  <ScrollView style={{ flex: 1 }}>
                    {sessions.map(s => (
                      <View key={s.id} style={{ flexDirection: 'row', padding: 15, borderBottomWidth: 1, borderColor: theme.colors.panel, backgroundColor: currentSessionId === s.id ? theme.colors.panel : 'transparent' }}>
                        <TouchableOpacity style={{ flex: 1 }} onPress={() => { loadSession(s.id); closeSidebar(); }}>
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
                </SafeAreaView>
              </Animated.View>
              <TouchableOpacity style={{ flex: 1 }} onPress={closeSidebar} />
            </Animated.View>
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
                  <TouchableOpacity onPress={() => changeModalTab('cookbook')}>
                    <Text style={{ color: modalTab === 'cookbook' ? theme.colors.red : theme.colors.border, fontSize: 16, fontWeight: 'bold', fontFamily: monoFont }}>[DOWNLOADS]</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => changeModalTab('local')}>
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
                    disabled={isInitializing || isBusy}
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
            onLayout={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
            style={styles.chatArea}
            contentContainerStyle={{ paddingBottom: 16 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {chatLog.map((msg, index) => {
              if (msg.role === 'tool') {
                return (
                  <ToolCallCard
                    key={index}
                    entry={msg}
                    canApprove={pendingApprovalIds.has(msg.id)}
                    onApprove={() => resolveApproval(msg.id, true)}
                    onApproveForChat={() => resolveApproval(msg.id, true, msg.name)}
                    onDeny={() => resolveApproval(msg.id, false)}
                  />
                );
              }
              // A round that only called tools has no text; its tool cards stand in for it.
              if (msg.role === 'assistant' && !msg.text && !msg.reasoning && msg.toolCalls?.length) return null;
              const isStreaming = isBusy && index === chatLog.length - 1;
              const body = msg.text || (isStreaming && !msg.reasoning ? "..." : "");
              return (
                <View key={index} style={[styles.messageWrapper, msg.role === 'user' ? styles.userWrapper : styles.assistantWrapper]}>
                  <View style={styles.messageHeader}>
                    <Text style={[styles.messageSender, { color: msg.role === 'user' ? theme.colors.fg : '#6bc46d' }]}>
                      • {msg.role === 'user' ? 'You' : (modelUri ? decodeURIComponent(modelUri.split('/').pop()) : 'Assistant')}
                      {msg.time && <Text style={{ color: theme.colors.border, fontWeight: 'normal' }}>  {msg.time}</Text>}
                    </Text>
                  </View>
                  {!!msg.reasoning && <ThinkingBlock text={msg.reasoning} live={isStreaming && !msg.text} />}
                  {(!!body || !msg.reasoning) && (
                    <Text style={styles.messageText} selectable={true}>
                      {body}
                    </Text>
                  )}
                </View>
              );
            })}
          </ScrollView>

          {/* MCP Tools Modal */}
          <Modal
            visible={isMcpVisible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={() => setIsMcpVisible(false)}
          >
            <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
              <McpPanel onClose={() => setIsMcpVisible(false)} toolSupport={toolSupport} isModelReady={isReady} />
            </SafeAreaView>
          </Modal>

          {/* System Prompt Modal */}
          <Modal
            visible={isSystemPromptModalVisible}
            animationType="fade"
            transparent={true}
            onRequestClose={closePromptModal}
          >
            <View style={styles.modalOverlay}>
              <Animated.View
                style={[
                  styles.promptModalContent,
                  {
                    opacity: promptModalAnim,
                    transform: [
                      {
                        scale: promptModalAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.93, 1],
                        }),
                      },
                      {
                        translateY: promptModalAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [10, 0],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <Text style={styles.promptModalTitle}>System Prompt</Text>
                <TextInput
                  style={styles.promptInput}
                  value={systemPrompt}
                  onChangeText={setSystemPrompt}
                  multiline
                />
                <TouchableOpacity
                  style={styles.promptSaveBtn}
                  onPress={closePromptModal}
                >
                  <Text style={styles.promptSaveBtnText}>Save</Text>
                </TouchableOpacity>
              </Animated.View>
            </View>
          </Modal>

          {/* Backdrop when dropdown menu is visible */}
          {isMenuVisible && (
            <Animated.View style={[styles.menuBackdrop, { opacity: menuAnim }]}>
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={() => toggleMenu(false)}
              />
            </Animated.View>
          )}

          {/* Input Area */}
          <View style={styles.inputContainer}>
            {/* Dropdown Menu */}
            {isMenuVisible && (
              <Animated.View
                style={[
                  styles.dropdownMenu,
                  {
                    opacity: menuAnim,
                    transform: [
                      {
                        translateY: menuAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [8, 0],
                        }),
                      },
                      {
                        scale: menuAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.94, 1],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <TouchableOpacity
                  onPress={() => {
                    toggleMenu(false);
                    openPromptModal();
                  }}
                  style={styles.dropdownItem}
                >
                  <Text style={styles.dropdownItemText}>System Prompt</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    toggleMenu(false);
                    setIsMcpVisible(true);
                  }}
                  style={styles.dropdownItem}
                >
                  <Text style={styles.dropdownItemText}>Tools (MCP)</Text>
                </TouchableOpacity>
              </Animated.View>
            )}
            <View style={styles.inputWrapper}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2, marginLeft: 42, marginRight: 4 }}>
                <View style={[styles.modelPill, { flexShrink: 1, borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0, backgroundColor: 'transparent', height: 16 }]}>
                  <Text style={[styles.modelPillText, { flexShrink: 1, fontSize: 10, color: theme.colors.border }]} numberOfLines={1}>
                    {modelUri ? decodeURIComponent(modelUri.split('/').pop()) : 'No Model Loaded'}
                  </Text>
                  <Text style={[styles.modelPillIcon, { fontSize: 8 }]}>v</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginLeft: 8 }}>
                  {/* Shown only for models that can think */}
                  {supportsThinking && (
                    <TouchableOpacity onPress={toggleThinking} disabled={isBusy} hitSlop={8}>
                      <Text style={[styles.modelPillText, { fontSize: 10, marginRight: 0, color: isThinkingOn ? '#6bc46d' : theme.colors.border }]}>
                        {isThinkingOn ? 'think: on' : 'think: off'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {/* Tap toggles agent mode, long-press opens the tool settings */}
                  <TouchableOpacity
                    onPress={() => setAgentMode(!mcp.settings.agentMode)}
                    onLongPress={() => setIsMcpVisible(true)}
                    disabled={isBusy}
                    hitSlop={8}
                  >
                    <Text
                      style={[styles.modelPillText, { fontSize: 10, marginRight: 0, color: mcp.settings.agentMode && toolSupport !== 'none' ? '#6bc46d' : theme.colors.border }]}
                      numberOfLines={1}
                    >
                      {!mcp.settings.agentMode
                        ? 'agent: off'
                        : isReady && toolSupport === 'none'
                          ? 'agent: no tool support'
                          : `agent · ${mcp.enabledToolCount} tools`}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                <TouchableOpacity
                  style={styles.plusBtn}
                  onPress={() => toggleMenu()}
                >
                  <Text style={styles.plusBtnText}>+</Text>
                </TouchableOpacity>
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  placeholder={!isReady ? "Load a model first..." : isBusy ? "Assistant is thinking..." : "Message Odysseus..."}
                  placeholderTextColor={theme.colors.border}
                  value={inputText}
                  onChangeText={setInputText}
                  onKeyPress={handleKeyPress}
                  editable={isReady}
                  multiline
                />
                {/* While generating (or an agent turn runs) this is the stop button */}
                <TouchableOpacity
                  style={[styles.sendBtn, !isBusy && (!isReady || !inputText.trim()) && styles.btnDisabled]}
                  onPress={() => {
                    if (isBusy) {
                      stopGeneration();
                      return;
                    }
                    sendMessage();
                    inputRef.current?.focus();
                  }}
                  disabled={!isBusy && (!isReady || !inputText.trim())}
                >
                  <Text style={styles.sendBtnText}>{isBusy ? '■' : '↑'}</Text>
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
    paddingHorizontal: 15,
    paddingTop: 6,
    paddingBottom: Platform.OS === 'ios' ? 10 : 12,
    backgroundColor: theme.colors.bg,
    zIndex: 100,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 99,
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
    left: 12,
    marginBottom: 8,
    width: 150,
    zIndex: 101,
    elevation: 5,
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
