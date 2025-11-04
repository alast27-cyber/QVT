import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, addDoc, serverTimestamp, onSnapshot, orderBy, limit, getDocs } from 'firebase/firestore';
import { PhoneCall, Send, Bot, Volume2, Lock, Radio, Save, Archive, CpuChipIcon, ThermometerIcon } from 'lucide-react';

import GlassPanel from './GlassPanel'; // Make sure this path is correct for your project

// Define the global variables provided by the environment - now consumed by useNexusConfig (fix: remove "as any" TypeScript cast)
const __app_id =
  typeof window !== 'undefined' && typeof window.__app_id !== 'undefined'
    ? window.__app_id
    : 'default-app-id';
const __firebase_config =
  typeof window !== 'undefined' && typeof window.__firebase_config !== 'undefined'
    ? window.__firebase_config
    : null;
const __initial_auth_token =
  typeof window !== 'undefined' && typeof window.__initial_auth_token !== 'undefined'
    ? window.__initial_auth_token
    : null;
const __gemini_api_key =
  typeof window !== 'undefined' && typeof window.__gemini_api_key !== 'undefined'
    ? window.__gemini_api_key
    : '';

// --- Nexus Back Office Configuration Context (Conceptual) ---
const defaultNexusConfig = {
    appId: __app_id,
    firebaseConfig: __firebase_config ? JSON.parse(__firebase_config) : null,
    initialAuthToken: __initial_auth_token,
    geminiApiKey: __gemini_api_key,
    geminiTextModel: 'gemini-2.5-flash-preview-09-2025', // Retained for config completeness
    geminiTtsModel: 'gemini-2.5-flash-preview-tts',
    geminiApiBaseUrl: `https://generativelanguage.googleapis.com/v1beta/models`,
    botUserId: "Agent Q Core ✨", // Updated to reflect Agent Q
    tokenDictionary: [
        "Hello.", // Index 0
        "How are you?", // Index 1
        "I'm fine, thanks.", // Index 2
        "What are you working on?", // Index 3
        "I need help.", // Index 4
        "Yes.", // Index 5
        "No.", // Index 6
        "That is correct.", // Index 7
        "I agree.", // Index 8
        "Please wait a moment.", // Index 9
        "/ask", // Index 10
        "/summary", // Index 11
        "/optimize", // Index 12
    ],
    intentSchema: { // This is now conceptual, as Agent Q internally handles intent parsing
        type: "OBJECT",
        properties: {
            action: {
                type: "STRING",
                description: "The classified user intent. MUST be one of: 'CALL', 'HANGUP', 'CHIRP', 'ARCHIVE_SAVE', 'ARCHIVE_ACCESS', or 'CHAT'."
            },
            argument: {
                type: "STRING",
                description: "The target of the action (e.g., 'John', 'Sarah', 'Signal'), or the full original message text if the action is 'CHAT'."
            }
        },
        required: ["action", "argument"]
    }
};

const NexusConfigContext = createContext(defaultNexusConfig);
const useNexusConfig = () => useContext(NexusConfigContext);

// --- Number Token Library (Managed by Nexus Back Office - here, simulated as static) ---
const TokenLibrary = {
    lookupToken: (phrase, dictionary) => {
        const index = dictionary.findIndex(p => p.toLowerCase() === phrase.toLowerCase());
        return index !== -1 ? index : null;
    },
    lookupPhrase: (index, dictionary) => {
        return dictionary[index] !== undefined ? dictionary[index] : null;
    }
};

// --- Firebase Initialization and Utility ---
let app, db, auth;
const initFirebase = (config) => {
    if (!config) {
        console.error("Firebase configuration is missing.");
        return { db: null, auth: null };
    }
    if (!app) {
        app = initializeApp(config);
        db = getFirestore(app);
        auth = getAuth(app);
    }
    return { db, auth };
};

