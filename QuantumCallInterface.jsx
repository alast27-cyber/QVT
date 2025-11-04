import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, addDoc, serverTimestamp, onSnapshot, orderBy, limit, getDocs } from 'firebase/firestore';
import { PhoneCall, Send, Bot, Volume2, Lock, Radio, Save, Archive, CpuChipIcon, ThermometerIcon } from 'lucide-react';

// Assuming GlassPanel and other dashboard components are available globally or imported
declare const GlassPanel: React.FC<{ title: string; children: React.ReactNode }>;

// Define the global variables provided by the environment - now consumed by useNexusConfig
const __app_id = typeof window !== 'undefined' && typeof (window as any).__app_id !== 'undefined' ? (window as any).__app_id : 'default-app-id';
const __firebase_config = typeof window !== 'undefined' && typeof (window as any).__firebase_config !== 'undefined' ? (window as any).__firebase_config : null;
const __initial_auth_token = typeof window !== 'undefined' && typeof (window as any).__initial_auth_token !== 'undefined' ? (window as any).__initial_auth_token : null;
const __gemini_api_key = typeof window !== 'undefined' && typeof (window as any).__gemini_api_key !== 'undefined' ? (window as any).__gemini_api_key : '';


// --- Nexus Back Office Configuration Context (Conceptual) ---
interface NexusConfig {
    appId: string;
    firebaseConfig: any | null;
    initialAuthToken: string | null;
    geminiApiKey: string; // Used specifically for TTS now
    geminiTextModel: string; // Not directly used for QVoiceTxt's AI, but kept for context
    geminiTtsModel: string;
    geminiApiBaseUrl: string; // Used specifically for TTS now
    botUserId: string;
    tokenDictionary: string[];
    intentSchema: any; // Conceptual schema, Agent Q handles parsing internally now
}

