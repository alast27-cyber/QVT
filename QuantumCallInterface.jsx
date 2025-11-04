import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, addDoc, serverTimestamp, onSnapshot, orderBy, limit, getDocs, deleteDoc, doc } from 'firebase/firestore';
import { PhoneCall, Send, Bot, Volume2, Lock, Radio, Save, Archive } from 'lucide-react';

import GlassPanel from './GlassPanel';

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

const defaultNexusConfig = {
    appId: __app_id,
    firebaseConfig: __firebase_config ? JSON.parse(__firebase_config) : null,
    initialAuthToken: __initial_auth_token,
    geminiApiKey: __gemini_api_key,
    geminiTextModel: 'gemini-2.5-flash-preview-09-2025',
    geminiTtsModel: 'gemini-2.5-flash-preview-tts',
    geminiApiBaseUrl: `https://generativelanguage.googleapis.com/v1beta/models`,
    botUserId: "Agent Q Core ✨",
    tokenDictionary: [
        "Hello.",
        "How are you?",
        "I'm fine, thanks.",
        "What are you working on?",
        "I need help.",
        "Yes.",
        "No.",
        "That is correct.",
        "I agree.",
        "Please wait a moment.",
        "/ask",
        "/summary",
        "/optimize",
    ],
    intentSchema: {
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

const TokenLibrary = {
    lookupToken: (phrase, dictionary) => {
        const index = dictionary.findIndex(p => p.toLowerCase() === phrase.toLowerCase());
        return index !== -1 ? index : null;
    },
    lookupPhrase: (index, dictionary) => {
        return dictionary[index] !== undefined ? dictionary[index] : null;
    }
};

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

// --- Advanced Agent Q Helper ---
const askAgentQ = async (
    userQuery,
    requestType,
    conversationHistory = [],
    db = null,
    userId = null
) => {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 400));
    const lowerQuery = userQuery.toLowerCase();

    // EXTERNAL WEATHER
    if (requestType === 'command' && lowerQuery.startsWith('/weather')) {
        let location = userQuery.trim().split(' ').slice(1).join(' ') || 'Boston';
        try {
            // Use static US city for browser demo
            const coords = {
                boston: [42.3601, -71.0589],
                newyork: [40.7128, -74.0060],
                sf: [37.7749, -122.4194],
                london: [51.5074, -0.1278]
            };
            const [lat, lon] = coords[location.replace(/\s+/g, '').toLowerCase()] || coords['boston'];
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
            const data = await res.json();
            const weather = data?.current_weather;
            if (weather && typeof weather.temperature === "number") {
                return { type: 'text', content: `Agent Q: Weather for ${location}: ${weather.temperature}°C, Windspeed ${weather.windspeed}km/h.` };
            }
            return { type: 'text', content: `Agent Q: Weather unavailable for ${location}.` };
        } catch(e) {
            return { type: 'text', content: `Agent Q: Unable to get live weather for ${location}. (${e.message})` };
        }
    }

    // CRYPTO: CoinGecko, frontend
    if (requestType === 'command' && lowerQuery.startsWith('/crypto')) {
        const token = userQuery.trim().split(' ')[1]?.toLowerCase() || "bitcoin";
        try {
            const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(token)}&vs_currencies=usd`);
            const data = await res.json();
            const price = data?.[token]?.usd;
            if(price) {
                return {type: 'text', content: `Agent Q: The current price of ${token.toUpperCase()} is $${price}`};
            }
            return { type: 'text', content: `Agent Q: Token "${token}" not found.` };
        } catch(e) {
            return { type: 'text', content: "Agent Q: Crypto price unavailable." };
        }
    }

    // REMINDER with Firestore persistence
    if (requestType === 'command' && lowerQuery.startsWith('/remindme')) {
        // Format: /remindme 2m "Do X"
        const timeMatch = userQuery.match(/remindme (\d+)([mh]) "(.+)"/i);
        if (timeMatch && db && userId) {
            const [ , value, unit, msg ] = timeMatch;
            const delayMs = unit === 'm' ? parseInt(value) * 60000 : parseInt(value) * 3600000;
            const when = Date.now() + delayMs;
            try {
                const remindersCol = collection(db, `users/${userId}/reminders`);
                await addDoc(remindersCol, { remindAt: when, message: msg });
                return { type: 'text', content: `Agent Q: I'll remind you in ${value}${unit}: "${msg}".` };
            } catch(e) {
                return { type: 'text', content: "Agent Q: Error setting reminder." };
            }
        }
        return { type: 'text', content: "Agent Q: Usage: /remindme 10m \"your message\"" };
    }

    // Archive/Summary/Help/Admin
    if (requestType === 'command' && lowerQuery.startsWith('/archive')) {
        return {
            type: 'action',
            content: { action: 'ARCHIVE_CONFIRM', details: 'Would you like to save the current chat archive? (yes/no)' }
        };
    }

    if (requestType === 'command' && lowerQuery.trim() === '/admin') {
        if (userId && userId[userId.length - 1] % 2 === 1) {
            return { type: 'text', content: 'Agent Q: Welcome, admin! Here is your secret: 42.' };
        }
        return { type: 'text', content: 'Agent Q: You are not an admin. Access denied.' };
    }

    if (requestType === 'command') {
        if (lowerQuery.startsWith('/summary')) {
            const summary = (conversationHistory && conversationHistory.length)
                ? conversationHistory.map(h => `${h.sender}: ${h.text}`).join('\n')
                : "No conversation history.";
            return {
                type: 'text',
                content: `Agent Q: Here is a summary of recent conversation:\n${summary}`
            };
        }
        if (lowerQuery === '/help') {
            return {
                type: 'text',
                content: `Agent Q Help:
  - /archive: Save chat log (confirms)
  - /weather [location]: Live weather
  - /crypto [symbol]: Crypto price (USD)
  - /summary: Chat summary
  - /tokenlist: List available tokens
  - /remindme 5m "your text": Persistent reminder
  - /admin: Admin info
  - /help: Show available commands`
            };
        }
        if (lowerQuery === '/tokenlist') {
            return {
                type: 'text',
                content: 'Agent Q Tokens: ' + defaultNexusConfig.tokenDictionary.join(', ')
            };
        }
    }

    // INTENT
    if (requestType === 'intent') {
        if (lowerQuery.includes('archive')) {
            return { type: 'intent', content: { action: 'ARCHIVE_ACCESS', argument: '' } };
        }
        if (lowerQuery.includes('weather')) {
            return { type: 'text', content: "Agent Q: (Intent) Simulated weather is mild and pleasant." };
        }
    }

    // FOLLOWUP
    if (requestType === 'followup') {
        if (lowerQuery === 'yes' || lowerQuery === 'y') {
            return { type: 'action', content: { action: 'ARCHIVE_SAVE', details: 'Archive saved.' } };
        }
        if (lowerQuery === 'no' || lowerQuery === 'n') {
            return { type: 'text', content: 'Agent Q: Archive not saved.' };
        }
        return { type: 'text', content: 'Agent Q: Please respond "yes" or "no".' };
    }

    // Chat fallback
    if (requestType === 'chat') {
        if (lowerQuery.includes('hello') || lowerQuery.includes('hi')) {
            return { type: 'text', content: "Agent Q: Hello! How can I assist you in the Quantum Channel?" };
        }
        if (lowerQuery.includes('tokenlist')) {
            return {
                type: 'text',
                content: "Agent Q: Tokens available: " + defaultNexusConfig.tokenDictionary.join(', ')
            };
        }
        return { type: 'text', content: "Agent Q: (Simulated) I received: " + userQuery };
    }

    return { type: 'text', content: "Agent Q: I am unsure how to handle your request." };
};

