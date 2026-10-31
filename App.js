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
  AppState,
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
import CookbookHint from './src/components/CookbookHint';
import McpPanel from './src/components/McpPanel';
import ToolCallCard from './src/components/ToolCallCard';
import ThinkingBlock from './src/components/ThinkingBlock';
import { runAgentTurn, buildAgentSystemPrompt, trimHistory } from './src/mcp/agentLoop';
import { chatLogToMessages } from './src/mcp/chatLog';
import { setAgentMode } from './src/mcp/runtime';
import { COMFORTABLE_RAM_SHARE, pickGgufFile } from './src/cookbook/ggufPicker';
import { SYSTEM_RAM_GB } from './src/cookbook/catalog';
import { collectLoadFailure, offerLoadFailureReport, recordModelSource, takeInterruptedLoad, takeInterruptedReply } from './src/diagnostics/loadDiagnostics';
import { clearPendingDownload, loadPendingDownloads, partUriFor, resumeDataFor, savePendingDownload } from './src/downloads/pendingDownload';
import { displayToolName } from './src/mcp/manager';
import { addWorkActionListener, dismissFinishedWork, startWork, stopWork, updateWork } from './modules/background-work';
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
const formatGB = (bytes) => `${(bytes / GB).toFixed(2)} GB`;

// The user isn't looking at the app, so finished work gets its own notification.
const isAway = () => AppState.currentState !== 'active';

const tail = (text, max) => (text.length > max ? `…${text.slice(-max)}` : text);

// A reply's notification while it's being written (Android; see modules/background-work).
// It shows the end of the reply so far, since that's the part that changes.
const startReplyWork = (question) => {
  startWork('generation', { title: 'Odysseus is replying', text: tail(question, 120) });
  return {
    update: (text, title = 'Odysseus is replying') => updateWork('generation', { title, text: tail(text, 500) || '…' }),
    finish: (text) => stopWork('generation', isAway() && text.trim() ? { title: 'Odysseus replied', text: tail(text.trim(), 1000) } : undefined),
  };
};

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

