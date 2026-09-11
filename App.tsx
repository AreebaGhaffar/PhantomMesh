import CryptoJS from 'crypto-js';
import React, {useState, useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  TouchableOpacity,
  FlatList,
  TextInput,
  PermissionsAndroid,
  Alert,
  Platform,
} from 'react-native';

import {
  initialize,
  startDiscoveringPeers,
  getAvailablePeers,
  connectWithConfig,
  getConnectionInfo,
  removeGroup,
} from 'rn-wifi-p2p';

import TcpSocket from 'react-native-tcp-socket';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Packet {
  messageId: string;
  senderId: string;
  recipientId: string;
  text: string;
  ttl: number;
  visitedNodes: string[];
  timestamp: number;
}

interface Device {
  id: string;
  name: string;
  displayName?: string;
  address: string;
  hops: number;
  signal: string;
}

interface Message {
  id: string;
  text: string;
  mine: boolean;
  time: string;
  status: 'pending' | 'sent';   // NEW
}

// ─── Permissions ──────────────────────────────────────────────────────────────

async function requestPermissions() {
  try {
    const permissions: any[] = [
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ];
    if (parseInt(Platform.Version as string, 10) >= 33) {
      permissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);
    }
    const granted = await PermissionsAndroid.requestMultiple(permissions);
    console.log('Permissions:', JSON.stringify(granted));
    return Object.values(granted).every(
      v => v === PermissionsAndroid.RESULTS.GRANTED,
    );
  } catch (e) {
    console.log('Permission error:', e);
    return false;
  }
}