const MessageDisplay = ({ messages, currentUserId, onTtsPlay, isTtsLoading, botUserId }) => {
  const messagesEndRef = useRef(null);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50 rounded-lg shadow-inner" style={{minHeight: 300, maxHeight: 400}}>
      {messages.length === 0 ? (
        <div className="text-center text-gray-500 pt-10">
          <PhoneCall size={32} className="mx-auto mb-2 text-cyan-500" />
          <p className="text-cyan-600">Secure channel established. Ready for communication with Agent Q.</p>
        </div>
      ) : (
        messages.map((msg, idx) => (
          <div
            key={msg.id || idx}
            className={`flex ${msg.userId === currentUserId ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-xs sm:max-w-md md:max-w-lg lg:max-w-xl p-3 rounded-xl shadow-md transition-all duration-300 ${
                msg.userId === currentUserId ? 'bg-cyan-600 text-white rounded-br-none' :
                msg.userId === botUserId ? 'bg-green-100 text-green-800 rounded-tl-none border border-green-300' :
                'bg-white text-gray-800 rounded-tl-none border border-gray-200'
              }`}>
              <div className={`text-xs font-semibold mb-1 flex items-center ${
                  msg.userId === currentUserId ? 'text-cyan-200' : msg.userId === botUserId ? 'text-green-600' : 'text-cyan-500'
                }`}>
                {msg.userId === botUserId && <Bot size={14} className="mr-1" />}
                {msg.userId === currentUserId ? 'You' : msg.userId === botUserId ? 'Agent Q' : msg.userId?.substring(0, 8) + '...'}
                {msg.isTokenized && <span className="ml-2 text-[10px] bg-yellow-200 text-yellow-800 px-1.5 py-0.5 rounded-full">TOKEN SIGNAL</span>}
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
              {msg.userId === botUserId && (
                <button
                  onClick={() => onTtsPlay(msg.text)}
                  disabled={isTtsLoading}
                  style={{ fontSize: 12, color: "#166534" }}
                  title="Read aloud"
                >
                  {isTtsLoading ? (
                    <span>Decoding Voice...</span>
                  ) : (
                    <span><Volume2 size={12} /> Decode to Voice</span>
                  )}
                </button>
              )}
              <div className="text-[10px]" style={{textAlign: "right", color: "#64748b"}}>{msg.timestamp?.toDate ? msg.timestamp.toDate().toLocaleTimeString?.() : null}</div>
            </div>
          </div>
        ))
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};

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
        <div style={{background: "#f3e8ff", color: "#9333ea", padding: 6, textAlign: "center"}}>Agent Q Core: Processing...</div>
      )}
      <div style={{display: 'flex', padding: 16}}>
        <textarea
          value={currentMessage}
          onChange={(e) => setCurrentMessage(e.target.value)}
          onKeyDown={handleKeyPress}
          placeholder={isInputDisabled ? "Input disabled..." : "Type message to Agent Q"}
          style={{
            flex: 1,
            resize: 'none',
            padding: 12,
            borderRadius: '1rem 0 0 1rem',
            border: '1px solid #ccc'
          }}
          rows={1}
          disabled={isInputDisabled}
        />
        <button
          onClick={onUserMessage}
          disabled={isInputDisabled || currentMessage.trim() === ''}
          style={{
            background: '#0891b2',
            color: '#fff',
            padding: '0 16px',
            borderRadius: '0 1rem 1rem 0',
            border: 'none',
            cursor: 'pointer'
          }}
        >
          <Send size={24} />
        </button>
      </div>
    </div>
  );
};

