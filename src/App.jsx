import React, { useState, useEffect, useRef } from 'react';
import Pusher from 'pusher-js';
import { Camera, CameraOff, Mic, MicOff, PhoneOff, Video, Share2, Copy, Check, Monitor, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QRCode } from 'react-qr-code';
import { initDB, saveMessageLocally, getMessagesLocally } from './db.js';


const SIGNAL_SERVER = '';
const PUSHER_KEY = import.meta.env.VITE_PUSHER_KEY || 'your-pusher-key';
const PUSHER_CLUSTER = import.meta.env.VITE_PUSHER_CLUSTER || 'mt1';
const MAX_PARTICIPANTS = 4;

// Utility to generate a stable 8-char hash for room salting
const generateHash = async (roomId, pin) => {
  if (!roomId || !pin) return '';
  const msgUint8 = new TextEncoder().encode(`${roomId}-${pin}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  // Convert to hex and take first 8 chars
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
};

const App = () => {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [stream, setStream] = useState(null);
  const [peers, setPeers] = useState({});
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isInvited, setIsInvited] = useState(false);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [pin, setPin] = useState('');
  const [timeRemaining, setTimeRemaining] = useState(60);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isPinVerified, setIsPinVerified] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [pinError, setPinError] = useState('');
  const [saltedRoomId, setSaltedRoomId] = useState('');
  const [showQR, setShowQR] = useState(false);

  // Chat state
  const [showChat, setShowChat] = useState(false);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');

  const pusherRef = useRef();
  const channelRef = useRef();
  const pinRef = useRef('');
  const privateChannelRef = useRef();
  const streamRef = useRef();
  const screenStreamRef = useRef();
  const peersRef = useRef({}); // { userId: RTCPeerConnection }
  const dataChannelsRef = useRef({}); // { userId: RTCDataChannel }
  const chatEndRef = useRef(null);

  useEffect(() => {
    // Initialize DuckDB WASM on mount
    initDB().then(() => {
      getMessagesLocally().then(savedMsgs => {
        if(savedMsgs.length > 0) setMessages(savedMsgs);
      });
    });

    const urlParams = new URLSearchParams(window.location.search);
    const room = urlParams.get('room');
    if (room) {
      if (room.includes('--')) {
        setSaltedRoomId(room);
        setRoomId(room.split('--')[0]);
        setIsPinVerified(true);
      } else {
        setRoomId(room);
      }
      setIsInvited(true);
    } else {
      setRoomId(crypto.randomUUID().slice(0, 8));
    }

    pusherRef.current = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      authorizer: (channel, options) => {
        return {
          authorize: (socketId, callback) => {
            fetch(`${SIGNAL_SERVER}/api/pusher/auth`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                socket_id: socketId,
                channel_name: channel.name,
                pin: pinRef.current
              })
            })
            .then(res => res.json())
            .then(data => callback(null, data))
            .catch(err => callback(err));
          }
        };
      }
    });

    pusherRef.current.connection.bind('connected', () => {
      setConnectionStatus('Online');
      setError('');
    });

    pusherRef.current.connection.bind('error', (err) => {
      setConnectionStatus('Error');
      setError('Signal server unreachable. Please check Pusher credentials.');
    });

    return () => {
      if (pusherRef.current) pusherRef.current.disconnect();
    };
  }, []);

  // Auto-scroll to bottom of chat
  useEffect(() => {
    if (showChat) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, showChat]);

  useEffect(() => {
    pinRef.current = pin;
  }, [pin]);

  useEffect(() => {
    let timer;
    if (joined && Object.keys(peers).length === 0) {
      setTimeRemaining(60);
      timer = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 1) {
            clearInterval(timer);
            leaveCall('Room closed: No other participants joined within 1 minute.');
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      setTimeRemaining(60);
    }
    return () => clearInterval(timer);
  }, [joined, Object.keys(peers).length]);

  const sendSignal = async (target, event, data) => {
    try {
      await fetch(`${SIGNAL_SERVER}/api/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target,
          event,
          data,
          from: pusherRef.current.connection.socket_id,
        }),
      });
    } catch (err) {
      console.error('Failed to send signal:', err);
    }
  };

  const iceQueueRef = useRef({});

  const handleDataChannelMessage = (event) => {
    const data = JSON.parse(event.data);
    setMessages(prev => [...prev, data]);
    saveMessageLocally(data.id, data.sender, data.content, data.timestamp);
  };

  const createPeerConnection = (userId) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    iceQueueRef.current[userId] = [];

    // Create Data Channel for chatting
    const dc = pc.createDataChannel('chat');
    dataChannelsRef.current[userId] = dc;
    dc.onmessage = handleDataChannelMessage;

    // Receive incoming Data Channel
    pc.ondatachannel = (event) => {
      const receiveChannel = event.channel;
      receiveChannel.onmessage = handleDataChannelMessage;
      // We overwrite since P2P chat can be bidirectional on the same channel, but it's safe to track
      dataChannelsRef.current[userId] = receiveChannel; 
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(userId, 'ice-candidate', event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        cleanupPeer(userId);
      }
    };

    pc.ontrack = (event) => {
      setPeers(prev => ({
        ...prev,
        [userId]: event.streams[0]
      }));
    };

    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(track => pc.addTrack(track, streamRef.current));
      const videoTrack = isScreenSharing && screenStreamRef.current 
        ? screenStreamRef.current.getVideoTracks()[0] 
        : streamRef.current.getVideoTracks()[0];
        
      if (videoTrack) {
        pc.addTrack(videoTrack, isScreenSharing ? screenStreamRef.current : streamRef.current);
      }
    }

    peersRef.current[userId] = pc;
    return pc;
  };

  const processIceQueue = (userId) => {
    const pc = peersRef.current[userId];
    const queue = iceQueueRef.current[userId];
    if (pc && pc.remoteDescription && queue) {
      while (queue.length > 0) {
        const candidate = queue.shift();
        pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => 
          console.error('Error adding queued ICE candidate', e)
        );
      }
    }
  };

  const cleanupPeer = (userId) => {
    if (peersRef.current[userId]) {
      peersRef.current[userId].close();
      delete peersRef.current[userId];
    }
    if (dataChannelsRef.current[userId]) {
      delete dataChannelsRef.current[userId];
    }
    delete iceQueueRef.current[userId];
    setPeers(prev => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const handleVerifyPin = async () => {
    if (!pin) return;
    setIsVerifying(true);
    setPinError('');
    try {
      const response = await fetch(`${SIGNAL_SERVER}/api/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (response.ok) {
        const hash = await generateHash(roomId.trim(), pin);
        setSaltedRoomId(`${roomId.trim()}--${hash}`);
        setIsPinVerified(true);
        setPinError('');
      } else {
        setPinError('Invalid Secret PIN');
      }
    } catch (err) {
      setPinError('Error verifying PIN. Make sure server is running.');
    } finally {
      setIsVerifying(false);
    }
  };

  const sendChatMessage = (e) => {
    e.preventDefault();
    if(!chatInput.trim()) return;

    const msg = {
      id: crypto.randomUUID(),
      sender: pusherRef.current.connection.socket_id,
      content: chatInput.trim(),
      timestamp: Date.now()
    };

    // Broadcast to all connected peers
    Object.values(dataChannelsRef.current).forEach(dc => {
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify(msg));
      }
    });

    setMessages(prev => [...prev, msg]);
    saveMessageLocally(msg.id, msg.sender, msg.content, msg.timestamp);
    setChatInput('');
  };

  const joinRoom = async () => {
    const trimmedId = roomId.trim();
    if (!trimmedId) return;
    
    setError('');
    try {
      const userStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStream(userStream);
      streamRef.current = userStream;

      const selfId = pusherRef.current.connection.socket_id;
      const finalRoomId = saltedRoomId || trimmedId;

      channelRef.current = pusherRef.current.subscribe(`presence-room-${finalRoomId}`);

      channelRef.current.bind('pusher:subscription_succeeded', (members) => {
        setJoined(true);
        members.each((member) => {
          if (member.id !== selfId) {
            const pc = createPeerConnection(member.id);
            pc.createOffer().then(async (offer) => {
              await pc.setLocalDescription(offer);
              sendSignal(member.id, 'offer', offer);
            });
          }
        });
      });

      channelRef.current.bind('pusher:member_removed', (member) => {
        cleanupPeer(member.id);
      });

      privateChannelRef.current = pusherRef.current.subscribe(`private-user-${selfId}`);

      privateChannelRef.current.bind('offer', async ({ from, signal: offer }) => {
        const pc = createPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(from, 'answer', answer);
        processIceQueue(from);
      });

      privateChannelRef.current.bind('answer', async ({ from, signal: answer }) => {
        const pc = peersRef.current[from];
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          processIceQueue(from);
        }
      });

      privateChannelRef.current.bind('ice-candidate', async ({ from, signal: candidate }) => {
        const pc = peersRef.current[from];
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          if (!iceQueueRef.current[from]) iceQueueRef.current[from] = [];
          iceQueueRef.current[from].push(candidate);
        }
      });

    } catch (err) {
      if (err.message === 'Invalid PIN for room creation') {
        setError('Invalid PIN. You need the correct secret PIN to create a new room.');
      } else {
        setError('Could not access camera/microphone or connect to signal server.');
      }
    }
  };

  const toggleMute = () => {
    if (streamRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!audioTrack.enabled);
    }
  };

  const toggleVideo = () => {
    if (streamRef.current) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      videoTrack.enabled = !videoTrack.enabled;
      setIsVideoOff(!videoTrack.enabled);
    }
  };

  const toggleScreenSharing = async () => {
    if (!isScreenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];

        Object.values(peersRef.current).forEach(pc => {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        });

        setIsScreenSharing(true);
        setStream(new MediaStream([screenTrack, streamRef.current.getAudioTracks()[0]]));

        screenTrack.onended = () => stopScreenSharing();
      } catch (err) {}
    } else {
      stopScreenSharing();
    }
  };

  const stopScreenSharing = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }

    const cameraTrack = streamRef.current.getVideoTracks()[0];
    Object.values(peersRef.current).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(cameraTrack);
    });

    setIsScreenSharing(false);
    setStream(streamRef.current);
  };

  const leaveCall = (reason) => {
    if (typeof reason === 'string') alert(reason);
    window.location.reload();
  };

  const handleCopyLink = () => {
    const finalId = saltedRoomId || roomId;
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${finalId}`;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="container">
      <AnimatePresence mode="wait">
        {!joined ? (
          <motion.div 
            key="join"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="join-screen glass"
          >
            <div className="header">
              <span className={`status-badge ${connectionStatus.toLowerCase()}`}>{connectionStatus}</span>
              <h1>Meet</h1>
              <p>{isInvited ? 'You have been invited' : 'Create a room to start talking'}</p>
            </div>

            {error && <div className="error-alert">{error}</div>}

            {isInvited ? (
              <div className="invited-container">
                <div className="invited-box glass">
                  <span>Room ID</span>
                  <h2>{roomId}</h2>
                </div>
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={joinRoom}>
                  Join Meeting Now
                </button>
                <button className="btn-link" onClick={() => setIsInvited(false)}>
                  Create a new room
                </button>
              </div>
            ) : (
              <div className="join-form">
                <input 
                  type="text" 
                  placeholder="Enter Room ID (e.g. project-x)" 
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                />

                <input 
                  type="password" 
                  placeholder="Enter Secret PIN to Create" 
                  value={pin}
                  onChange={(e) => {
                    setPin(e.target.value);
                    setIsPinVerified(false);
                    setPinError('');
                  }}
                  style={{ marginTop: '1rem' }}
                />

                {!isPinVerified && (
                  <button 
                    className="btn btn-secondary" 
                    style={{ width: '100%', marginTop: '0.5rem' }}
                    onClick={handleVerifyPin}
                    disabled={isVerifying || !pin}
                  >
                    {isVerifying ? 'Verifying...' : 'Verify PIN'}
                  </button>
                )}

                {pinError && (
                  <p style={{ color: '#ff4d4d', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                    {pinError}
                  </p>
                )}
                
                {isPinVerified && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                  >
                    {roomId && (
                      <div className="share-link-container">
                        <p>Scan to join or copy link:</p>
                        <div className="share-qr-group">
                          <div className="qr-wrapper glass">
                            <QRCode 
                              value={`${window.location.origin}${window.location.pathname}?room=${roomId}`} 
                              size={160}
                              bgColor="#ffffff"
                              fgColor="#0f172a"
                            />
                          </div>
                          <button className="btn btn-secondary btn-copy" onClick={handleCopyLink}>
                            {copied ? (
                              <><Check size={18} color="#10b981" /><span>Copied!</span></>
                            ) : (
                              <><Copy size={18} /><span>Copy Link</span></>
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    <button 
                      className="btn btn-primary" 
                       style={{ width: '100%', marginTop: '1rem' }} 
                      onClick={joinRoom}
                    >
                      Create & Join
                    </button>
                  </motion.div>
                )}
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div 
            key="call"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`call-screen ${showChat ? 'with-chat' : ''}`}
          >
            <div className="main-call-area">
              <div className="room-info-badge glass" onClick={() => setShowQR(true)}>
                <Share2 size={16} />
                <span>Room: {roomId}</span>
                <div className="participant-count">
                  {Object.keys(peers).length + 1} / {MAX_PARTICIPANTS} users
                </div>
                {Object.keys(peers).length === 0 && (
                  <div className="solitude-warning">
                    Closing in {timeRemaining}s
                  </div>
                )}
                <Check size={14} style={{ opacity: copied ? 1 : 0, color: "#10b981" }} />
              </div>

              <div className="video-container">
                <div className="video-wrapper glass">
                  <VideoPlayer stream={stream} muted={true} />
                  <div className="video-label">You {isVideoOff && '(Video Off)'}</div>
                </div>
                
                {Object.entries(peers).map(([id, remoteStream]) => (
                  <div key={id} className="video-wrapper glass">
                    <VideoPlayer stream={remoteStream} />
                    <div className="video-label">User {id.slice(0, 4)}</div>
                  </div>
                ))}
              </div>

              <div className="controls glass">
                <button className={`btn ${isMuted ? 'btn-danger' : 'btn-secondary'}`} onClick={toggleMute}>
                  {isMuted ? <MicOff /> : <Mic />}
                </button>
                <button className={`btn ${isVideoOff ? 'btn-danger' : 'btn-secondary'}`} onClick={toggleVideo} disabled={isScreenSharing}>
                  {isVideoOff ? <CameraOff /> : <Camera />}
                </button>
                <button className={`btn ${isScreenSharing ? 'btn-primary active' : 'btn-secondary'}`} onClick={toggleScreenSharing}>
                  <Monitor />
                </button>
                <button className={`btn ${showChat ? 'btn-primary active' : 'btn-secondary'}`} onClick={() => setShowChat(!showChat)}>
                  <MessageSquare />
                </button>
                <button className="btn btn-danger" onClick={leaveCall}>
                  <PhoneOff />
                </button>
              </div>

            </div>
            
            {/* Chat Sidebar Overlay for Local Messaging */}
            <AnimatePresence>
              {showChat && (
                <motion.div 
                  initial={{ x: 300, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: 300, opacity: 0 }}
                  className="chat-sidebar glass"
                >
                  <div className="chat-header">
                    <h3>Chat</h3>
                    <button 
                      className="btn-icon" 
                      onClick={() => setShowChat(false)} 
                      style={{width: '36px', height: '36px', borderRadius: '50%'}}
                      title="Close Chat"
                    >
                      <span style={{ fontSize: '20px', lineHeight: '1' }}>×</span>
                    </button>
                  </div>
                  <div className="chat-messages">
                    {messages.map((msg, idx) => {
                      // Just compare sender IDs to determine "me"
                      const isMe = msg.sender === pusherRef.current?.connection?.socket_id;
                      return (
                        <div key={idx} className={`message-bubble ${isMe ? 'me' : 'them'}`}>
                          <div className="sender">{isMe ? 'You' : `User ${msg.sender.slice(0,4)}`}</div>
                          <div className="text">{msg.content}</div>
                          <div className="time">{new Date(msg.timestamp).toLocaleTimeString([], {timeStyle: 'short'})}</div>
                        </div>
                      )
                    })}
                    <div ref={chatEndRef} />
                  </div>
                  <form className="chat-input-area" onSubmit={sendChatMessage}>
                    <input 
                      type="text" 
                      placeholder="Type a message..." 
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                    />
                    <button type="submit" className="btn btn-primary" style={{width: 'auto', padding: '0 16px', height: '100%', borderRadius: '12px'}}>
                      Send
                    </button>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {showQR && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="modal-overlay"
                  onClick={() => setShowQR(false)}
                >
                  <motion.div 
                    initial={{ scale: 0.9, y: 20 }}
                    animate={{ scale: 1, y: 0 }}
                    exit={{ scale: 0.9, y: 20 }}
                    className="modal-content glass"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="modal-header">
                      <h3>Share Meeting</h3>
                      <p>Invite others to join this secure room</p>
                    </div>

                    <div className="qr-wrapper glass" style={{ margin: '2rem auto' }}>
                      <QRCode 
                        value={`${window.location.origin}${window.location.pathname}?room=${saltedRoomId || roomId}`} 
                        size={200}
                        bgColor="#ffffff"
                        fgColor="#0f172a"
                      />
                    </div>

                    <div className="modal-actions">
                      <button className="btn btn-secondary" onClick={handleCopyLink}>
                        {copied ? (
                          <><Check size={18} color="#10b981" /> Copied!</>
                        ) : (
                          <><Copy size={18} /> Copy Link</>
                        )}
                      </button>
                      <button className="btn btn-danger" onClick={() => setShowQR(false)}>
                        Close
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const VideoPlayer = ({ stream, muted = false }) => {
  const videoRef = useRef();
  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);
  return <video ref={videoRef} autoPlay playsInline muted={muted} />;
};

export default App;
