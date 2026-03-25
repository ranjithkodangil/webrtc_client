import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import { Camera, CameraOff, Mic, MicOff, PhoneOff, Video } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const SIGNAL_SERVER = 'http://webrtc-server-liard.vercel.app';

const App = () => {
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [stream, setStream] = useState(null);
  const [peers, setPeers] = useState({});
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);

  const socketRef = useRef();
  const userVideoRef = useRef();
  const streamRef = useRef();
  const peersRef = useRef({}); // { socketId: RTCPeerConnection }


  useEffect(() => {
    socketRef.current = io(SIGNAL_SERVER);

    socketRef.current.on('user-joined', async (userId) => {
      console.log('User joined:', userId);
      const pc = createPeerConnection(userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current.emit('offer', { target: userId, offer });
    });

    socketRef.current.on('offer', async ({ from, offer }) => {
      console.log('Received offer from:', from);
      const pc = createPeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current.emit('answer', { target: from, answer });
    });

    socketRef.current.on('answer', async ({ from, answer }) => {
      console.log('Received answer from:', from);
      const pc = peersRef.current[from];
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socketRef.current.on('ice-candidate', async ({ from, candidate }) => {
      console.log('Received candidate from:', from);
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
        socketRef.current.emit('ice-candidate', { target: userId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      console.log('Received track for:', userId);
      setPeers(prev => ({
        ...prev,
        [userId]: event.streams[0]
      }));
    };

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => pc.addTrack(track, streamRef.current));
    }

    peersRef.current[userId] = pc;
    return pc;
  };

  const joinRoom = async () => {
    if (!roomId) return;
    try {
      const userStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStream(userStream);
      streamRef.current = userStream;
      socketRef.current.emit('join-room', roomId);
      setJoined(true);
    } catch (err) {
      console.error('Error accessing media:', err);
      alert('Could not access camera/microphone');
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
              <span className="status-badge">WebRTC Video</span>
              <h1>Meet</h1>
              <p>Join a room to start talking</p>
            </div>
            <input 
              type="text" 
              placeholder="Enter Room ID (e.g. project-x)" 
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={joinRoom}>
              Join Room
            </button>
          </motion.div>
        ) : (
          <motion.div 
            key="call"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="call-screen"
          >
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