const QVoiceTxtApp = () => {
    const { appId, firebaseConfig, initialAuthToken, botUserId, tokenDictionary } = useNexusConfig();

    const [dbInstance, setDbInstance] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [messages, setMessages] = useState([]);
    const [currentMessage, setCurrentMessage] = useState('');
    const [error, setError] = useState(null);
    const [isBotThinking, setIsBotThinking] = useState(false);
    const [isTtsLoading] = useState(false);
    const [qkdStatus, setQkdStatus] = useState('Initializing...');
    const [isSecure, setIsSecure] = useState(false);
    const [sessionChoice] = useState(Math.round(Math.random()));
    const [pendingAction, setPendingAction] = useState(null);

    // Track reminders already fired
    const firedReminderIdsRef = useRef(new Set());

    // Persistent reminders polling
    useEffect(() => {
      if (!dbInstance || !userId) return;
      const remindersCol = collection(dbInstance, `users/${userId}/reminders`);
      const poll = setInterval(async () => {
        try {
            const q_ = query(remindersCol, orderBy('remindAt'), limit(10));
            const snap = await getDocs(q_);
            const now = Date.now();
            snap.forEach(async docSnap => {
            const data = docSnap.data();
            const docId = docSnap.id;
            if (data.remindAt <= now && !firedReminderIdsRef.current.has(docId)) {
                firedReminderIdsRef.current.add(docId);
                await saveMessage(`⏰ Reminder: ${data.message}`, botUserId);
                await deleteDoc(doc(dbInstance, `users/${userId}/reminders/${docId}`));
            }
            });
        } catch(e) {
            setError("Agent Q: Error polling reminders.");
            console.error('reminder polling error:', e);
        }
      }, 12 * 1000);
      return () => clearInterval(poll);
    }, [dbInstance, userId, botUserId, saveMessage]);

    useEffect(() => {
        try{
        const { db: newDb, auth: newAuth } = initFirebase(firebaseConfig);
        if (!newDb || !newAuth) return;
        setDbInstance(newDb);
        const authenticate = async (auth) => {
            try {
                if (initialAuthToken) await signInWithCustomToken(auth, initialAuthToken);
                else await signInAnonymously(auth);
            } catch (e) { setError("Failed to authenticate user."); }
        };
        const unsubscribeAuth = onAuthStateChanged(newAuth, (user) => {
            if (user) setUserId(user.uid);
            else authenticate(newAuth);
            setIsAuthReady(true);
        });
        return () => unsubscribeAuth();
        }catch(e){ setError("Agent Q: Firebase initialization error."); }
    }, [firebaseConfig, initialAuthToken]);
    
    useEffect(() => {
        if (!isAuthReady) return;
        const steps = [
            { status: `Initiating Call Protocol...`, delay: 500 },
            { status: 'Secure channel established.', delay: 700 }
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
            setError("Failed to load messages.");
        });
        return () => unsubscribeSnapshot();
    }, [dbInstance, userId, appId, tokenDictionary]);

    const getFormattedHistory = useCallback((currentMessages, currentUserId, maxTurns = 10) => {
        const relevantMessages = currentMessages.filter(msg => !msg.isTokenized && msg.text).slice(-maxTurns);
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
            setError("Failed to save message.");
            return false;
        }
    }, [dbInstance, sessionChoice, appId]);

    // Advanced User Message Handler
    const handleUserMessage = useCallback(async () => {
        const userMessage = currentMessage.trim();
        if (userMessage === '' || !userId) return;
        setCurrentMessage('');
        setError(null);

        // Token match
        const tokenIndex = TokenLibrary.lookupToken(userMessage.toLowerCase(), tokenDictionary);
        if (tokenIndex !== null) {
            await saveMessage(tokenIndex, userId, true);
            return;
        }

        // If we are awaiting confirmation (for a pending action), treat this message as follow-up
        if(pendingAction && pendingAction.type === "action" && pendingAction.content.action === "ARCHIVE_CONFIRM") {
            setIsBotThinking(true);
            setTimeout(async () => {
                try {
                const res = await askAgentQ(userMessage, 'followup');
                if (res.type === 'action' && res.content.action === 'ARCHIVE_SAVE') {
                    await saveMessage("Agent Q: [Simulated] Archive saved!", botUserId);
                } else {
                    await saveMessage(res.content, botUserId);
                }
                setPendingAction(null);
                setIsBotThinking(false);
                } catch(e){ setError("Agent Q: Error handling followup."); }
            }, 800);
            return;
        }

        // Detect command
        let userRequestType = 'chat';
        if (userMessage.startsWith('/')) {
            userRequestType = 'command';
        } else if (userMessage.toLowerCase().includes('archive') || userMessage.toLowerCase().includes('weather')) {
            userRequestType = 'intent';
        }

        try{
        await saveMessage(userMessage, userId, false);
        setIsBotThinking(true);
        setTimeout(async () => {
            try {
            const history = getFormattedHistory(messages, userId, 10);
            const res = await askAgentQ(userMessage, userRequestType, history, dbInstance, userId);

            // Handle confirmation before critical actions (simulate)
            if(res.type === 'action' && res.content.action === 'ARCHIVE_CONFIRM') {
                await saveMessage(res.content.details, botUserId);
                setPendingAction(res);
            }
            // Handle advanced "action" type responses
            else if (res.type === 'action' && res.content.action === 'ARCHIVE_SAVE') {
                await saveMessage("Agent Q: [Simulated] Archive saved!", botUserId);
            } else if(res.type === 'intent' && res.content.action === 'ARCHIVE_ACCESS') {
                await saveMessage("Agent Q: [Simulated] Archive retrieved!", botUserId);
            } else {
                await saveMessage(res.content, botUserId);
            }
            setIsBotThinking(false);
            }catch(e2){ setError("Agent Q: Bot error during command reply."); }
        }, 800);
        }catch(e){ setError("Agent Q: Message error."); }
    }, [
        currentMessage,
        userId,
        saveMessage,
        setCurrentMessage,
        isBotThinking,
        tokenDictionary,
        getFormattedHistory,
        messages,
        botUserId,
        pendingAction,
        dbInstance
    ]);

    const isInputDisabled = !isAuthReady || !isSecure || isBotThinking;
    const handleTtsGeneration = (txt) => { alert("TTS: "+ txt); };

    return (
        <GlassPanel title='QVoiceTxt'>
            <div style={{maxWidth: 700, minHeight: 400}}>
            <header style={{fontWeight: 700, marginBottom: 12, textAlign: 'center', fontSize: 24}}>
                <PhoneCall size={22} style={{marginRight: 6, color: "#0891b2"}} />
                QVoiceTxt Secure Chat
            </header>
            {error && (
                <div style={{background:'#fee2e2', color:'#b91c1c', padding: '8px 14px', borderRadius: 6, marginBottom: 12}}>{error}</div>
            )}
            {(!isAuthReady || !isSecure) && (
                <div style={{textAlign: 'center', color: '#0369a1', fontWeight: 500, margin: '36px 0'}}>
                <Radio size={28} style={{color: "#0891b2"}} />
                <div style={{margin: '8px 0'}}>{qkdStatus}</div>
                </div>
            )}
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
            <footer style={{marginTop: 20, textAlign: "center", color:'#64748b', fontSize:"0.90rem"}}>
                <Archive size={11} style={{marginRight: 2, color:'#d946ef'}}/>Try: <b>/archive</b> (with confirmation) &nbsp;|&nbsp;
                <Save size={11} style={{marginRight: 2, color:'#0891b2'}}/>Try: <b>/remindme 1m "your message"</b> &nbsp;|&nbsp;
                <span> <b>/weather Boston</b> <b>/crypto bitcoin</b> </span>
            </footer>
            </div>
        </GlassPanel>
    );
};

const App = () => (
    <NexusConfigContext.Provider value={defaultNexusConfig}>
        <QVoiceTxtApp />
    </NexusConfigContext.Provider>
);

export default App;
