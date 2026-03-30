import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { Camera, CameraOff, Mic, MicOff, PhoneOff, Video, Share2, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const SIGNAL_SERVER = 'https://webrtc-server-liard.vercel.app';
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

  const socketRef = useRef();
  const userVideoRef = useRef();
  const streamRef = useRef();
  const peersRef = useRef({}); // { socketId: RTCPeerConnection }


  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const room = urlParams.get('room');
    if (room) {
      setRoomId(room);
      setIsInvited(true);
    }

    socketRef.current = io(SIGNAL_SERVER, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5
    });

    socketRef.current.on('connect', () => {
      console.log('✅ Socket connected:', socketRef.current.id);
      setConnectionStatus('Online');
      setError('');
    });

    socketRef.current.on('connect_error', (err) => {
      console.error('❌ Socket connection error:', err);
      setConnectionStatus('Error');
      setError(`Signal server unreachable. Please try again later.`);
    });

    socketRef.current.on('disconnect', (reason) => {
      console.log('ℹ️ Socket disconnected:', reason);
      setConnectionStatus('Offline');
    });

    socketRef.current.on('room-full', () => {
      console.warn('⚠️ Room is full');
      setConnectionStatus('Room Full');
      setError('This room is full (max 4 participants).');
      setJoined(false);
      // Clean up local stream if it was started
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        setStream(null);
      }
    });

    socketRef.current.on('error', (msg) => {
      setError(msg);
    });

    socketRef.current.on('user-joined', async (userId) => {
      if (Object.keys(peersRef.current).length >= MAX_PARTICIPANTS - 1) {
        console.warn('Room full: Skipping connection with user', userId);
        return;
      }
      console.log('User joined:', userId);
      const pc = createPeerConnection(userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current.emit('offer', { target: userId, offer });
    });

    socketRef.current.on('offer', async ({ from, offer }) => {
      console.log('📩 Received offer from:', from);
      if (Object.keys(peersRef.current).length >= MAX_PARTICIPANTS - 1) {
        console.warn('🚫 Room full: Ignoring offer from', from);
        return;
      }
      const pc = createPeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('📤 Sending answer to:', from);
      socketRef.current.emit('answer', { target: from, answer });
    });

    socketRef.current.on('answer', async ({ from, answer }) => {
      console.log('📩 Received answer from:', from);
      const pc = peersRef.current[from];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('✅ Remote description set for:', from);
      }
    });

    socketRef.current.on('ice-candidate', async ({ from, candidate }) => {
      console.log('🧊 Received ICE candidate from:', from);
      const pc = peersRef.current[from];
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socketRef.current.on('user-left', (userId) => {
      console.log('User left:', userId);
      if (peersRef.current[userId]) {
        peersRef.current[userId].close();
        delete peersRef.current[userId];
      }
      setPeers(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    });

    return () => {
      socketRef.current.disconnect();
    };
  }, []);

  const createPeerConnection = (userId) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('📤 Sending ICE candidate to:', userId);
        socketRef.current.emit('ice-candidate', { target: userId, candidate: event.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`❄️ ICE ${userId}:`, pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log(`🔗 Connection ${userId}:`, pc.connectionState);
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

  const joinRoom = async () => {
    const trimmedId = roomId.trim();
    if (!trimmedId) return;
    
    setError(''); // Clear any previous errors
    console.log('Attempting to join room:', trimmedId);
    try {
      const userStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStream(userStream);
      streamRef.current = userStream;
      socketRef.current.emit('join-room', trimmedId);
      setJoined(true);
    } catch (err) {
      console.error('Error accessing media:', err);
      alert('Could not access camera/microphone. Please ensure permissions are granted.');
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

  const leaveCall = () => {
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
              <>
                <input 
                  type="text" 
                  placeholder="Enter Room ID (e.g. project-x)" 
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                />
                
                {roomId && (
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

                <button className="btn btn-primary" style={{ width: '100%' }} onClick={joinRoom}>
                  Join Room
                </button>
              </>
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