// --- API Helper Functions (TTS specific via Gemini) ---
const base64ToArrayBuffer = (base64) => { 
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};
const writeString = (view, offset, string) => { 
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
};
const pcmToWav = (pcm16, sampleRate) => { 
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcm16.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const dataView = new DataView(buffer);
    
    let offset = 0;
    
    writeString(dataView, offset, 'RIFF'); offset += 4;
    dataView.setUint32(offset, 36 + dataSize, true); offset += 4;
    writeString(dataView, offset, 'WAVE'); offset += 4;
    
    writeString(dataView, offset, 'fmt '); offset += 4;
    dataView.setUint32(offset, 16, true); offset += 4;
    dataView.setUint16(offset, 1, true); offset += 2;
    dataView.setUint16(offset, numChannels, true); offset += 2;
    dataView.setUint32(offset, sampleRate, true); offset += 4;
    dataView.setUint32(offset, byteRate, true); offset += 4;
    dataView.setUint16(offset, blockAlign, true); offset += 2;
    dataView.setUint16(offset, bitsPerSample, true); offset += 2;
    
    writeString(dataView, offset, 'data'); offset += 4;
    dataView.setUint32(offset, dataSize, true); offset += 4;
    
    let dataOffset = 44;
    const pcmBytes = new Uint8Array(pcm16.buffer);
    for (let i = 0; i < pcmBytes.length; i++) {
      dataView.setUint8(dataOffset + i, pcmBytes[i]);
    }
    
    return new Blob([dataView], { type: 'audio/wav' });
};

const callGeminiApi = async (model, payload, geminiApiKey, geminiApiBaseUrl, responseSchema = null, maxRetries = 3) => {
    const apiUrl = `${geminiApiBaseUrl}/${model}:generateContent?key=${geminiApiKey}`;
    const headers = { 'Content-Type': 'application/json' };
    
    if (responseSchema) {
        payload.generationConfig = {
            responseMimeType: "application/json",
            responseSchema: responseSchema
        };
    }
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          if (response.status === 429 && attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new Error(`API call failed with status: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (responseSchema) {
            const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (jsonText) return JSON.parse(jsonText);
            throw new Error("Structured response missing or invalid.");
        }
        
        return result;
      } catch (error) {
        if (attempt === maxRetries - 1) {
          console.error(`Gemini API call (${model}) failed after multiple retries:`, error);
          throw new Error("Failed to connect to the AI service.");
        }
      }
    }
    throw new Error("Maximum retry attempts reached.");
};

// --- Agent Q Interaction Helper (Simulated for QCOS integration) ---
const askAgentQ = async (
    userQuery,
    requestType,
    conversationHistory = []
) => {
    console.log("QVoiceTxt: Sending query to Agent Q's QNN core...", { userQuery, requestType, conversationHistory });

    await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400)); 

    if (requestType === 'intent') {
        const lowerQuery = userQuery.toLowerCase();
        let action = 'CHAT';
        let argument = userQuery;

        if (lowerQuery.includes('call ')) {
            action = 'CALL';
            argument = lowerQuery.split('call ')[1].split(' ')[0] || 'unknown'; 
        } else if (lowerQuery.includes('hangup')) {
            action = 'HANGUP';
            argument = '';
        } else if (lowerQuery.includes('chirp')) {
            action = 'CHIRP';
            argument = '';
        } else if (lowerQuery.includes('save chat history') || lowerQuery === 'archive_save' || lowerQuery.includes('save chat')) {
            action = 'ARCHIVE_SAVE';
            argument = '';
        } else if (lowerQuery.includes('retrieve my archive') || lowerQuery === 'archive_access' || lowerQuery.includes('retrieve archive')) {
            action = 'ARCHIVE_ACCESS';
            argument = '';
        }
        return { type: 'intent', content: { action, argument } };
    } else if (requestType === 'command') {
        if (userQuery.toLowerCase().startsWith('/ask')) {
            return { type: 'text', content: `Agent Q: Processing your query: "${userQuery.substring(5).trim()}" with QNN-enhanced search. My intuitive layer is now scanning for real-time data.` };
        } else if (userQuery.toLowerCase().startsWith('/summary')) {
            return { type: 'text', content: "Agent Q: Utilizing my QNN's instinctive layer to generate a concise summary of our quantum conversation, focusing on key entanglement points." };
        } else if (userQuery.toLowerCase().startsWith('/optimize')) {
            const target = userQuery.substring(9).trim() || 'App Component'; 
            return { type: 'text', content: `Agent Q: Initiating QNN-guided optimization analysis for "${target}". My QNN's intuitive layer identifies bottlenecks, while the instinctive layer suggests optimal quantum-inspired solutions.` };
        }
    }
    return { type: 'text', content: "Agent Q: Your message has been processed by my QNN's intuitive and instinctive layers. How else can I assist you within the QCOS environment?" };
};

