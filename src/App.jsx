import React, { useState, useEffect, useRef } from 'react';
import Pusher from 'pusher-js';
import { Camera, CameraOff, Mic, MicOff, PhoneOff, Video, Share2, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const SIGNAL_SERVER = '';
const PUSHER_KEY = import.meta.env.VITE_PUSHER_KEY || 'your-pusher-key';
const PUSHER_CLUSTER = import.meta.env.VITE_PUSHER_CLUSTER || 'mt1';
const MAX_PARTICIPANTS = 4;

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
  const [isCreating, setIsCreating] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(60);

  const pusherRef = useRef();
  const channelRef = useRef();
  const pinRef = useRef('');
  const privateChannelRef = useRef();
  const streamRef = useRef();
  const peersRef = useRef({}); // { userId: RTCPeerConnection }

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const room = urlParams.get('room');
    if (room) {
      setRoomId(room);
      setIsInvited(true);
    }

    // Initialize Pusher
    pusherRef.current = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      authEndpoint: `${SIGNAL_SERVER}/api/pusher/auth`,
      auth: {
        paramsProvider: () => ({
          pin: pinRef.current
        })
      }
    });

    pusherRef.current.connection.bind('connected', () => {
      console.log('✅ Pusher connected:', pusherRef.current.connection.socket_id);
      setConnectionStatus('Online');
      setError('');
    });

    pusherRef.current.connection.bind('error', (err) => {
      console.error('❌ Pusher connection error:', err);
      setConnectionStatus('Error');
      setError('Signal server unreachable. Please check Pusher credentials.');
    });

    return () => {
      if (pusherRef.current) {
        pusherRef.current.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    pinRef.current = pin;
  }, [pin]);

  // Solitude Timer: Kick user if alone for > 60s
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

  const iceQueueRef = useRef({}); // { userId: [RTCIceCandidate] }

  const createPeerConnection = (userId) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    iceQueueRef.current[userId] = [];

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('📤 Sending ICE candidate to:', userId);
        sendSignal(userId, 'ice-candidate', event.candidate);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`❄️ ICE ${userId}:`, pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log(`🔗 Connection ${userId}:`, pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        cleanupPeer(userId);
      }
    };

    pc.ontrack = (event) => {
      console.log('📺 Received track for:', userId, event.streams[0]);
      setPeers(prev => ({
        ...prev,
        [userId]: event.streams[0]
      }));
    };

    if (streamRef.current) {
      console.log('📤 Adding local tracks to PC for:', userId);
      streamRef.current.getTracks().forEach(track => pc.addTrack(track, streamRef.current));
    }

    peersRef.current[userId] = pc;
    return pc;
  };

  const processIceQueue = (userId) => {
    const pc = peersRef.current[userId];
    const queue = iceQueueRef.current[userId];
    if (pc && pc.remoteDescription && queue) {
      console.log(`🧊 Processing ${queue.length} queued ICE candidates for ${userId}`);
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
    delete iceQueueRef.current[userId];
    setPeers(prev => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const joinRoom = async () => {
    const trimmedId = roomId.trim();
    if (!trimmedId) return;
    
    setError('');
    console.log('Attempting to join room:', trimmedId);
    try {
      const userStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStream(userStream);
      streamRef.current = userStream;

      const selfId = pusherRef.current.connection.socket_id;

      // 1. Subscribe to Presence Channel (for discovery)
      channelRef.current = pusherRef.current.subscribe(`presence-room-${trimmedId}`);

      channelRef.current.bind('pusher:subscription_succeeded', (members) => {
        console.log('✅ Joined room as:', selfId);
        setJoined(true);

        // 3. Initiate connections to everyone already in the room
        members.each((member) => {
          if (member.id !== selfId) {
            console.log('👤 Existing user found:', member.id);
            const pc = createPeerConnection(member.id);
            pc.createOffer().then(async (offer) => {
              await pc.setLocalDescription(offer);
              sendSignal(member.id, 'offer', offer);
            });
          }
        });
      });

      channelRef.current.bind('pusher:member_added', async (member) => {
        console.log('👤 New user joined:', member.id);
      });

      channelRef.current.bind('pusher:member_removed', (member) => {
        console.log('👤 User left:', member.id);
        cleanupPeer(member.id);
      });

      // 2. Subscribe to Private Channel (for incoming signals)
      privateChannelRef.current = pusherRef.current.subscribe(`private-user-${selfId}`);

      privateChannelRef.current.bind('offer', async ({ from, signal: offer }) => {
        console.log('📩 Received offer from:', from);
        const pc = createPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(from, 'answer', answer);
        processIceQueue(from);
      });

      privateChannelRef.current.bind('answer', async ({ from, signal: answer }) => {
        console.log('📩 Received answer from:', from);
        const pc = peersRef.current[from];
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          processIceQueue(from);
        }
      });

      privateChannelRef.current.bind('ice-candidate', async ({ from, signal: candidate }) => {
        console.log('🧊 Received ICE candidate from:', from);
        const pc = peersRef.current[from];
        if (pc && pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          console.log('⏳ Remote description not set, queueing ICE candidate');
          if (!iceQueueRef.current[from]) iceQueueRef.current[from] = [];
          iceQueueRef.current[from].push(candidate);
        }
      });

    } catch (err) {
      console.error('Error accessing media/joining:', err);
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

  const leaveCall = (reason) => {
    if (reason) alert(reason);
    window.location.reload();
  };

  const handleCopyLink = () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
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
              <p>{isInvited ? 'You have been invited' : 'Join a room to start talking'}</p>
            </div>

            {error && (
              <div className="error-alert">
                {error}
              </div>
            )}

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
                  Enter a different room ID
                </button>
              </div>
            ) : (
              <div className="join-form">
                <div className="mode-toggle glass">
                  <button 
                    className={!isCreating ? 'active' : ''} 
                    onClick={() => setIsCreating(false)}
                  >
                    Join Existing
                  </button>
                  <button 
                    className={isCreating ? 'active' : ''} 
                    onClick={() => setIsCreating(true)}
                  >
                    Create New
                  </button>
                </div>

                <input 
                  type="text" 
                  placeholder="Enter Room ID (e.g. project-x)" 
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                />

                {isCreating && (
                  <motion.input 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    type="password" 
                    placeholder="Enter Secret PIN to Create" 
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    style={{ marginTop: '1rem' }}
                  />
                )}
                
                {roomId && !isCreating && (
                  <div className="share-link-container">
                    <p>Share this link with others:</p>
                    <div className="share-input-group">
                      <input readOnly value={`${window.location.origin}${window.location.pathname}?room=${roomId}`} />
                      <button className="btn-icon" onClick={handleCopyLink}>
                        {copied ? <Check size={18} color="#10b981" /> : <Copy size={18} />}
                      </button>
                    </div>
                  </div>
                )}

                <button 
                  className="btn btn-primary" 
                  style={{ width: '100%', marginTop: '1rem' }} 
                  onClick={joinRoom}
                  disabled={isCreating && !pin}
                >
                  {isCreating ? 'Create & Join' : 'Join Room'}
                </button>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div 
            key="call"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="call-screen"
          >
            <div className="room-info-badge glass" onClick={handleCopyLink}>
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
              {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
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
              <button className={`btn ${isVideoOff ? 'btn-danger' : 'btn-secondary'}`} onClick={toggleVideo}>
                {isVideoOff ? <CameraOff /> : <Camera />}
              </button>
              <button className="btn btn-danger" onClick={leaveCall}>
                <PhoneOff />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const VideoPlayer = ({ stream, muted = false }) => {
  const videoRef = useRef();

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return <video ref={videoRef} autoPlay playsInline muted={muted} />;
};

export default App;