const defaultNexusConfig: NexusConfig = {
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

const NexusConfigContext = createContext<NexusConfig>(defaultNexusConfig);
const useNexusConfig = () => useContext(NexusConfigContext);

// --- Number Token Library (Managed by Nexus Back Office - here, simulated as static) ---
const TokenLibrary = {
    lookupToken: (phrase: string, dictionary: string[]): number | null => {
        const index = dictionary.findIndex(p => p.toLowerCase() === phrase.toLowerCase());
        return index !== -1 ? index : null;
    },
    lookupPhrase: (index: number, dictionary: string[]): string | null => {
        return dictionary[index] !== undefined ? dictionary[index] : null;
    }
};

// --- Firebase Initialization and Utility ---
let app, db, auth;
const initFirebase = (config: any) => {
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

// Unified API Caller, now primarily for TTS
const callGeminiApi = async (model: string, payload: any, geminiApiKey: string, geminiApiBaseUrl: string, responseSchema: any = null, maxRetries = 3) => {
    // IMPORTANT: For production, geminiApiKey should be handled by a secure backend proxy
    // (e.g., /api/nexus/ai/gemini_proxy) to prevent exposure. The Quantum-to-Web Gateway
    // could host such a proxy.
    const apiUrl = `${geminiApiBaseUrl}/${model}:generateContent?key=${geminiApiKey}`;
    const headers = { 'Content-Type': 'application/json' };
    
    if (responseSchema) {
        // This path is no longer taken for text/intent, as Agent Q handles it
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
            // This parsing is now primarily for TTS modalities if they involve structured JSON
            const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (jsonText) return JSON.parse(jsonText);
            throw new Error("Structured response missing or invalid.");
        }
        
        return result; // Return raw result for standard text generation (if any, e.g., TTS info)
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
// This function encapsulates the interaction with Agent Q's QNN core.
// In a production QCOS environment, this would be a secure IPC or an API call
// to Agent Q's core, which then leverages its QNN with 2 layers (Intuitive, Instinctive)
// to process the request. The conversationHistory provides context for Agent Q's QNN.
interface AgentQResponse {
    type: 'text' | 'intent';
    content: string | { action: string; argument: string };
}

const askAgentQ = async (
    userQuery: string,
    requestType: 'chat' | 'intent' | 'command',
    conversationHistory: any[] = []
): Promise<AgentQResponse> => {
    console.log("QVoiceTxt: Sending query to Agent Q's QNN core...", { userQuery, requestType, conversationHistory });

    // Simulate Agent Q's QNN processing time
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
    // Default chat response, processed by Agent Q's QNN
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
      {/* AI Core Status Indicator */}
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
const QVoiceTxtApp = () => { // Renamed component
    const { appId, firebaseConfig, initialAuthToken, geminiApiKey, geminiTtsModel, geminiApiBaseUrl, botUserId, tokenDictionary } = useNexusConfig();

    const [dbInstance, setDbInstance] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [messages, setMessages] = useState([]);
    const [currentMessage, setCurrentMessage] = useState('');
    const [error, setError] = useState(null);
    const [isBotThinking, setIsBotThinking] = useState(false);
    const [isTtsLoading, setIsTtsLoading] = useState(false);
    
    // QKD Protocol Simulation States
    const [qkdStatus, setQkdStatus] = useState('Initializing...');
    const [isSecure, setIsSecure] = useState(false);
    const [sessionChoice] = useState(Math.round(Math.random())); // 0 or 1 supersession

    // --- Utility to get conversation history formatted for Agent Q's context ---
    const getFormattedHistory = useCallback((currentMessages, currentUserId, maxTurns = 10) => {
        const relevantMessages = currentMessages
            .filter(msg => !msg.isTokenized && msg.text)
            .slice(-maxTurns);

        // Agent Q's QNN can process a structured history for context
        return relevantMessages.map(msg => ({
            sender: msg.userId === currentUserId ? 'user' : 'Agent Q',
            text: msg.text
        }));
    }, []);

    // --- Message Saving (Saves INDEX or RAW TEXT) ---
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

    // --- General Conversation Handler (Now delegates to Agent Q) ---
    const handleGeneralConversation = useCallback(async (userText) => {
        setIsBotThinking(true);
        const botPlaceholderId = Date.now().toString();
        setMessages(prev => [...prev, { id: botPlaceholderId, userId: botUserId, text: "Agent Q: Accessing QNN layers...", timestamp: new Date() }]);

        try {
            const history = getFormattedHistory(messages, userId, 10);
            const agentQResult = await askAgentQ(userText, 'chat', history); // Call Agent Q
            
            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));
            if (agentQResult.type === 'text') {
                await saveMessage(agentQResult.content, botUserId); 
            } else {
                console.error("Unexpected response type from Agent Q for chat:", agentQResult);
                await saveMessage("Agent Q: An unexpected error occurred in QNN processing.", botUserId);
            }
        } catch (e) {
            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));
            await saveMessage("Agent Q: Connection instability detected during QNN processing. Please repeat your last message.", botUserId);
        } finally { 
            setIsBotThinking(false); 
        }
    }, [saveMessage, messages, userId, getFormattedHistory, botUserId]);
    
    // --- ARCHIVE & ACCESS HANDLERS ---
    const handleArchiveSave = useCallback(async () => {
        const archiveCollectionPath = `artifacts/${appId}/users/${userId}/archives`;
        const archiveCollection = collection(dbInstance, archiveCollectionPath);
        
        try {
            const archiveContent = messages.map(msg => ({
                text: msg.text,
                userId: msg.userId,
                timestamp: msg.timestamp?.toDate ? msg.timestamp.toDate().toISOString() : 'N/A',
            }));

            const docRef = await addDoc(archiveCollection, {
                archiveDate: serverTimestamp(),
                archivedBy: userId,
                archiveSize: archiveContent.length,
                content: JSON.stringify(archiveContent),
            });

            const archiveId = docRef.id.substring(0, 8);
            // Leveraging the new Quantum-to-Web Gateway for public-facing URLs
            const archiveUrl = `https://qcos.apps.web/${appId}/archive/${archiveId}`; 
            
            const botResponse = `Agent Q: **ARCHIVE SAVED.** The full chat history (${archiveContent.length} entries) has been securely packaged and uploaded to your private Nexus Back Office storage. \n\n*Direct Link (via Quantum-to-Web Gateway):* ${archiveUrl}\n*File ID:* ${archiveId}. You can retrieve it later by asking me to access the archive.`;
            
            await saveMessage(botResponse, botUserId);
        } catch (e) {
            console.error("Archive Save Failed in Nexus Back Office:", e);
            await saveMessage("Agent Q: ARCHIVE FAILED: Could not complete the secure upload to your private user space. Check authentication or Nexus permissions.", botUserId);
        }
    }, [dbInstance, userId, messages, saveMessage, appId, botUserId]);

    const handleArchiveAccess = useCallback(async () => {
        const archiveCollectionPath = `artifacts/${appId}/users/${userId}/archives`;
        const archiveCollection = collection(dbInstance, archiveCollectionPath);

        try {
            const q = query(archiveCollection, orderBy('archiveDate', 'desc'), limit(1));
            const snapshot = await getDocs(q);

            if (snapshot.empty) {
                await saveMessage("Agent Q: ARCHIVE ACCESS FAILED: No saved chat history found in your private Nexus Back Office user space.", botUserId);
                return;
            }

            const doc = snapshot.docs[0];
            const data = doc.data();
            const archiveId = doc.id.substring(0, 8);
            const archiveDate = data.archiveDate?.toDate().toLocaleString();
            
            const archivedMessages = JSON.parse(data.content);
            const messagePreview = archivedMessages.slice(-3).map(m => `> ${m.userId.substring(0, 4)}: ${m.text}`).join('\n');
            
            const botResponse = `Agent Q: **ARCHIVE RETRIEVED.** Latest file opened from Nexus Back Office:\n*File ID:* ${archiveId}\n*Date:* ${archiveDate}\n*Total Entries:* ${archivedMessages.length}\n\n**Last 3 Messages Preview:**\n${messagePreview}`;
            
            await saveMessage(botResponse, botUserId);

        } catch (e) {
            console.error("Archive Access Failed from Nexus Back Office:", e);
            await saveMessage("Agent Q: ARCHIVE ACCESS FAILED: Error retrieving data. The file might be corrupted or Nexus permissions are insufficient.", botUserId);
        }
    }, [dbInstance, userId, saveMessage, appId, botUserId]);


    // --- Intent Decryption and Execution Layer (Now delegates to Agent Q) ---
    const handleIntentDecryption = useCallback(async (userMessage) => {
        setIsBotThinking(true);
        const botPlaceholderId = Date.now().toString();
        setMessages(prev => [...prev, { id: botPlaceholderId, userId: botUserId, text: "Agent Q: Decrypting user intent with QNN's intuitive layer...", timestamp: new Date() }]);

        try {
            const agentQResult = await askAgentQ(userMessage, 'intent'); // Call Agent Q for intent
            if (agentQResult.type !== 'intent') {
                throw new Error("Agent Q did not return an intent object.");
            }
            const { action, argument } = agentQResult.content as { action: string; argument: string };
            let botResponse = "";

            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));

            switch (action) {
                case 'CALL':
                    botResponse = `Agent Q: Command accepted. Initiating secure channel establishment for **${argument}**...`;
                    await saveMessage(botResponse, botUserId);
                    break;
                case 'HANGUP':
                    botResponse = `Agent Q: Command accepted. **Terminating session** and purging quantum keys. Goodbye.`;
                    await saveMessage(botResponse, botUserId);
                    break;
                case 'CHIRP':
                    botResponse = `Agent Q: Command accepted. Running signal integrity test (CHIRP). Test successful, bandwidth stable.`;
                    await saveMessage(botResponse, botUserId);
                    break;
                case 'ARCHIVE_SAVE':
                    await handleArchiveSave();
                    break;
                case 'ARCHIVE_ACCESS':
                    await handleArchiveAccess();
                    break;
                case 'CHAT':
                default:
                    await handleGeneralConversation(userMessage);
                    return; 
            }
        } catch (e) {
            console.error("Agent Q Intent decryption failed:", e);
            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));
            await saveMessage("Agent Q: Intent recognition error: Command structure could not be verified by QNN. Falling back to chat.", botUserId);
            await handleGeneralConversation(userMessage);
        } finally {
            setIsBotThinking(false);
        }
    }, [saveMessage, handleGeneralConversation, handleArchiveSave, handleArchiveAccess, botUserId]);

    // --- Command Handlers (Now delegates to Agent Q) ---
    const handleAskResponse = useCallback(async (question) => {
        setIsBotThinking(true);
        const botPlaceholderId = Date.now().toString();
        setMessages(prev => [...prev, { id: botPlaceholderId, userId: botUserId, text: "Agent Q: Processing QNN-enhanced query...", timestamp: new Date() }]);
        
        try {
            const history = getFormattedHistory(messages, userId, 10);
            const agentQResult = await askAgentQ(`/ask ${question}`, 'command', history); // Call Agent Q
            
            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));
            if (agentQResult.type === 'text') {
                await saveMessage(agentQResult.content, botUserId); 
            } else {
                console.error("Unexpected response type from Agent Q for /ask:", agentQResult);
                await saveMessage("Agent Q: An unexpected error occurred during /ask processing.", botUserId);
            }
        } catch (e) {
            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));
            await saveMessage("Agent Q: Error: My QNN failed to decode complex query. Try again.", botUserId);
        } finally { setIsBotThinking(false); }
    }, [saveMessage, messages, userId, getFormattedHistory, botUserId]);

    const handleCommandResponse = useCallback(async (command, query) => {
        setIsBotThinking(true);
        const botPlaceholderId = Date.now().toString();
        setMessages(prev => [...prev, { id: botPlaceholderId, userId: botUserId, text: `Agent Q: Executing ${command} protocol with QNN-enhanced memory...`, timestamp: new Date() }]);
        
        try {
            const history = getFormattedHistory(messages, userId, 10);
            const agentQResult = await askAgentQ(query, 'command', history); // Call Agent Q
            
            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));
            if (agentQResult.type === 'text') {
                await saveMessage(agentQResult.content, botUserId);
            } else {
                console.error("Unexpected response type from Agent Q for command:", agentQResult);
                await saveMessage(`Agent Q: An unexpected error occurred during ${command} processing.`, botUserId);
            }
        } catch (e) {
            setMessages(prev => prev.filter(msg => msg.id !== botPlaceholderId));
            await saveMessage(`Agent Q: Error: Could not execute ${command} protocol. Try simplifying the request.`, botUserId);
        } finally { setIsBotThinking(false); }
    }, [saveMessage, messages, userId, getFormattedHistory, botUserId]);

    // TTS Handler Function (still uses Gemini API directly)
    const handleTtsGeneration = useCallback(async (textToSpeak) => { 
        setIsTtsLoading(true);
        const payload = {
            contents: [{ parts: [{ text: textToSpeak }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } 
                }
            },
        };
        try {
            const result = await callGeminiApi(geminiTtsModel, payload, geminiApiKey, geminiApiBaseUrl);
            const part = result?.candidates?.[0]?.content?.parts?.[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/L16")) {
                const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 16000;
                const pcmData = base64ToArrayBuffer(audioData);
                const pcm16 = new Int16Array(pcmData);
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const audioUrl = URL.createObjectURL(wavBlob);
                const audio = new Audio(audioUrl);
                audio.play();
                audio.onended = () => URL.revokeObjectURL(audioUrl);
            } else { setError("Agent Q: Voice Decoding failed: Invalid audio format from TTS service."); }
        } catch (e) { setError("Agent Q: Voice Decoding failed: TTS service error."); } finally { setIsTtsLoading(false); }
    }, [geminiApiKey, geminiApiBaseUrl, geminiTtsModel]);

    // --- Message Input Handler (Core Protocol Logic) ---
    const handleUserMessage = useCallback(async () => {
        const userMessage = currentMessage.trim();
        if (userMessage === '' || !userId) return;

        setCurrentMessage('');
        setError(null);
        
        const lowerMessage = userMessage.toLowerCase();
        
        // 1. Check for simple token match using the TokenLibrary
        const tokenIndex = TokenLibrary.lookupToken(lowerMessage, tokenDictionary);

        if (tokenIndex !== null) {
            await saveMessage(tokenIndex, userId, true); 
        } else if (lowerMessage.startsWith('/ask') || lowerMessage.startsWith('/summary') || lowerMessage.startsWith('/optimize')) {
            await saveMessage(userMessage, userId, false); 

            if (!isBotThinking) {
                if (lowerMessage.startsWith('/ask')) {
                    const question = userMessage.substring(5).trim();
                    if (question) await handleAskResponse(question);
                    else await saveMessage("Agent Q: Please ask me a question after '/ask'.", userId);
                } else if (lowerMessage === '/summary') {
                    await handleCommandResponse('Summary', lowerMessage);
                } else if (lowerMessage.startsWith('/optimize')) {
                    await handleCommandResponse('Optimization', lowerMessage);
                }
            }
        } else {
            await saveMessage(userMessage, userId, false);

            if (!isBotThinking) {
                await handleIntentDecryption(userMessage);
            }
        }
    }, [currentMessage, userId, saveMessage, setCurrentMessage, isBotThinking, handleAskResponse, handleCommandResponse, handleIntentDecryption, tokenDictionary]);

    // 1. Firebase Initialization and Authentication
    useEffect(() => {
        const { db: newDb, auth: newAuth } = initFirebase(firebaseConfig);
        if (!newDb || !newAuth) return;
        setDbInstance(newDb);
        const authenticate = async (auth) => {
            try {
                if (initialAuthToken) await signInWithCustomToken(auth, initialAuthToken);
                else await signInAnonymously(auth);
            } catch (e) { setError("Failed to authenticate user with Nexus Back Office."); }
        };
        const unsubscribeAuth = onAuthStateChanged(newAuth, (user) => {
            if (user) setUserId(user.uid);
            else authenticate(newAuth);
            setIsAuthReady(true);
        });
        return () => unsubscribeAuth();
    }, [firebaseConfig, initialAuthToken]);
    
    // 2. Quantum Call Protocol Simulation (unchanged)
    useEffect(() => {
        if (!isAuthReady) return;
        const steps = [
            { status: `Agent Q: Initiating Call Protocol - Sending Supersession (${sessionChoice})...`, delay: 1000 },
            { status: 'Agent Q: Entanglement Sync Command Received...', delay: 1500 },
            { status: 'Agent Q: Qubit Simulation & Token System Sync Complete from Nexus Back Office...', delay: 1000 },
            { status: 'Agent Q: Secure Channel Established. Connection Active.', delay: 500 }
        ];
        let currentDelay = 0;
        steps.forEach((step, index) => {
            currentDelay += step.delay;
            setTimeout(() => {
                setQkdStatus(step.status);
                if (index === steps.length - 1) setIsSecure(true);
            }, currentDelay);
        });
    }, [isAuthReady, sessionChoice]);

    // 3. Real-time Firestore Data Fetching and DECODING
    useEffect(() => {
        if (!dbInstance || !userId) return;
        setError(null);
        const publicDataCollectionPath = `artifacts/${appId}/public/data/chatMessages`;
        const q = query(collection(dbInstance, publicDataCollectionPath), orderBy('timestamp'));

        const unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
            const newMessages = snapshot.docs.map(doc => {
                const data = doc.data();
                let text = data.text || '';
                let isTokenized = data.isTokenized || false;

                if (isTokenized && typeof data.tokenIndex === 'number') {
                    text = TokenLibrary.lookupPhrase(data.tokenIndex, tokenDictionary) || `[TOKEN_ERROR: Unknown Index ${data.tokenIndex}]`;
                }

                return {
                    id: doc.id,
                    ...data,
                    text, 
                    isTokenized,
                };
            });
            setMessages(newMessages);
        }, (error) => {
            console.error("Error fetching messages from Nexus Back Office Firestore:", error);
            setError("Failed to load call history. Check Nexus permissions.");
        });

        return () => unsubscribeSnapshot();
    }, [dbInstance, userId, appId, tokenDictionary]);

    const isInputDisabled = !isAuthReady || !isSecure || isBotThinking || isTtsLoading;

    return (
        <GlassPanel title='QVoiceTxt'> {/* Renamed title */}
            <div className="min-h-full bg-gray-100 p-4 sm:p-6 flex flex-col items-center">
                <style>
                    {`
                    .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
                    .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 10px; }
                    .custom-scrollbar::-webkit-scrollbar-track { background-color: #f1f5f9; }
                    @keyframes pulse-green { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                    .pulse-green { animation: pulse-green 1s infinite; }
                    `}
                </style>
                
                <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl flex flex-col h-[90vh] lg:h-[80vh]">
                    {/* Header */}
                    <header className="p-4 bg-cyan-700 text-white rounded-t-2xl shadow-lg flex justify-between items-center">
                        <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center">
                            <PhoneCall size={24} className="mr-2 text-cyan-300" />
                            <span className="hidden sm:inline">QVoiceTxt Interface</span> {/* Updated name */}
                            <span className="inline sm:hidden">QVT</span> {/* Updated abbreviation */}
                        </h1>
                        <div className="flex items-center space-x-3">
                            <div className="text-xs sm:text-sm font-medium bg-cyan-800 py-1 px-3 rounded-full hidden md:block" title={`Full User ID: ${userId}`}>
                                User ID: {userId ? userId.substring(0, 8) + '...' : 'Connecting'}
                            </div>
                            {/* Security Status Panel */}
                            <div className={`text-xs sm:text-sm font-medium py-1 px-2 sm:px-3 rounded-full flex items-center transition-colors duration-500 ${
                                isSecure 
                                    ? 'bg-green-500 text-white shadow-md pulse-green' 
                                    : 'bg-yellow-400 text-gray-900 animate-pulse'
                            }`}>
                                <Lock size={14} className="mr-1" />
                                {isSecure ? 'SECURE' : 'Establishing...'}
                            </div>
                        </div>
                    </header>

                    {/* Error Display */}
                    {error && (
                        <div className="p-3 bg-red-100 text-red-700 border-l-4 border-red-500 text-sm font-medium">
                            **Error:** {error}
                        </div>
                    )}

                    {/* Connection Status Panel */}
                    {(!isAuthReady || !isSecure) && (
                        <div className="flex-1 flex justify-center items-center flex-col p-8 bg-gray-100">
                            <div className="animate-pulse flex items-center space-x-3">
                                <Radio size={32} className="text-cyan-500" />
                                <div className="h-4 w-4 bg-cyan-500 rounded-full"></div>
                            </div>
                            <p className="mt-4 text-gray-600 font-semibold text-center">{qkdStatus}</p>
                            <p className="text-sm text-gray-500 mt-1">Simulating QKD Token System. Supersession Dialed: **{sessionChoice}**</p>
                        </div>
                    )}

                    {/* Chat Area */}
                    {isAuthReady && isSecure && (
                        <>
                            <MessageDisplay 
                                messages={messages} 
                                currentUserId={userId} 
                                onTtsPlay={handleTtsGeneration}
                                isTtsLoading={isTtsLoading}
                                botUserId={botUserId}
                            />
                            <MessageInput 
                                isInputDisabled={isInputDisabled}
                                currentMessage={currentMessage} 
                                setCurrentMessage={setCurrentMessage}
                                onUserMessage={handleUserMessage}
                                isBotThinking={isBotThinking}
                            />
                        </>
                    )}
                </div>
                {/* Footer / Status */}
                <footer className="mt-4 text-xs text-gray-500 flex justify-center space-x-4">
                    <span className="flex items-center text-cyan-500"><Save size={12} className="mr-1 text-green-600"/> Try: "Save chat history"</span>
                    <span className="flex items-center text-cyan-500"><Archive size={12} className="mr-1 text-purple-600"/> Try: "Retrieve my archive"</span>
                </footer>
            </div>
        </GlassPanel>
    );
};

// Export the main component wrapped in the conceptual NexusConfigContext Provider
const App = () => (
    <NexusConfigContext.Provider value={defaultNexusConfig}>
        <QVoiceTxtApp /> {/* Renamed export */}
    </NexusConfigContext.Provider>
);

export default App;