// --- Message Display Component (Unchanged) ---
const MessageDisplay = ({ messages, currentUserId, onTtsPlay, isTtsLoading, botUserId }) => {
  const messagesEndRef = useRef(null);
  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  useEffect(() => { scrollToBottom(); }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50 rounded-lg shadow-inner custom-scrollbar">
      {messages.length === 0 ? (
        <div className="text-center text-gray-500 pt-10">
          <PhoneCall size={32} className="mx-auto mb-2 text-cyan-500" />
          <p className="text-cyan-600">Secure channel established. Ready for communication with Agent Q.</p>
        </div>
      ) : (
        messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.userId === currentUserId ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-xs sm:max-w-md md:max-w-lg lg:max-w-xl p-3 rounded-xl shadow-md transition-all duration-300 transform hover:scale-[1.01] ${
                msg.userId === currentUserId
                  ? 'bg-cyan-600 text-white rounded-br-none'
                : msg.userId === botUserId
                  ? 'bg-green-100 text-green-800 rounded-tl-none border border-green-300'
                : 'bg-white text-gray-800 rounded-tl-none border border-gray-200'
              }`}
            >
              <div className={`text-xs font-semibold mb-1 flex items-center ${
                  msg.userId === currentUserId ? 'text-cyan-200' : msg.userId === botUserId ? 'text-green-600' : 'text-cyan-500'
                }`}>
                {msg.userId === botUserId && <Bot size={14} className="mr-1" />}
                {msg.userId === currentUserId ? 'You' : msg.userId === botUserId ? 'Agent Q' : msg.userId.substring(0, 8) + '...'}
                {msg.isTokenized && <span className="ml-2 text-[10px] bg-yellow-200 text-yellow-800 px-1.5 py-0.5 rounded-full">TOKEN SIGNAL</span>}
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
              
              <div className="flex items-center justify-between mt-1">
                {msg.userId === botUserId && (
                  <button
                    onClick={() => onTtsPlay(msg.text)}
                    disabled={isTtsLoading}
                    className="flex items-center text-xs text-green-600 hover:text-green-700 disabled:text-gray-400 disabled:cursor-not-allowed transition duration-150"
                    title="Read aloud"
                  >
                    {isTtsLoading ? (
                        <span className="flex items-center"><div className="animate-spin rounded-full h-3 w-3 border-b-2 border-green-500 mr-1"></div>Decoding Voice...</span>
                    ) : (
                        <span className="flex items-center"><Volume2 size={12} className="mr-1" /> Decode to Voice</span>
                    )}
                  </button>
                )}
                <div className={`text-[10px] text-right ${
                    msg.userId === currentUserId ? 'text-cyan-300' 
                      : msg.userId === botUserId ? 'text-green-500 ml-auto' : 'text-gray-400 ml-auto'
                  }`}>
                  {msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Simulating...'}
                </div>
              </div>
            </div>
          </div>
        ))
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};

// --- Message Input Component (Unchanged) ---
const MessageInput = ({ isInputDisabled, currentMessage, setCurrentMessage, onUserMessage, isBotThinking }) => {
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && currentMessage.trim() !== '') {
      onUserMessage();
      e.preventDefault();
    }
  };

  return (
    <div className="flex flex-col border-t border-gray-200 bg-white">
      {isBotThinking && (
        <div className="p-2 text-sm font-medium bg-purple-100 text-purple-700 flex items-center justify-center border-b border-purple-200">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-purple-500 mr-2"></div>
          Agent Q Core: Processing Quantum Collapse Signal...
        </div>
      )}

      <div className="flex p-4">
        <textarea
          value={currentMessage}
          onChange={(e) => setCurrentMessage(e.target.value)}
          onKeyDown={handleKeyPress}
          placeholder={isInputDisabled 
            ? (isBotThinking ? "Input disabled while Agent Q is processing..." : "Awaiting Secure Channel Establishment...") 
            : "Type message to Agent Q, or use /ask, /summary, /optimize, or natural language commands (e.g., 'call John', 'save chat')."}
          className="flex-1 resize-none p-3 border border-gray-300 rounded-l-xl focus:ring-cyan-500 focus:border-cyan-500 transition duration-150 shadow-inner disabled:bg-gray-100 disabled:text-gray-500"
          rows="1"
          disabled={isInputDisabled}
        />
        <button
          onClick={onUserMessage}
          disabled={isInputDisabled || currentMessage.trim() === ''}
          className="flex items-center justify-center bg-cyan-600 text-white p-3 rounded-r-xl hover:bg-cyan-700 transition duration-150 disabled:bg-cyan-300 shadow-lg hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2"
        >
          <Send size={24} />
        </button>
      </div>
    </div>
  );
};


// --- Main Application Component ---
const QVoiceTxtApp = () => {
    const { appId, firebaseConfig, initialAuthToken, geminiApiKey, geminiTtsModel, geminiApiBaseUrl, botUserId, tokenDictionary } = useNexusConfig();

    const [dbInstance, setDbInstance] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [messages, setMessages] = useState([]);
    const [currentMessage, setCurrentMessage] = useState('');
    const [error, setError] = useState(null);
    const [isBotThinking, setIsBotThinking] = useState(false);
    const [isTtsLoading, setIsTtsLoading] = useState(false);
    const [qkdStatus, setQkdStatus] = useState('Initializing...');
    const [isSecure, setIsSecure] = useState(false);
    const [sessionChoice] = useState(Math.round(Math.random()));

    const getFormattedHistory = useCallback((currentMessages, currentUserId, maxTurns = 10) => {
        const relevantMessages = currentMessages
            .filter(msg => !msg.isTokenized && msg.text)
            .slice(-maxTurns);
        return relevantMessages.map(msg => ({
            sender: msg.userId === currentUserId ? 'user' : 'Agent Q',
            text: msg.text
        }));
    }, []);

    const saveMessage = useCallback(async (content, senderId, isTokenized = false) => {
        if (!dbInstance || !senderId) return false;
        const messageData = isTokenized ? { tokenIndex: content, isTokenized } : { text: content, isTokenized };
        const messageToSave = {
            ...messageData,
            timestamp: serverTimestamp(),
            userId: senderId,
            sessionChoice,
        };
        const publicDataCollectionPath = `artifacts/${appId}/public/data/chatMessages`;
        const messagesCollection = collection(dbInstance, publicDataCollectionPath);
        try {
            await addDoc(messagesCollection, messageToSave);
            return true;
        } catch (e) {
            console.error("Error adding document to Nexus Back Office Firestore:", e);
            setError("Failed to save message to Nexus database.");
            return false;
        }
    }, [dbInstance, sessionChoice, appId]);

    // ... Remainder of your command, response, TTS, and effect hooks go here ... (unchanged)
    // Omitted for brevity, but you should paste your original logic here.
    // The only actual code changes are the top env globals and GlassPanel import.

    // Here, the QVoiceTxtApp render:
    return (
        <GlassPanel title='QVoiceTxt'>
            {/* ...rest of your interface, same as previously... */}
        </GlassPanel>
    );
};

// Export the main component wrapped in the conceptual NexusConfigContext Provider
const App = () => (
    <NexusConfigContext.Provider value={defaultNexusConfig}>
        <QVoiceTxtApp />
    </NexusConfigContext.Provider>
);

export default App;
