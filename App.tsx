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
  Modal,
} from 'react-native';

import {
  initialize,
  startDiscoveringPeers,
  getAvailablePeers,
  connectWithConfig,
  getConnectionInfo,
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

interface ConnectionRequest {
  deviceName: string;
  deviceAddress: string;
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
  const [contacts, setContacts] = useState<{name: string; lastConnected: number}[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(CONTACTS_KEY).then(raw => {
      if (raw) setContacts(JSON.parse(raw));
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
              <Text style={styles.deviceName}>{item.name}</Text>
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
  onChat: (name: string, address: string, isServer: boolean) => void;
  username: string;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState('');
  const [incomingRequest, setIncomingRequest] = useState<ConnectionRequest | null>(null);
  const pollRef = useRef<any>(null);
  const connectionCheckRef = useRef<any>(null);

  useEffect(() => {
    initWifi();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (connectionCheckRef.current) clearInterval(connectionCheckRef.current);
    };
  }, []);

  const initWifi = async () => {
    try {
      const hasPermission = await requestPermissions();
      if (!hasPermission) {
        Alert.alert('Permission Required', 'Location permission needed for WiFi Direct.');
        return;
      }
      await initialize();
      setTimeout(() => startScan(), 1500);
      // Start listening for incoming connections
      startListeningForConnections();
    } catch (error) {
      console.log('WiFi init error:', error);
    }
  };

  // Poll connection info to detect incoming connection requests
  const startListeningForConnections = () => {
    connectionCheckRef.current = setInterval(async () => {
      try {
        const info = await getConnectionInfo();
        // If someone connected to us and we didn't initiate
        if (info?.groupOwnerAddress && connecting === '') {
          const ip = info.groupOwnerAddress?.hostAddress || '';
          const isOwner = info.isGroupOwner;
          console.log('Passive connection detected:', JSON.stringify(info));
          // Show incoming request popup
          setIncomingRequest({
            deviceName: 'Nearby Device',
            deviceAddress: ip,
          });
          clearInterval(connectionCheckRef.current);
        }
      } catch (e) {}
    }, 2000);
  };

  const startScan = async () => {
    try {
      if (pollRef.current) clearInterval(pollRef.current);
      setScanning(true);
      setDevices([]);

      try {
        await startDiscoveringPeers();
        console.log('Discovery started');
      } catch (discoverError: any) {
        console.log('Discovery failed:', discoverError);
        Alert.alert('Scan Failed', `Error: ${discoverError?.message || JSON.stringify(discoverError)}`);
        setScanning(false);
        return;
      }

      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        try {
          const result = await getAvailablePeers();
          console.log(`Poll ${attempts}: found ${result.devices?.length || 0} peers`);
          if (result.devices && result.devices.length > 0) {
            const mapped = result.devices.map((d: any) => ({
              id: d.deviceAddress,
              name: d.deviceName || `Device ${d.deviceAddress.slice(-6)}`,
              address: d.deviceAddress,
              hops: 1,
              signal: 'Direct',
            }));
            setDevices(mapped);
            setScanning(false);
            clearInterval(pollRef.current);
          }
        } catch (e) {
          console.log('Poll error:', e);
        }
        if (attempts >= 10) {
          clearInterval(pollRef.current);
          setScanning(false);
        }
      }, 3000);
    } catch (error: any) {
      console.log('Scan error:', error);
      Alert.alert('Scan Error', error?.message || JSON.stringify(error));
      setScanning(false);
    }
  };

  const connectToDevice = async (device: Device) => {
    try {
      setConnecting(device.id);

      await connectWithConfig({
        deviceAddress: device.address,
        groupOwnerIntent: 0, // Let the other device be group owner (server)
      });

      // Poll for connection info
      let info = null;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          info = await getConnectionInfo();
          if (info?.groupOwnerAddress?.hostAddress) break;
        } catch (e) {}
      }

      if (!info?.groupOwnerAddress?.hostAddress) {
        Alert.alert('Connection Failed', 'Could not establish connection. Make sure the other phone accepts the request.');
        setConnecting('');
        return;
      }

      console.log('Connected! Info:', JSON.stringify(info));
      const isOwner = info.isGroupOwner;
      const ownerIP = info.groupOwnerAddress?.hostAddress || '';

      await saveContact(device.name);
      // Navigate to chat
      onChat(device.name, isOwner ? 'SERVER' : ownerIP, isOwner);
    } catch (error: any) {
      Alert.alert('Connection Failed', error?.message || 'Try again.');
      console.log('Connect error:', error);
    } finally {
      setConnecting('');
    }
  };

  const openExistingChat = (device: Device) => {
    // Open chat with stored messages — no connection needed
    onChat(device.name, '', false);
  };

  const acceptIncomingRequest = async () => {
    if (!incomingRequest) return;
    setIncomingRequest(null);
    try {
      let info = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          info = await getConnectionInfo();
          if (info?.groupOwnerAddress?.hostAddress) break;
        } catch (e) {}
      }
      const isOwner = info?.isGroupOwner || false;
      const ownerIP = info?.groupOwnerAddress?.hostAddress || '';
      await saveContact(incomingRequest.deviceName);
      onChat(incomingRequest.deviceName, isOwner ? 'SERVER' : ownerIP, isOwner);
    } catch (e) {
      console.log('Accept error:', e);
    }
  };

  return (
    <View style={styles.container}>
      {/* Incoming Request Modal */}
      <Modal visible={!!incomingRequest} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>📲 Incoming Request</Text>
            <Text style={styles.modalText}>
              {incomingRequest?.deviceName} wants to connect
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, {backgroundColor: '#FF4444'}]}
                onPress={() => setIncomingRequest(null)}>
                <Text style={styles.modalBtnText}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, {backgroundColor: '#00D4FF'}]}
                onPress={acceptIncomingRequest}>
                <Text style={[styles.modalBtnText, {color: '#000'}]}>Accept</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Text style={styles.screenTitle}>📡 Nearby Devices</Text>
      <Text style={styles.subtitle}>
        {scanning ? 'Scanning... (up to 30s)' : `${devices.length} devices found`}
      </Text>
      <TouchableOpacity style={styles.scanBtn} onPress={startScan}>
        <Text style={styles.scanText}>
          {scanning ? '⏳ Scanning...' : '🔄 Scan Again'}
        </Text>
      </TouchableOpacity>

      {devices.length === 0 && !scanning && (
        <Text style={styles.noDevices}>
          No devices found.{'\n'}Make sure other phones have PhantomMesh open!
        </Text>
      )}

      <FlatList
        data={devices}
        keyExtractor={item => item.id}
        style={{width: '100%', marginTop: 10}}
        renderItem={({item}) => (
          <View style={styles.deviceCard}>
            <View style={{flex: 1}}>
              <Text style={styles.deviceName}>{item.name}</Text>
              <Text style={styles.deviceInfo}>{item.hops} hop • {item.signal}</Text>
            </View>
            {/* Chat button — opens old msgs without connecting */}
            <TouchableOpacity
              style={styles.chatIconBtn}
              onPress={() => openExistingChat(item)}>
              <Text style={styles.chatIconText}>💬</Text>
            </TouchableOpacity>
            {/* Connect button */}
            <TouchableOpacity
              style={styles.connectBtn}
              onPress={() => connectToDevice(item)}
              disabled={connecting === item.id}>
              <Text style={styles.connectBtnText}>
                {connecting === item.id ? '...' : 'Connect'}
              </Text>
            </TouchableOpacity>
          </View>
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
  peerIP,
  isServer,
}: {
  contact: string;
  peerIP: string;
  isServer: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const socketRef = useRef<any>(null);
  const serverRef = useRef<any>(null);
  const flatListRef = useRef<any>(null);
  const storageKey = `chat_${contact}`;
  const isConnected = peerIP !== '';

  const getTime = () => {
    const now = new Date();
    return now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
  };

  // Load saved messages
  useEffect(() => {
    AsyncStorage.getItem(storageKey).then(saved => {
      if (saved) {
        try {
          setMessages(JSON.parse(saved));
        } catch (e) {}
      }
    });
  }, []);

  const addMessage = (text: string, mine: boolean, status: 'pending' | 'sent' = 'sent') => {
    setMessages(prev => {
      const updated = [
        ...prev,
        {id: Date.now().toString(), text, mine, time: getTime(), status},
      ];
      AsyncStorage.setItem(storageKey, JSON.stringify(updated));
      return updated;
    });
    setTimeout(() => flatListRef.current?.scrollToEnd(), 100);
  };

  // Setup TCP connection only if we have an IP
  useEffect(() => {
    if (!isConnected) {
      setStatus('Not connected — tap Connect to send messages');
      return;
    }

    if (isServer) {
      setStatus('Waiting for peer to connect...');
      const server = TcpSocket.createServer(socket => {
        socketRef.current = socket;
        setStatus('Connected ✅');
        socket.on('data', (data: any) => {
          try {
            const packet: Packet = JSON.parse(data.toString().trim());
            if (packet.text) addMessage(packet.text, false);
          } catch {
            addMessage(data.toString().trim(), false);
          }
        });
        socket.on('error', (e: any) => {
          console.log('Socket error:', e);
          setStatus('Disconnected ❌');
        });
        socket.on('close', () => setStatus('Peer disconnected'));
      });
      server.listen({port: 8888, host: '0.0.0.0'});
      serverRef.current = server;
    } else {
      setStatus('Connecting to ' + peerIP + '...');
      let attempts = 0;
      const tryConnect = () => {
        attempts++;
        console.log(`TCP attempt ${attempts} → ${peerIP}:8888`);
        const socket = TcpSocket.createConnection(
          {port: 8888, host: peerIP, timeout: 5000},
          () => setStatus('Connected ✅'),
        );
        socket.on('data', (data: any) => {
          try {
            const packet: Packet = JSON.parse(data.toString().trim());
            if (packet.text) addMessage(packet.text, false);
          } catch {
            addMessage(data.toString().trim(), false);
          }
        });
        socket.on('error', (e: any) => {
          console.log(`TCP error ${attempts}:`, e);
          if (attempts < 5) setTimeout(tryConnect, 2000);
          else setStatus('Connection failed ❌');
        });
        socketRef.current = socket;
      };
      setTimeout(tryConnect, 1500);
    }

    return () => {
      socketRef.current?.destroy();
      serverRef.current?.close();
    };
  }, []);

  const sendMessage = () => {
    if (!input.trim()) return;
    const text = input.trim();
    const packet: Packet = {
      messageId: Date.now().toString(),
      senderId: 'my-device',
      recipientId: contact,
      text,
      ttl: 20,
      visitedNodes: ['my-device'],
      timestamp: Date.now(),
    };

    if (socketRef.current) {
      try {
        socketRef.current.write(JSON.stringify(packet) + '\n');
        addMessage(text, true, 'sent');
      } catch (e) {
        addMessage(text, true, 'pending'); // socket existed but write failed — queue it
      }
    } else {
      addMessage(text, true, 'pending'); // not connected — queue it, no alert
    }
    setInput('');
  };

  return (
    <View style={{flex: 1, backgroundColor: '#0D0D1A'}}>
      <Text style={[styles.screenTitle, {marginTop: 10}]}>{contact}</Text>
      <Text style={styles.subtitle}>{status}</Text>
      {!isConnected && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            📖 Viewing chat history — go back and tap Connect to send messages
          </Text>
        </View>
      )}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        style={{flex: 1, marginTop: 10}}
        ListEmptyComponent={
          <Text style={styles.noDevices}>No messages yet</Text>
        }
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
  const [peerIP, setPeerIP] = useState('');
  const [isServer, setIsServer] = useState(false);
  const [username, setUsername] = useState('');
  const [chatOrigin, setChatOrigin] = useState<'contacts' | 'chatslist'>('contacts');

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
            setPeerIP('');
            setIsServer(false);
            setChatOrigin('chatslist');
            setScreen('chat');
          }}
        />
      )}
      {screen === 'contacts' && (
        <ContactsScreen
          username={username}
          onChat={(name, ip, server) => {
            setSelectedContact(name);
            setPeerIP(ip);
            setIsServer(server);
            setChatOrigin('contacts');
            setScreen('chat');
          }}
        />
      )}
      {screen === 'chat' && (
        <ChatScreen contact={selectedContact} peerIP={peerIP} isServer={isServer} />
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
  // Modal styles
  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center'},
  modalBox: {backgroundColor: '#1A1A2E', borderRadius: 16, padding: 24, width: '80%', borderWidth: 1, borderColor: '#00D4FF'},
  modalTitle: {color: '#FFF', fontSize: 20, fontWeight: 'bold', textAlign: 'center'},
  modalText: {color: '#888', fontSize: 14, textAlign: 'center', marginTop: 10, marginBottom: 20},
  modalButtons: {flexDirection: 'row', justifyContent: 'space-between', gap: 12},
  modalBtn: {flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center'},
  modalBtnText: {color: '#FFF', fontSize: 15, fontWeight: 'bold'},
});