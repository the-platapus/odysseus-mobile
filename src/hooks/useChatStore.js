import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSIONS_INDEX_KEY = 'ody_sessions_index';
const SESSION_PREFIX = 'ody_session_';

// Generate a simple unique ID
const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

export function useChatStore() {
  const [sessions, setSessions] = useState([]); // List of { id, title, updatedAt }
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [chatLog, setChatLog] = useState([]);
  const [isStoreReady, setIsStoreReady] = useState(false);

  // Initialize store on mount
  useEffect(() => {
    loadSessionsIndex().then(index => {
      setSessions(index);
      // Automatically load the most recent session or create a new one
      if (index.length > 0) {
        // Sort by newest first
        index.sort((a, b) => b.updatedAt - a.updatedAt);
        loadSession(index[0].id);
      } else {
        createNewSession();
      }
      setIsStoreReady(true);
    });
  }, []);

  // Fetch the index of all sessions
  const loadSessionsIndex = async () => {
    try {
      const data = await AsyncStorage.getItem(SESSIONS_INDEX_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.log(`App Alert: Failed to load sessions index: ${e.message}`);
      alert(`Failed to load sessions index: ${e.message}`);
      return [];
    }
  };

  // Save the index of all sessions
  const saveSessionsIndex = async (newIndex) => {
    try {
      await AsyncStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(newIndex));
      setSessions(newIndex);
    } catch (e) {
      console.log(`App Alert: Failed to save sessions index: ${e.message}`);
      alert(`Failed to save sessions index: ${e.message}`);
    }
  };

  // Create a brand new empty session
  const createNewSession = () => {
    setCurrentSessionId(generateId());
    setChatLog([]);
  };

  // Load a specific session's chat log
  const loadSession = async (id) => {
    try {
      const data = await AsyncStorage.getItem(SESSION_PREFIX + id);
      const loadedLog = data ? JSON.parse(data) : [];
      setCurrentSessionId(id);
      setChatLog(loadedLog);
    } catch (e) {
      console.log(`App Alert: Failed to load session: ${e.message}`);
      alert(`Failed to load session: ${e.message}`);
    }
  };

  // Save the current chat log (call this whenever chatLog updates)
  const saveCurrentSession = useCallback(async (action) => {
    if (!currentSessionId) return;

    setChatLog(prevLog => {
      const newChatLog = typeof action === 'function' ? action(prevLog) : action;

      // Handle the async storage in the background
      (async () => {
        if (newChatLog.length === 0) return;

        try {
          // 1. Save the actual chat messages
          await AsyncStorage.setItem(SESSION_PREFIX + currentSessionId, JSON.stringify(newChatLog));

          // 2. Update the index
          let index = await loadSessionsIndex();
          const existingIdx = index.findIndex(s => s.id === currentSessionId);
          
          // Auto-generate a title from the first user message if it exists
          const firstUserMsg = newChatLog.find(m => m.role === 'user');
          const title = firstUserMsg ? firstUserMsg.text.substring(0, 30) + (firstUserMsg.text.length > 30 ? '...' : '') : 'New Chat';

          const metadata = {
            id: currentSessionId,
            title,
            updatedAt: Date.now()
          };

          if (existingIdx >= 0) {
            index[existingIdx] = metadata;
          } else {
            index.push(metadata);
          }

          // Sort newest first
          index.sort((a, b) => b.updatedAt - a.updatedAt);
          await saveSessionsIndex(index);
          
        } catch (e) {
          console.log(`App Alert: Failed to save current session: ${e.message}`);
          alert(`Failed to save current session: ${e.message}`);
        }
      })();

      return newChatLog;
    });
  }, [currentSessionId]);

  // Delete a specific session
  const deleteSession = async (id) => {
    try {
      await AsyncStorage.removeItem(SESSION_PREFIX + id);
      let index = await loadSessionsIndex();
      index = index.filter(s => s.id !== id);
      await saveSessionsIndex(index);

      // If we deleted the active session, switch to another one or create new
      if (id === currentSessionId) {
        if (index.length > 0) {
          await loadSession(index[0].id);
        } else {
          createNewSession();
        }
      }
    } catch (e) {
      console.log(`App Alert: Failed to delete session: ${e.message}`);
      alert(`Failed to delete session: ${e.message}`);
    }
  };

  return {
    isStoreReady,
    sessions,
    currentSessionId,
    chatLog,
    setChatLog: saveCurrentSession, // Override raw setter with saving setter
    createNewSession,
    loadSession,
    deleteSession
  };
}
