import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || window.location.origin;
const SOCKET_PATH = import.meta.env.VITE_SOCKET_PATH || "/socket.io";
//const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const DEFAULT_ICE_SERVERS = [
  {
    urls: "stun:stun.l.google.com:19302",
  },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];
const ICE_SERVERS = (() => {
  try {
    const raw = import.meta.env.VITE_ICE_SERVERS;
    if (!raw) {
      return DEFAULT_ICE_SERVERS;
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0
      ? parsed
      : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
})();
const SESSION_KEY = "chatapp_session";
const IS_LOCALHOST_HOST = ["localhost", "127.0.0.1"].includes(
  window.location.hostname,
);
const IS_INSECURE_MOBILE_CONTEXT =
  !window.isSecureContext && !IS_LOCALHOST_HOST;

const socket = io(SOCKET_URL, {
  autoConnect: false,
  path: SOCKET_PATH,
  transports: ["websocket", "polling"],
});

function App() {
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("general");
  const [joined, setJoined] = useState(false);

  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [typingUser, setTypingUser] = useState("");

  const [callStatus, setCallStatus] = useState("idle");
  const [callType, setCallType] = useState("video");

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const incomingOfferRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);

  const addOrQueueIceCandidate = async (candidate) => {
    const pc = peerConnectionRef.current;
    if (!pc || !candidate) {
      return;
    }

    if (pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error("Failed to add ICE candidate", error);
      }
      return;
    }

    pendingIceCandidatesRef.current.push(candidate);
  };

  const flushPendingIceCandidates = async () => {
    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      return;
    }

    const pending = [...pendingIceCandidatesRef.current];
    pendingIceCandidatesRef.current = [];

    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error("Failed to add queued ICE candidate", error);
      }
    }
  };

  const attachRemoteStream = async (stream) => {
    const video = remoteVideoRef.current;
    if (!video || !stream) return;

    // Agar wahi stream pehle se lagi hai to dobara mat lagao
    if (video.srcObject === stream) return;

    video.srcObject = stream;

    try {
      await video.play();
    } catch (e) {
      console.error(e);
    }
  };

  const getMediaErrorMessage = (error, mode) => {
    if (IS_INSECURE_MOBILE_CONTEXT) {
      return "Video/audio calls need HTTPS on mobile. Open the app with an HTTPS URL.";
    }

    if (error?.name === "NotAllowedError") {
      return "Camera or microphone permission was denied.";
    }

    if (error?.name === "NotFoundError") {
      return mode === "video"
        ? "No camera/microphone found on this device."
        : "No microphone found on this device.";
    }

    if (error?.name === "NotReadableError") {
      return "Camera or microphone is already in use by another app.";
    }

    return `Failed to start ${mode} call`;
  };

  const requestLocalMedia = async (mode) => {
    if (IS_INSECURE_MOBILE_CONTEXT) {
      throw new Error(
        "Calls require a secure context. Use HTTPS when opening the app on mobile.",
      );
    }

    const primaryConstraints = {
      audio: true,
      video:
        mode === "video"
          ? {
              facingMode: "user",
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
    };

    try {
      console.log("Requesting media...");
      const stream =
        await navigator.mediaDevices.getUserMedia(primaryConstraints);
      console.log("Media granted:", stream);
      return stream;
    } catch (error) {
      console.error("getUserMedia Error:", error);
      if (mode !== "video") {
        throw error;
      }

      // Retry with simpler constraints for devices that reject advanced video hints.
      return navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    }
  };

  useEffect(() => {
    const savedSession =
      sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!savedSession) {
      return;
    }

    try {
      const parsed = JSON.parse(savedSession);
      const savedUsername = (parsed?.username || "").trim();
      const savedRoomId = (parsed?.roomId || "").trim();

      if (!savedUsername || !savedRoomId) {
        return;
      }

      // Migrate older shared localStorage session to per-tab sessionStorage.
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ username: savedUsername, roomId: savedRoomId }),
      );
      localStorage.removeItem(SESSION_KEY);

      setUsername(savedUsername);
      setRoomId(savedRoomId);

      if (!socket.connected) {
        socket.connect();
      }

      socket.emit("join_room", {
        username: savedUsername,
        roomId: savedRoomId,
      });

      setJoined(true);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    socket.on("room_users", (roomUsers) => {
      setUsers(roomUsers);
      setSelectedUserId((current) => {
        if (
          current &&
          roomUsers.some((u) => u.id === current && u.id !== socket.id)
        ) {
          return current;
        }
        const firstOtherUser = roomUsers.find((u) => u.id !== socket.id);
        return firstOtherUser?.id || "";
      });
    });

    socket.on("receive_message", (payload) => {
      setMessages((prev) => [...prev, payload]);
    });

    socket.on("typing", ({ username: typingName, isTyping }) => {
      setTypingUser(isTyping ? typingName : "");
    });

    socket.on("call_offer", async ({ fromId, fromName, offer, mode }) => {
      incomingOfferRef.current = { fromId, offer, mode };
      setCallType(mode);
      setSelectedUserId(fromId);
      setCallStatus(`Incoming ${mode} call from ${fromName}`);

      const accept = window.confirm(
        `Incoming ${mode} call from ${fromName}. Accept?`,
      );
      if (!accept) {
        socket.emit("call_rejected", { targetId: fromId });
        setCallStatus("idle");
        return;
      }

      await acceptCall(fromId, offer, mode);
    });

    socket.on("call_answer", async ({ answer }) => {
      const pc = peerConnectionRef.current;
      if (!pc) {
        return;
      }
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingIceCandidates();
      setCallStatus(`In ${callType} call`);
    });

    socket.on("ice_candidate", async ({ candidate }) => {
      await addOrQueueIceCandidate(candidate);
    });

    socket.on("call_rejected", () => {
      setCallStatus("Call rejected");
      endCall();
    });

    socket.on("call_ended", () => {
      setCallStatus("Call ended");
      cleanupMedia();
      cleanupPeer();
    });

    return () => {
      socket.off("room_users");
      socket.off("receive_message");
      socket.off("typing");
      socket.off("call_offer");
      socket.off("call_answer");
      socket.off("ice_candidate");
      socket.off("call_rejected");
      socket.off("call_ended");
    };
  }, [callType]);

  const joinRoom = () => {
    const trimmedUsername = username.trim();
    const trimmedRoomId = roomId.trim();

    if (!trimmedUsername || !trimmedRoomId) {
      return;
    }

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit("join_room", {
      username: trimmedUsername,
      roomId: trimmedRoomId,
    });

    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ username: trimmedUsername, roomId: trimmedRoomId }),
    );
    localStorage.removeItem(SESSION_KEY);

    setJoined(true);
    setMessages([]);
    setCallStatus("idle");
  };

  const sendMessage = () => {
    if (!message.trim()) {
      return;
    }

    socket.emit("send_message", { roomId, message: message.trim() });
    setMessage("");
    socket.emit("typing", { roomId, isTyping: false });
  };

  const setupPeerConnection = (targetId) => {
    cleanupPeer();
    pendingIceCandidatesRef.current = [];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      console.log("ICE Candidate:", event.candidate);

      if (event.candidate) {
        socket.emit("ice_candidate", {
          targetId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      console.log("Track:", event.track.kind);

      const stream = event.streams[0];

      if (event.track.kind === "video") {
        attachRemoteStream(stream);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE State:", pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection State:", pc.connectionState);
    };

    peerConnectionRef.current = pc;
    return pc;
  };
  const startCall = async (mode) => {
    if (!selectedUserId || selectedUserId === socket.id) {
      alert("Select a user to call.");
      return;
    }

    try {
      setCallType(mode);
      setCallStatus(`Calling (${mode})...`);

      const localStream = await requestLocalMedia(mode);
      localStreamRef.current = localStream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }

      const pc = setupPeerConnection(selectedUserId);
      localStream
        .getTracks()
        .forEach((track) => pc.addTrack(track, localStream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit("call_offer", {
        targetId: selectedUserId,
        offer,
        mode,
      });
    } catch (error) {
      setCallStatus(getMediaErrorMessage(error, mode));
      cleanupMedia();
      cleanupPeer();
      console.error(error);
    }
  };

  const acceptCall = async (fromId, offer, mode) => {
    try {
      setCallType(mode);
      const localStream = await requestLocalMedia(mode);
      localStreamRef.current = localStream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }

      const pc = setupPeerConnection(fromId);
      localStream
        .getTracks()
        .forEach((track) => pc.addTrack(track, localStream));

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingIceCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("call_answer", {
        targetId: fromId,
        answer,
      });

      setCallStatus(`In ${mode} call`);
    } catch (error) {
      setCallStatus(getMediaErrorMessage(error, mode));
      socket.emit("call_rejected", { targetId: fromId });
      cleanupMedia();
      cleanupPeer();
      console.error(error);
    }
  };

  const cleanupMedia = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const cleanupPeer = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    pendingIceCandidatesRef.current = [];
  };

  const endCall = () => {
    if (selectedUserId) {
      socket.emit("call_end", { targetId: selectedUserId });
    }
    cleanupMedia();
    cleanupPeer();
    setCallStatus("idle");
  };

  const logout = () => {
    endCall();

    if (socket.connected) {
      socket.disconnect();
    }

    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);

    setJoined(false);
    setUsers([]);
    setSelectedUserId("");
    setMessages([]);
    setTypingUser("");
    setMessage("");
    setCallStatus("idle");
    setCallType("video");
    setUsername("");
    setRoomId("general");
  };

  if (!joined) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Chat App</h1>
          <p>Text chat + audio/video calls</p>
          {IS_INSECURE_MOBILE_CONTEXT && (
            <p className="warning-text">
              Mobile calls require HTTPS. Open this app over HTTPS to use
              audio/video calls.
            </p>
          )}
          <input
            placeholder="Your name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            placeholder="Room (e.g. general)"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <button onClick={joinRoom}>Join</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Room: {roomId}</h2>
        <p>Logged in as {username}</p>
        <button className="logout-btn" onClick={logout}>
          Logout
        </button>
        <h3>Users</h3>
        <ul>
          {users.map((u) => (
            <li key={u.id}>
              <button
                className={selectedUserId === u.id ? "selected" : ""}
                onClick={() => setSelectedUserId(u.id)}
                disabled={u.id === socket.id}
              >
                {u.username} {u.id === socket.id ? "(You)" : ""}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="chat-panel">
        <div className="messages">
          {messages.map((msg) => (
            <div key={msg.id} className="message-item">
              <strong>{msg.username}</strong>
              <span>{new Date(msg.createdAt).toLocaleTimeString()}</span>
              <p>{msg.message}</p>
            </div>
          ))}
        </div>

        <div className="composer">
          <input
            value={message}
            placeholder="Type a message"
            onChange={(e) => {
              setMessage(e.target.value);
              socket.emit("typing", {
                roomId,
                isTyping: e.target.value.length > 0,
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                sendMessage();
              }
            }}
          />
          <button onClick={sendMessage}>Send</button>
        </div>

        <p className="typing">{typingUser && `${typingUser} is typing...`}</p>
      </main>

      <section className="call-panel">
        <h3>Calls</h3>
        <p>Status: {callStatus}</p>
        {IS_INSECURE_MOBILE_CONTEXT && (
          <p className="warning-text">
            Call media is blocked on insecure HTTP mobile pages. Use HTTPS.
          </p>
        )}
        <div className="actions">
          <button onClick={() => startCall("audio")}>Audio Call</button>
          <button onClick={() => startCall("video")}>Video Call</button>
          <button onClick={endCall}>End Call</button>
        </div>

        <div className="videos">
          <div>
            <p>Local</p>
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className={callType === "audio" ? "audio-only" : ""}
            />
          </div>
          <div>
            <p>Remote</p>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              onClick={() => {
                if (remoteVideoRef.current?.muted) {
                  remoteVideoRef.current.muted = false;
                  remoteVideoRef.current.play().catch(() => {});
                }
              }}
              className={callType === "audio" ? "audio-only" : ""}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