// The model's file name, e.g. "Qwen3-4B-Q4_K_M.gguf". Each assistant message stores the one
// that wrote it, so its sender doesn't change when a different model is loaded later.
const modelFileName = (uri) => (uri ? decodeURIComponent(uri.split('/').pop()) : '');

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

  // Downloads in progress, each with its own row in the Models tab: { id, finalUri, phase, progress, status }.
  const [downloads, setDownloads] = useState([]);
  const isDownloading = downloads.length > 0;
  // Downloads that were cut off, resumable from the Models tab. One that's running again shows
  // as a running download instead.
  const [pendingDownloads, setPendingDownloads] = useState([]);
  const interruptedDownloads = pendingDownloads.filter(p => !downloads.some(d => d.finalUri === p.finalUri));
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

  // With no model loaded, a tap on the chat or the input bar draws an arrow to the Cookbook.
  const cookbookBtnRef = useRef(null);
  const cookbookHintRef = useRef(null);
  const tapStartRef = useRef(null);
  const hintTap = {
    onTouchStart: (e) => {
      const { pageX, pageY } = e.nativeEvent;
      tapStartRef.current = { pageX, pageY, at: Date.now() };
    },
    onTouchEnd: (e) => {
      const start = tapStartRef.current;
      tapStartRef.current = null;
      if (!start || isReady || isInitializing || isDownloading) return;
      const { pageX, pageY } = e.nativeEvent;
      // Only taps: not scrolls or long presses.
      if (Math.hypot(pageX - start.pageX, pageY - start.pageY) > 10 || Date.now() - start.at > 600) return;
      cookbookHintRef.current?.show(pageX, pageY);
    },
  };
  // Each download's working state by id: its model and file, its DownloadResumable, its phase
  // ('querying', 'downloading', 'paused', 'loading') and the bytes written so far.
  const downloadsRef = useRef(new Map());
  const nextDownloadIdRef = useRef(0);
  // Whether the downloads' notification is up (Android; see syncDownloadWork).
  const downloadWorkStartedRef = useRef(false);
  // Model loads waiting their turn (see handleLoadModel).
  const modelLoadQueueRef = useRef(Promise.resolve());
  // Latest values for callbacks that outlive a render (AppState changes, notification buttons).
  const latestRef = useRef({});
  // iOS: a reply was cut off because the app left the screen; the model is reloaded on return.
  const reloadAfterBackgroundRef = useRef(false);
  // The reply being written (a promise), so the iOS reload can wait for it to finish.
  const activeSendRef = useRef(null);
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


  // One load at a time: downloads that finish together would otherwise load at once, and two
  // models in RAM can be more than the phone has. The last one to load stays loaded.
  const handleLoadModel = (uri) => {
    const load = modelLoadQueueRef.current.then(() => loadModelNow(uri));
    modelLoadQueueRef.current = load.catch(() => {});
    return load;
  };

  const loadModelNow = async (uri) => {
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
    return !failure;
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
      // The app closed mid-reply (usually the phone ran out of memory; iOS keeps no crash log
      // for that). The model itself loaded fine, so it's still loaded again below.
      const interruptedReply = await takeInterruptedReply();
      if (interruptedReply) {
        offerLoadFailureReport(await collectLoadFailure({
          kind: 'crash',
          uri: interruptedReply.uri,
          log: interruptedReply.log,
          settings: LOAD_SETTINGS,
          reply: interruptedReply.reply,
        }));
      }
      const uri = await AsyncStorage.getItem('last_model_uri');
      if (uri) {
        handleLoadModel(uri);
      }
    })().catch(e => console.log(`App Alert: Startup model load failed: ${e.message}`));
  }, []);

  const patchDownload = (id, patch) =>
    setDownloads(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));

  const isDownloadActive = (finalUri) => [...downloadsRef.current.values()].some(d => d.finalUri === finalUri);

  // All downloads share one notification (Android): the total of the running ones, or else the
  // model being loaded once its download is done. `done` is posted when the last one ends.
  const syncDownloadWork = (done) => {
    const entries = [...downloadsRef.current.values()];
    const running = entries.filter(d => d.phase === 'downloading');
    const loading = entries.find(d => d.phase === 'loading');
    let content = null;
    if (running.length > 0) {
      const written = running.reduce((sum, d) => sum + d.written, 0);
      const total = running.reduce((sum, d) => sum + d.file.size, 0);
      content = {
        title: running.length === 1 ? `Downloading ${running[0].model.name}` : `Downloading ${running.length} models`,
        text: `${formatGB(written)} of ${formatGB(total)}`,
        progress: (written / total) * 100,
      };
    } else if (loading) {
      // The notification stays up while the model loads, so loading also isn't cut off.
      content = { title: `Loading ${loading.model.name}`, text: 'Loading into memory…' };
    }
    if (!content) {
      // Nothing runs while paused, so paused downloads don't keep the phone awake.
      if (downloadWorkStartedRef.current || done) stopWork('download', done);
      downloadWorkStartedRef.current = false;
    } else if (downloadWorkStartedRef.current) {
      updateWork('download', content);
    } else {
      downloadWorkStartedRef.current = true;
      startWork('download', content);
    }
  };

  // Forget a download that finished, failed or was cancelled, and list what it left on disk.
  const removeDownload = (id, done) => {
    if (!downloadsRef.current.delete(id)) return;
    setDownloads(prev => prev.filter(d => d.id !== id));
    syncDownloadWork(done);
    scanLocalModels();
  };

  const failDownload = async (id, err) => {
    const entry = downloadsRef.current.get(id);
    if (!entry) return;
    const cancelled = !!err.message && err.message.toLowerCase().includes('cancel');
    console.log(`App Alert: Download failed: ${err.message}`);
    removeDownload(id, isAway() && !cancelled ? { title: 'Download stopped', text: `${entry.model.name}: open the app to resume it.` } : undefined);
    if (cancelled) return;
    const pending = entry.finalUri ? await loadPendingDownloads(isDownloadActive).catch(() => []) : [];
    const resumable = pending.some(p => p.finalUri === entry.finalUri);
    alert(`Download of ${entry.model.name} failed: ${err.message}${resumable ? '\n\nWhat was downloaded is kept, so you can resume it from the list.' : ''}`);
  };

  // Runs a download, or a paused one resumed, until it finishes or fails. It also returns when
  // the download is paused or cancelled: whatever did that has already updated it.
  const runDownload = async (id, start) => {
    try {
      const result = await start();
      if (result && result.uri) await finishDownload(id, result.uri);
    } catch (err) {
      failDownload(id, err);
    }
  };

  const pauseResumeDownload = async (id) => {
    const entry = downloadsRef.current.get(id);
    if (!entry?.resumable) return;
    if (entry.phase === 'paused') {
      entry.phase = 'downloading';
      patchDownload(id, { phase: 'downloading', status: `Downloading ${entry.file.path}...` });
      syncDownloadWork();
      await runDownload(id, () => entry.resumable.resumeAsync());
    } else if (entry.phase === 'downloading' && !entry.pausing) {
      entry.pausing = true;
      try {
        await entry.resumable.pauseAsync();
        entry.phase = 'paused';
        patchDownload(id, { phase: 'paused', status: `Paused: ${entry.file.path}` });
        syncDownloadWork();
      } catch (e) {
        failDownload(id, e);
      } finally {
        entry.pausing = false;
      }
    }
  };

  const cancelDownload = async (id) => {
    const entry = downloadsRef.current.get(id);
    if (!entry?.resumable || (entry.phase !== 'downloading' && entry.phase !== 'paused')) return;
    try {
      await entry.resumable.cancelAsync();
      // Discarded while still counted as running, so the list never shows it as interrupted.
      await discardPendingDownload(entry.finalUri);
      removeDownload(id);
    } catch (e) {
      console.log(`App Alert: Failed to cancel download: ${e.message}`);
      alert(`Failed to cancel download: ${e.message}`);
    }
  };

  // The notification's Cancel button, for the downloads it shows: the running ones.
  const cancelRunningDownloads = () =>
    Promise.all([...downloadsRef.current].filter(([, d]) => d.phase === 'downloading').map(([id]) => cancelDownload(id)));

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

  // Downloads re-scan when they end (removeDownload).
  useEffect(() => {
    scanLocalModels();
  }, []);

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
      setPendingDownloads(await loadPendingDownloads(isDownloadActive));
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
  // exactly: even a slightly short GGUF fails to load. Only then does the .part file get the
  // model's real name, so the Models list never shows a half-downloaded file.
  const finishDownload = async (id, uri) => {
    const entry = downloadsRef.current.get(id);
    if (!entry) return;
    const { model, file, finalUri } = entry;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.size !== file.size) {
      const got = info.exists ? formatGB(info.size) : '0 GB';
      // Bigger than expected means the server ignored the resume and sent the whole file
      // again after the part already on disk: that file can't be repaired.
      if (info.exists && info.size > file.size) await FileSystem.deleteAsync(uri, { idempotent: true });
      throw new Error(`The download is incomplete (${got} of ${formatGB(file.size)}).`);
    }
    let modelPath = uri;
    if (uri !== finalUri) {
      await FileSystem.moveAsync({ from: uri, to: finalUri });
      modelPath = finalUri;
    }
    await clearPendingDownload(finalUri);
    await recordModelSource(modelPath, { origin: model.recommended ? 'recommended' : 'cookbook', repo: model.id, path: file.path, expectedSize: file.size });
    entry.phase = 'loading';
    patchDownload(id, { phase: 'loading', progress: 100, status: `Loading ${file.path.split('/').pop()} into RAM...` });
    syncDownloadWork();
    const loaded = await handleLoadModel(modelPath);
    removeDownload(id, isAway()
      ? loaded
        ? { title: 'Model ready', text: `${model.name} is downloaded and loaded.` }
        : { title: 'Model downloaded', text: `${model.name} downloaded but didn't load. Open the app for details.` }
      : undefined);
  };

  // Delete what was downloaded so far and forget the interrupted download.
  const discardPendingDownload = async (finalUri) => {
    await FileSystem.deleteAsync(partUriFor(finalUri), { idempotent: true });
    await clearPendingDownload(finalUri);
    setPendingDownloads(prev => prev.filter(p => p.finalUri !== finalUri));
  };

  // Continue an interrupted download: the same repo and exactly the same file, so the bytes
  // already on disk still belong to it.
  const resumePendingDownload = (pending) => {
    setPendingDownloads(prev => prev.filter(p => p.finalUri !== pending.finalUri));
    downloadAndLoadModel({ ...pending.model, file: pending.file.path });
  };

  const downloadAndLoadModel = async (model) => {
    const id = ++nextDownloadIdRef.current;
    const entry = { model, file: null, finalUri: null, resumable: null, phase: 'querying', written: 0 };
    downloadsRef.current.set(id, entry);
    setDownloads(prev => [...prev, { id, finalUri: null, phase: 'querying', progress: 0, status: `Querying HuggingFace for ${model.name}...` }]);
    try {
      // recursive=true: some repos keep each quantization in its own folder.
      const treeRes = await fetch(`https://huggingface.co/api/models/${model.id}/tree/main?recursive=true`);
      if (!treeRes.ok) throw new Error("Failed to fetch model tree from HuggingFace");
      const tree = await treeRes.json();

      // Leave room for the system, like the Cookbook's RAM estimate does, and go for a
      // higher-quality file when one is small enough to run comfortably.
      const maxBytes = Device.totalMemory ? Device.totalMemory - SYSTEM_RAM_GB * GB : undefined;
      const comfortableBytes = Device.totalMemory ? Device.totalMemory * COMFORTABLE_RAM_SHARE : undefined;
      const pick = pickGgufFile(tree, model.file, maxBytes, comfortableBytes);
      if (!pick.ok) throw new Error(pick.error);
      const file = pick.file;
      if (!pick.fits && !(await confirmLargeDownload(file))) {
        removeDownload(id);
        return;
      }

      const expectedSize = file.size;
      const downloadUrl = `https://huggingface.co/${model.id}/resolve/main/${file.path.split('/').map(encodeURIComponent).join('/')}`;
      const fileName = file.path.split('/').pop();
      const finalUri = FileSystem.documentDirectory + fileName;
      const partUri = partUriFor(finalUri);
      // Two downloads of the same file would write into the same .part file.
      if (isDownloadActive(finalUri)) {
        removeDownload(id);
        alert(`${fileName} is already downloading.`);
        return;
      }
      Object.assign(entry, { file, finalUri });
      patchDownload(id, { finalUri });

      // @ts-ignore
      const fileInfo = await FileSystem.getInfoAsync(finalUri);
      if (fileInfo.exists) {
        if (fileInfo.size === expectedSize) {
          await finishDownload(id, finalUri);
          return;
        }
        // A wrong-sized file under the final name, left by an older version of the app.
        await FileSystem.deleteAsync(finalUri, { idempotent: true });
      }

      // Pick up where an interrupted download stopped, where the platform allows it.
      const partInfo = await FileSystem.getInfoAsync(partUri);
      const resumeData = partInfo.exists ? resumeDataFor(partInfo.size, expectedSize) : undefined;
      if (partInfo.exists && !resumeData) await FileSystem.deleteAsync(partUri, { idempotent: true });
      await savePendingDownload({
        url: downloadUrl,
        partUri,
        finalUri,
        model: { id: model.id, name: model.name, recommended: !!model.recommended },
        file,
      });

      const startedAt = resumeData ? Number(resumeData) : 0;
      entry.phase = 'downloading';
      entry.written = startedAt;
      patchDownload(id, {
        phase: 'downloading',
        progress: (startedAt / expectedSize) * 100,
        status: resumeData ? `Resuming ${file.path} at ${formatGB(startedAt)}...` : `Downloading ${file.path}...`,
      });
      // Keeps the download going with the screen off (Android); shows its progress as a notification.
      syncDownloadWork();
      entry.resumable = FileSystem.createDownloadResumable(
        downloadUrl,
        partUri,
        {
          sessionType: FileSystem.FileSystemSessionType.BACKGROUND
        },
        (progress) => {
          // Against the known file size: the server's content length is only the part still to come.
          entry.written = progress.totalBytesWritten;
          patchDownload(id, { progress: (progress.totalBytesWritten / expectedSize) * 100 });
          syncDownloadWork();
        },
        resumeData
      );
    } catch (err) {
      failDownload(id, err);
      return;
    }
    await runDownload(id, () => entry.resumable.downloadAsync());
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

  // Callbacks registered once (below) read the current functions and values from here.
  useEffect(() => {
    latestRef.current = { isBusy, modelUri, handleLoadModel, stopGeneration, cancelRunningDownloads, updateLastAssistant };
  });

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const latest = latestRef.current;
      if (state === 'active') {
        dismissFinishedWork();
        // iOS took the GPU away mid-reply. llama.cpp's Metal backend then fails every later
        // reply until it's recreated, which means loading the model again, once the stopped
        // reply has wound down (reloading frees the context it's still using).
        if (reloadAfterBackgroundRef.current) {
          reloadAfterBackgroundRef.current = false;
          Promise.resolve(activeSendRef.current)
            .catch(() => {})
            .then(() => latestRef.current.modelUri && latestRef.current.handleLoadModel(latestRef.current.modelUri));
        }
        return;
      }
      // iOS doesn't let apps use the GPU in the background, so a reply can't continue there.
      // Stop it while the app is still on its way out. (Android keeps going: see startReplyWork.)
      if (Platform.OS === 'ios' && latest.isBusy) {
        reloadAfterBackgroundRef.current = true;
        latest.updateLastAssistant({ stoppedInBackground: true });
        latest.stopGeneration();
      }
    });
    return () => sub.remove();
  }, []);

  // Buttons on the background notifications.
  useEffect(() => {
    const sub = addWorkActionListener((action) => {
      if (action === 'cancel-download') latestRef.current.cancelRunningDownloads?.();
    });
    return () => sub.remove();
  }, []);

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
    const reply = startReplyWork(userMsg);
    let replyText = '';

    const onEvent = (event) => {
      if (!isLive()) return;
      const time = formatTime(new Date());
      switch (event.type) {
        case 'round_start':
          if (event.round > 1) setChatLog(prev => [...prev, { role: 'assistant', text: '', time, model: modelFileName(modelUri) }]);
          break;
        case 'content':
          updateLastAssistant({ text: event.text });
          reply.update(event.text);
          scrollViewRef.current?.scrollToEnd({ animated: false });
          break;
        case 'reasoning':
          updateLastAssistant({ reasoning: event.text });
          reply.update(event.text, 'Odysseus is thinking');
          scrollViewRef.current?.scrollToEnd({ animated: false });
          break;
        case 'assistant':
          if (event.content) replyText = event.content;
          updateLastAssistant({
            text: event.content,
            ...(event.reasoning ? { reasoning: event.reasoning } : {}),
            ...(event.toolCalls.length ? { toolCalls: event.toolCalls } : {}),
          });
          break;
        case 'tool_call':
          reply.update(
            event.needsApproval ? `${displayToolName(event.call.name)} needs your OK. Open the app to allow or deny it.` : `Running ${displayToolName(event.call.name)}…`,
            event.needsApproval ? 'Odysseus is waiting for you' : 'Odysseus is using a tool'
          );
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
      reply.finish(replyText);
      if (isLive()) {
        activeAgentRunRef.current = null;
        clearPendingApprovals(false);
      }
      setIsAgentRunning(false);
    }
  };

  const sendMessageNow = async () => {
    if (!inputText.trim() || !isReady || isBusy) return;

    const userMsg = inputText.trim();
    setInputText('');

    // Capture current log before adding new messages to build context
    const currentLog = [...chatLog];

    const timeStr = formatTime(new Date());
    setChatLog(prev => [...prev, { role: 'user', text: userMsg, time: timeStr }, { role: 'assistant', text: '', time: timeStr, model: modelFileName(modelUri) }]);

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
    // Any model with a usable chat template (toolSupport is 'none' only without one) answers through
    // it, thinking on or off, so the turn takes the agent path without tools. A bare "User: /
    // Assistant:" transcript makes many models write both sides of the conversation (a Gemma 3 1B
    // GLM-4.7-Flash fine-tune on an OPPO A53 did), so the plain prompt below is only the fallback.
    if (toolSupport !== 'none') {
      await runAgent(userMsg, currentLog, { offerTools: false });
      return;
    }

    // Build context-aware prompt (tool cards and empty tool-calling turns from agent mode are skipped)
    let prompt = systemPrompt + "\n\n";
    currentLog.filter(msg => (msg.role === 'user' || msg.role === 'assistant') && msg.text).forEach(msg => {
      prompt += (msg.role === 'user' ? 'User: ' : 'Assistant: ') + msg.text + "\n";
    });
    prompt += `User: ${userMsg}\nAssistant:`;

    const reply = startReplyWork(userMsg);
    let replyText = '';
    await generate(prompt, (token) => {
      replyText += token;
      reply.update(replyText);
      setChatLog(prev => {
        const newLog = [...prev];
        const lastIndex = newLog.length - 1;
        newLog[lastIndex].text += token;
        return newLog;
      });
      scrollViewRef.current?.scrollToEnd({ animated: false });
    });
    reply.finish(replyText);
  };

  // Every send goes through here so the reply in progress can be awaited (see the iOS reload).
  const sendMessage = () => {
    const send = sendMessageNow();
    activeSendRef.current = send;
    send.finally(() => {
      if (activeSendRef.current === send) activeSendRef.current = null;
    });
    return send;
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
            {/* Wrapped so the Cookbook hint can measure where the button is */}
            <View ref={cookbookBtnRef} collapsable={false}>
              <TouchableOpacity onPress={() => setIsCookbookVisible(true)} style={styles.cookbookHeaderBtn}>
                <Text style={styles.cookbookHeaderBtnText}>Cookbook</Text>
              </TouchableOpacity>
            </View>
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

                  {downloads.map(d => (
                    <View key={d.id} style={[styles.downloadContainer, { marginHorizontal: 0, marginTop: 0, marginBottom: 20 }]}>
                      <Text style={styles.downloadStatus}>{d.status}</Text>
                      <View style={styles.progressBarBg}>
                        <View style={[styles.progressBarFill, { width: `${d.progress}%` }]} />
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
                        <Text style={styles.downloadPercent}>{d.progress.toFixed(1)}%</Text>
                        {(d.phase === 'downloading' || d.phase === 'paused') && (
                          <View style={{ flexDirection: 'row', gap: 15 }}>
                            <TouchableOpacity onPress={() => pauseResumeDownload(d.id)}>
                              <Text style={{ color: theme.colors.fg, fontFamily: monoFont, fontSize: 12, fontWeight: 'bold' }}>
                                {d.phase === 'paused' ? '[RESUME]' : '[PAUSE]'}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => cancelDownload(d.id)}>
                              <Text style={{ color: theme.colors.red, fontFamily: monoFont, fontSize: 12, fontWeight: 'bold' }}>[CANCEL]</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    </View>
                  ))}
                  {interruptedDownloads.map(p => (
                    <View key={p.finalUri} style={[styles.downloadContainer, { marginHorizontal: 0, marginTop: 0, marginBottom: 20 }]}>
                      <Text style={styles.downloadStatus}>Download interrupted: {p.model.name}</Text>
                      <View style={styles.progressBarBg}>
                        <View style={[styles.progressBarFill, { width: `${Math.min(100, (p.bytesOnDisk / p.file.size) * 100)}%` }]} />
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
                        <Text style={styles.downloadPercent}>{formatGB(p.bytesOnDisk)} of {formatGB(p.file.size)}</Text>
                        <View style={{ flexDirection: 'row', gap: 15 }}>
                          <TouchableOpacity onPress={() => resumePendingDownload(p)}>
                            {/* iOS can only resume within one session, so there it starts over. */}
                            <Text style={{ color: theme.colors.fg, fontFamily: monoFont, fontSize: 12, fontWeight: 'bold' }}>
                              {Platform.OS === 'android' ? '[RESUME]' : '[RESTART]'}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => discardPendingDownload(p.finalUri)}>
                            <Text style={{ color: theme.colors.red, fontFamily: monoFont, fontSize: 12, fontWeight: 'bold' }}>[DEL]</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>
                  ))}
                  {localModels.length === 0 && !isDownloading && interruptedDownloads.length === 0 ? (
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
            {...hintTap}
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
                      • {msg.role === 'user' ? 'You' : (msg.model || 'Assistant')}
                      {msg.time && <Text style={{ color: theme.colors.border, fontWeight: 'normal' }}>  {msg.time}</Text>}
                    </Text>
                  </View>
                  {!!msg.reasoning && <ThinkingBlock text={msg.reasoning} live={isStreaming && !msg.text} />}
                  {(!!body || !msg.reasoning) && (
                    <Text style={styles.messageText} selectable={true}>
                      {body}
                    </Text>
                  )}
                  {msg.stoppedInBackground && (
                    <Text style={styles.stoppedNote}>{"Stopped when the app left the screen: iOS doesn't let apps use the GPU in the background."}</Text>
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
          <View style={styles.inputContainer} {...hintTap}>
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
                  <Text style={styles.dropdownItemText}>MCP</Text>
                </TouchableOpacity>
              </Animated.View>
            )}
            <View style={styles.inputWrapper}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2, marginLeft: 42, marginRight: 4 }}>
                <View style={[styles.modelPill, { flexShrink: 1, borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0, backgroundColor: 'transparent', height: 16 }]}>
                  <Text style={[styles.modelPillText, { flexShrink: 1, fontSize: 10, color: theme.colors.border }]} numberOfLines={1}>
                    {modelFileName(modelUri) || 'No Model Loaded'}
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
        <CookbookHint ref={cookbookHintRef} targetRef={cookbookBtnRef} />
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
  stoppedNote: {
    marginTop: 8,
    fontSize: 11,
    color: theme.colors.border,
    fontFamily: monoFont,
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