//  ChatListScreen
function ChatsListScreen({onChat}: {onChat: (name: string) => void}) {
  const [contacts, setContacts] = useState<{name: string; lastConnected: number; displayName?: string}[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(CONTACTS_KEY).then(async raw => {
      if (raw) {
        const list = JSON.parse(raw);
        const withNames = await Promise.all(
          list.map(async (c: any) => ({...c, displayName: await getDisplayName(c.name)})),
        );
        setContacts(withNames);
      }
    });
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>💬 Chats</Text>
      {contacts.length === 0 && (
        <Text style={styles.noDevices}>
          No chats yet.{'\n'}Go to Scan, connect with someone once, and they'll show up here.
        </Text>
      )}
      <FlatList
        data={contacts}
        keyExtractor={item => item.name}
        style={{width: '100%', marginTop: 10}}
        renderItem={({item}) => (
          <TouchableOpacity style={styles.deviceCard} onPress={() => onChat(item.name)}>
            <View style={{flex: 1}}>
              <Text style={styles.deviceName}>{item.displayName}</Text>
              <Text style={styles.deviceInfo}>Tap to open chat</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

// Contact Store
const CONTACTS_KEY = 'contactsList';

async function saveContact(name: string) {
  try {
    const raw = await AsyncStorage.getItem(CONTACTS_KEY);
    const list: {name: string; lastConnected: number}[] = raw ? JSON.parse(raw) : [];
    const filtered = list.filter(c => c.name !== name);
    filtered.unshift({name, lastConnected: Date.now()});
    await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.log('saveContact error:', e);
  }
}

// encryption helpers
function encryptText(text: string, keyHex: string): string {
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(text, key, {iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7});
  return iv.toString(CryptoJS.enc.Hex) + ':' + encrypted.toString();
}

function decryptText(payload: string, keyHex: string): string {
  const [ivHex, cipherText] = payload.split(':');
  const key = CryptoJS.enc.Hex.parse(keyHex);
  const iv = CryptoJS.enc.Hex.parse(ivHex);
  const decrypted = CryptoJS.AES.decrypt(cipherText, key, {iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7});
  return decrypted.toString(CryptoJS.enc.Utf8);
}

async function getKey(contact: string): Promise<string | null> {
  return AsyncStorage.getItem(`aesKey_${contact}`);
}

async function saveKey(contact: string, key: string) {
  await AsyncStorage.setItem(`aesKey_${contact}`, key);
}

// username-lookup store
const USERNAMES_KEY = 'usernameMap';

async function saveUsername(deviceName: string, realUsername: string) {
  try {
    const raw = await AsyncStorage.getItem(USERNAMES_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    map[deviceName] = realUsername;
    await AsyncStorage.setItem(USERNAMES_KEY, JSON.stringify(map));
  } catch (e) {
    console.log('saveUsername error:', e);
  }
}

async function getDisplayName(deviceName: string): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(USERNAMES_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    return map[deviceName] || deviceName;
  } catch (e) {
    return deviceName;
  }
}

async function findDeviceNameForUsername(theirUsername: string): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(USERNAMES_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    for (const [deviceName, uname] of Object.entries(map)) {
      if (uname === theirUsername) return deviceName;
    }
  } catch (e) {}
  return theirUsername;
}

function getTimeNow(): string {
  const now = new Date();
  return now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────

function SetupScreen({onDone}: {onDone: (name: string) => void}) {
  const [name, setName] = useState('');

  const save = async () => {
    if (!name.trim()) return;
    await AsyncStorage.setItem('username', name.trim());
    onDone(name.trim());
  };

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>👻</Text>
      <Text style={styles.title}>PhantomMesh</Text>
      <Text style={styles.tagline}>Enter your name to get started</Text>
      <TextInput
        style={[styles.input, {width: '100%', marginTop: 40, borderColor: '#00D4FF', borderWidth: 1}]}
        value={name}
        onChangeText={setName}
        placeholder="Your name..."
        placeholderTextColor="#888"
        maxLength={20}
      />
      <TouchableOpacity
        style={[styles.button, {marginTop: 20, opacity: name.trim() ? 1 : 0.4}]}
        onPress={save}>
        <Text style={styles.buttonText}>Join Mesh Network</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────

function HomeScreen({onStart, onMap, onChats}: {onStart: () => void; onMap: () => void; onChats: () => void}) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>👻</Text>
      <Text style={styles.title}>PhantomMesh</Text>
      <Text style={styles.tagline}>
        When the world goes dark,{'\n'}we stay connected
      </Text>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>📡 No Internet Needed</Text>
      </View>
      <TouchableOpacity style={styles.button} onPress={onChats}>
        <Text style={styles.buttonText}>💬 Chats</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.button, {backgroundColor: '#1A1A2E', marginTop: 12, borderWidth: 1, borderColor: '#00D4FF'}]}
        onPress={onStart}>
        <Text style={[styles.buttonText, {color: '#00D4FF'}]}>📡 Scan for Nearby</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.button, {backgroundColor: '#1A1A2E', marginTop: 12, borderWidth: 1, borderColor: '#00D4FF'}]}
        onPress={onMap}>
        <Text style={[styles.buttonText, {color: '#00D4FF'}]}>View Network Map</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Contacts Screen ──────────────────────────────────────────────────────────

function ContactsScreen({
  onChat,
  username,
}: {
  onChat: (name: string) => void;
  username: string;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [scanning, setScanning] = useState(true);
  const pollRef = useRef<any>(null);

  useEffect(() => {
    setScanning(true);
    pollRef.current = setInterval(async () => {
      try {
        const result = await getAvailablePeers();
        if (result.devices) {
          const mapped = await Promise.all(result.devices.map(async (d: any) => ({
            id: d.deviceAddress,
            name: d.deviceName || `Device ${d.deviceAddress.slice(-6)}`,
            displayName: await getDisplayName(d.deviceName || d.deviceAddress),
            address: d.deviceAddress,
            hops: 1,
            signal: 'Direct',
          })));
          setDevices(mapped);
          setScanning(false);
        }
      } catch (e) {
        console.log('Poll error:', e);
      }
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, []);

  const openExistingChat = async (device: Device) => {
    await saveContact(device.name);
    onChat(device.name);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>📡 Nearby Devices</Text>
      <Text style={styles.subtitle}>
        {scanning ? 'Scanning... (keeps looking)' : `${devices.length} devices found`}
      </Text>

      {devices.length === 0 && (
        <Text style={styles.noDevices}>
          No devices found yet.{'\n'}Make sure other phones have PhantomMesh open!
        </Text>
      )}

      <FlatList
        data={devices}
        keyExtractor={item => item.id}
        style={{width: '100%', marginTop: 10}}
        renderItem={({item}) => (
          <TouchableOpacity style={styles.deviceCard} onPress={() => openExistingChat(item)}>
            <View style={{flex: 1}}>
              <Text style={styles.deviceName}>{item.displayName}</Text>
              <Text style={styles.deviceInfo}>{item.hops} hop • {item.signal}</Text>
            </View>
            <Text style={styles.chatIconText}>💬</Text>
          </TouchableOpacity>
        )}
      />

      <TouchableOpacity
        style={styles.sosButton}
        onPress={() => Alert.alert('SOS Sent!', 'Emergency broadcast sent to all nearby devices!')}>
        <Text style={styles.sosText}>🆘 SOS Broadcast</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Chat Screen ──────────────────────────────────────────────────────────────

function ChatScreen({
  contact,
  myUsername,
  status,
  incomingSignal,
  onSend,
}: {
  contact: string;
  myUsername: string;
  status: string;
  incomingSignal: {contact: string; nonce: number} | null;
  onSend: (contact: string, text: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const flatListRef = useRef<any>(null);
  const storageKey = `chat_${contact}`;
  const [displayName, setDisplayName] = useState(contact);

  useEffect(() => {
    getDisplayName(contact).then(setDisplayName);
  }, [contact]);

  const loadMessages = () => {
    AsyncStorage.getItem(storageKey).then(saved => {
      if (saved) {
        try {
          setMessages(JSON.parse(saved));
        } catch (e) {}
      }
      setTimeout(() => flatListRef.current?.scrollToEnd(), 100);
    });
  };

  useEffect(() => {
    loadMessages();
  }, [contact]);

  useEffect(() => {
    if (incomingSignal && incomingSignal.contact === contact) {
      loadMessages();
    }
  }, [incomingSignal]);

  const sendMessage = () => {
    if (!input.trim()) return;
    onSend(contact, input.trim());
    setInput('');
    setTimeout(loadMessages, 50);
  };

  return (
    <View style={{flex: 1, backgroundColor: '#0D0D1A'}}>
      <Text style={[styles.screenTitle, {marginTop: 10}]}>{displayName}</Text>
      <Text style={styles.subtitle}>{status}</Text>
      {status !== 'Connected ✅' && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            📡 Not connected yet — your messages will send once {displayName} is in range
          </Text>
        </View>
      )}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        style={{flex: 1, marginTop: 10}}
        ListEmptyComponent={<Text style={styles.noDevices}>No messages yet</Text>}
        renderItem={({item}) => (
          <View style={[styles.bubble, item.mine ? styles.myBubble : styles.theirBubble]}>
            <Text style={styles.msgText}>{item.text}</Text>
            <Text style={styles.timeText}>
              {item.time} {item.mine && item.status === 'pending' ? '🕓' : ''}
            </Text>
          </View>
        )}
      />
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message..."
          placeholderTextColor="#888"
        />
        <TouchableOpacity style={styles.sendBtn} onPress={sendMessage}>
          <Text style={styles.sendText}>➤</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Network Map Screen ───────────────────────────────────────────────────────

function NetworkMapScreen() {
  const nodes = [
    {id: 'you', label: 'You', x: 80, y: 230, color: '#00D4FF'},
    {id: 'b', label: 'Node B', x: 200, y: 130, color: '#00FF88'},
    {id: 'c', label: 'Node C', x: 200, y: 330, color: '#00FF88'},
    {id: 'd', label: 'Node D', x: 310, y: 60, color: '#FF8800'},
    {id: 'e', label: 'Node E', x: 310, y: 180, color: '#FF8800'},
    {id: 'f', label: 'Node F', x: 310, y: 390, color: '#888'},
  ];

  return (
    <View style={{flex: 1, backgroundColor: '#0D0D1A', padding: 20}}>
      <Text style={styles.screenTitle}>🕸 Mesh Network Map</Text>
      <Text style={styles.subtitle}>Live node topology</Text>
      <View style={{marginTop: 30, position: 'relative', height: 480}}>
        {nodes.map(node => (
          <View
            key={node.id}
            style={{
              position: 'absolute',
              left: node.x - 30,
              top: node.y - 30,
              width: 60,
              height: 60,
              borderRadius: 30,
              backgroundColor: node.color + '33',
              borderWidth: 2,
              borderColor: node.color,
              justifyContent: 'center',
              alignItems: 'center',
            }}>
            <Text style={{color: node.color, fontSize: 10, fontWeight: 'bold', textAlign: 'center'}}>
              {node.label}
            </Text>
          </View>
        ))}
      </View>
      <View style={{flexDirection: 'row', gap: 16, justifyContent: 'center', marginTop: 10}}>
        {[['#00D4FF', 'You'], ['#00FF88', '1 hop'], ['#FF8800', '2 hops'], ['#888', '3 hops']].map(
          ([color, label]) => (
            <View key={label} style={{flexDirection: 'row', alignItems: 'center', gap: 4}}>
              <View style={{width: 10, height: 10, borderRadius: 5, backgroundColor: color}} />
              <Text style={{color: '#888', fontSize: 11}}>{label}</Text>
            </View>
          ),
        )}
      </View>
    </View>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [selectedContact, setSelectedContact] = useState('');
  const [username, setUsername] = useState('');
  const [chatOrigin, setChatOrigin] = useState<'contacts' | 'chatslist'>('contacts');
  const [connStatusMap, setConnStatusMap] = useState<Record<string, string>>({});
  const [incomingSignal, setIncomingSignal] = useState<{contact: string; nonce: number} | null>(null);

  const socketRef = useRef<any>(null);
  const serverRef = useRef<any>(null);
  const keyRef = useRef<string | null>(null);
  const activePeerRef = useRef<string | null>(null);
  const screenRef = useRef(screen);
  const selectedContactRef = useRef(selectedContact);
  const usernameRef = useRef(username);
  const cancelledRef = useRef(false);
  const pollTimerRef = useRef<any>(null);
  const discoverTimerRef = useRef<any>(null);

  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { selectedContactRef.current = selectedContact; }, [selectedContact]);
  useEffect(() => { usernameRef.current = username; }, [username]);

  useEffect(() => {
    AsyncStorage.getItem('username').then(name => {
      if (name) {
        setUsername(name);
        setScreen('home');
      } else {
        setScreen('setup');
      }
    });
  }, []);

  const setStatus = (contact: string, status: string) => {
    setConnStatusMap(prev => ({...prev, [contact]: status}));
  };

  const deliverIncoming = async (contact: string, text: string) => {
    const storageKey = `chat_${contact}`;
    const saved = await AsyncStorage.getItem(storageKey);
    const messages = saved ? JSON.parse(saved) : [];
    messages.push({id: Date.now().toString() + Math.random().toString(36).slice(2), text, mine: false, time: getTimeNow(), status: 'sent'});
    await AsyncStorage.setItem(storageKey, JSON.stringify(messages));
    setIncomingSignal({contact, nonce: Date.now()});
  };

  const flushQueueFor = async (contact: string) => {
    if (!socketRef.current || !keyRef.current || activePeerRef.current !== contact) return;
    const storageKey = `chat_${contact}`;
    const saved = await AsyncStorage.getItem(storageKey);
    const messages = saved ? JSON.parse(saved) : [];
    let changed = false;
    for (const m of messages) {
      if (m.mine && m.status === 'pending') {
        try {
          const packet: Packet = {
            messageId: m.id,
            senderId: 'my-device',
            recipientId: contact,
            text: encryptText(m.text, keyRef.current),
            ttl: 20,
            visitedNodes: ['my-device'],
            timestamp: Date.now(),
          };
          socketRef.current.write(JSON.stringify(packet) + '\n');
          m.status = 'sent';
          changed = true;
        } catch (e) {}
      }
    }
    if (changed) {
      await AsyncStorage.setItem(storageKey, JSON.stringify(messages));
      setIncomingSignal({contact, nonce: Date.now()});
    }
  };

  const sendToContact = async (contact: string, text: string) => {
    const storageKey = `chat_${contact}`;
    const saved = await AsyncStorage.getItem(storageKey);
    const messages = saved ? JSON.parse(saved) : [];
    messages.push({id: Date.now().toString(), text, mine: true, time: getTimeNow(), status: 'pending'});
    await AsyncStorage.setItem(storageKey, JSON.stringify(messages));
    setIncomingSignal({contact, nonce: Date.now()});
    flushQueueFor(contact);
  };

  const sendMyHello = async (socket: any, amOwner: boolean, contact: string | null) => {
    let keyHex: string | null = null;
    if (contact) keyHex = await getKey(contact);
    if (amOwner && contact && !keyHex) {
      keyHex = CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
      await saveKey(contact, keyHex);
    }
    if (contact) keyRef.current = keyHex;
    try {
      socket.write(JSON.stringify({type: 'hello', from: usernameRef.current, key: amOwner ? keyHex : undefined}) + '\n');
    } catch (e) {}
  };

  const bindSocket = (socket: any, amOwner: boolean, knownContact: string | null) => {
    socketRef.current = socket;
    let contact = knownContact;

    if (contact) {
      activePeerRef.current = contact;
      setStatus(contact, 'Connected ✅');
      sendMyHello(socket, amOwner, contact);
    }

    socket.on('data', async (data: any) => {
      try {
        const parsed: any = JSON.parse(data.toString().trim());
        if (parsed.type === 'hello') {
          if (!contact) {
            contact = await findDeviceNameForUsername(parsed.from);
            activePeerRef.current = contact;
            await saveContact(contact);
            setStatus(contact, 'Connected ✅');
            await sendMyHello(socket, amOwner, contact);
          }
          await saveUsername(contact, parsed.from);
          if (parsed.key) {
            keyRef.current = parsed.key;
            await saveKey(contact, parsed.key);
          }
          if (keyRef.current) await flushQueueFor(contact);
          return;
        }
        if (parsed.text && contact) {
          const plain = keyRef.current ? decryptText(parsed.text, keyRef.current) : parsed.text;
          await deliverIncoming(contact, plain);
        }
      } catch {
        if (contact) await deliverIncoming(contact, data.toString().trim());
      }
    });

    socket.on('error', () => {
      if (contact) setStatus(contact, 'Disconnected');
    });
    socket.on('close', () => {
      if (contact) setStatus(contact, 'Disconnected');
      if (activePeerRef.current === contact) activePeerRef.current = null;
      socketRef.current = null;
      keyRef.current = null;
    });
  };

  const openAsServer = () => {
    if (serverRef.current) return;
    const server = TcpSocket.createServer((socket: any) => bindSocket(socket, true, null));
    server.listen({port: 8888, host: '0.0.0.0'});
    serverRef.current = server;
  };

  const openAsClient = (ip: string, contact: string | null) => {
    if (socketRef.current) return;
    let attempts = 0;
    const tryConnect = () => {
      if (cancelledRef.current) return;
      attempts++;
      const socket = TcpSocket.createConnection(
        {port: 8888, host: ip, timeout: 5000},
        () => bindSocket(socket, false, contact),
      );
      socket.on('error', () => {
        if (!cancelledRef.current && attempts < 5) setTimeout(tryConnect, 2000);
      });
    };
    tryConnect();
  };

  const checkAlreadyConnected = async (contactHint: string | null) => {
    try {
      const info = await getConnectionInfo();
      if (info?.groupOwnerAddress?.hostAddress) {
        if (info.isGroupOwner) openAsServer();
        else openAsClient(info.groupOwnerAddress.hostAddress, contactHint);
        return true;
      }
    } catch (e) {}
    return false;
  };

  useEffect(() => {
    cancelledRef.current = false;

    const searchLoop = async () => {
      await checkAlreadyConnected(null);
      try {
        await startDiscoveringPeers();
      } catch (e) {}

      pollTimerRef.current = setInterval(async () => {
        if (cancelledRef.current || socketRef.current) return;
        if (screenRef.current !== 'chat' || !selectedContactRef.current) return;
        const target = selectedContactRef.current;
        try {
          const result = await getAvailablePeers();
          const match = result.devices?.find((d: any) => d.deviceName === target);
          if (match) {
            setStatus(target, `Connecting to ${target}...`);
            try {
              await connectWithConfig({deviceAddress: match.deviceAddress, groupOwnerIntent: 0});
              for (let i = 0; i < 15 && !cancelledRef.current; i++) {
                await new Promise(r => setTimeout(r, 1000));
                const ok = await checkAlreadyConnected(target);
                if (ok) break;
              }
            } catch (e) {}
            if (!socketRef.current) setStatus(target, `Looking for ${target}...`);
          }
        } catch (e) {}
      }, 3000);

      discoverTimerRef.current = setInterval(() => {
        startDiscoveringPeers().catch(() => {});
      }, 10000);
    };

    const start = async () => {
      try {
        const granted = await requestPermissions();
        if (!granted) return;
        await initialize();
      } catch (e) {
        console.log('Root WiFi init error:', e);
        return;
      }
      openAsServer();
      await searchLoop();
    };

    start();

    return () => {
      cancelledRef.current = true;
      clearInterval(pollTimerRef.current);
      clearInterval(discoverTimerRef.current);
    };
  }, []);

  const goBack = () => {
    if (screen === 'chat') setScreen(chatOrigin);
    else if (screen === 'map') setScreen('home');
    else if (screen === 'chatslist') setScreen('home');
    else setScreen('home');
  };

  return (
    <View style={{flex: 1, backgroundColor: '#0D0D1A'}}>
      <StatusBar backgroundColor="#0D0D1A" barStyle="light-content" />
      {screen !== 'home' && screen !== 'loading' && screen !== 'setup' && (
        <TouchableOpacity style={styles.backBar} onPress={goBack}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
      )}
      {screen === 'loading' && (
        <View style={styles.container}>
          <Text style={styles.logo}>👻</Text>
        </View>
      )}
      {screen === 'setup' && (
        <SetupScreen onDone={name => {setUsername(name); setScreen('home');}} />
      )}
      {screen === 'home' && (
        <HomeScreen
          onStart={() => setScreen('contacts')}
          onMap={() => setScreen('map')}
          onChats={() => setScreen('chatslist')}
        />
      )}
      {screen === 'chatslist' && (
        <ChatsListScreen
          onChat={name => {
            setSelectedContact(name);
            setChatOrigin('chatslist');
            setScreen('chat');
          }}
        />
      )}
      {screen === 'contacts' && (
        <ContactsScreen
          username={username}
          onChat={name => {
            setSelectedContact(name);
            setChatOrigin('contacts');
            setScreen('chat');
          }}
        />
      )}
      {screen === 'chat' && (
        <ChatScreen
          contact={selectedContact}
          myUsername={username}
          status={connStatusMap[selectedContact] || `Looking for ${selectedContact}...`}
          incomingSignal={incomingSignal}
          onSend={sendToContact}
        />
      )}
      {screen === 'map' && <NetworkMapScreen />}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0D1A',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  logo: {fontSize: 80},
  title: {color: '#FFFFFF', fontSize: 36, fontWeight: 'bold', marginTop: 16},
  tagline: {color: '#888', fontSize: 14, textAlign: 'center', marginTop: 8, fontStyle: 'italic'},
  badge: {backgroundColor: '#0F3460', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 20, marginTop: 20},
  badgeText: {color: '#00D4FF', fontSize: 12},
  button: {backgroundColor: '#00D4FF', paddingHorizontal: 30, paddingVertical: 15, borderRadius: 25, marginTop: 40},
  buttonText: {color: '#000', fontSize: 16, fontWeight: 'bold'},
  backBar: {paddingHorizontal: 16, paddingTop: 50, paddingBottom: 10, backgroundColor: '#1A1A2E'},
  backText: {color: '#00D4FF', fontSize: 16},
  screenTitle: {color: '#FFFFFF', fontSize: 22, fontWeight: 'bold', marginTop: 20, textAlign: 'center'},
  subtitle: {color: '#00D4FF', fontSize: 12, marginTop: 4, textAlign: 'center'},
  scanBtn: {backgroundColor: '#0F3460', paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20, marginTop: 12},
  scanText: {color: '#00D4FF', fontSize: 13},
  noDevices: {color: '#888', fontSize: 14, textAlign: 'center', marginTop: 30, lineHeight: 22},
  deviceCard: {
    backgroundColor: '#1A1A2E',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    marginHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deviceName: {color: '#FFFFFF', fontSize: 15, fontWeight: 'bold'},
  deviceInfo: {color: '#888', fontSize: 12, marginTop: 4},
  chatIconBtn: {
    backgroundColor: '#0F3460',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chatIconText: {fontSize: 18},
  connectBtn: {
    backgroundColor: '#00D4FF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
  },
  connectBtnText: {color: '#000', fontSize: 13, fontWeight: 'bold'},
  sosButton: {backgroundColor: '#FF4444', paddingHorizontal: 30, paddingVertical: 12, borderRadius: 25, margin: 20},
  sosText: {color: '#FFF', fontSize: 16, fontWeight: 'bold'},
  bubble: {maxWidth: '75%', padding: 12, borderRadius: 16, marginBottom: 8, marginHorizontal: 16},
  myBubble: {backgroundColor: '#0F3460', alignSelf: 'flex-end'},
  theirBubble: {backgroundColor: '#1E1E3A', alignSelf: 'flex-start'},
  msgText: {color: '#FFF', fontSize: 15},
  timeText: {color: '#888', fontSize: 10, marginTop: 3, textAlign: 'right'},
  inputRow: {flexDirection: 'row', padding: 12, backgroundColor: '#1A1A2E', alignItems: 'center'},
  input: {
    flex: 1,
    backgroundColor: '#0D0D1A',
    color: '#FFF',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#0F3460',
  },
  sendBtn: {backgroundColor: '#00D4FF', width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginLeft: 8},
  sendText: {color: '#000', fontSize: 18, fontWeight: 'bold'},
  offlineBanner: {backgroundColor: '#1A1A00', padding: 10, marginHorizontal: 16, borderRadius: 8, marginTop: 8},
  offlineBannerText: {color: '#FFD700', fontSize: 12, textAlign: 'center'},
});