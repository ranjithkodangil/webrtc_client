# WebRTC Serverless Signaling Architecture

This repository contains a full-stack WebRTC application featuring a React client and a NodeJS/Express signaling server that has been optimized for serverless/stateless deployment using [Pusher](https://pusher.com/).

## Architecture Overview

Traditional WebRTC signaling relies on stateful WebSocket servers (like Socket.io). This architecture uses **Pusher** to handle the persistent WebSocket connections externally, allowing the backend Signaling Server to remain completely stateless.

```mermaid
graph TD
    Client1[Client A <br>React WebRTC]
    Client2[Client B <br>React WebRTC]
    
    Server[Signaling Server <br>Node.js & Express]
    Pusher[Pusher Channels <br>WebSockets/PubSub]
    STUN[STUN Server <br>Google Public STUN]
    
    Client1 <-->|1. Auth & HTTP POST<br>Send Signal| Server
    Server -->|2. Trigger Events API| Pusher
    Pusher -->|3. Deliver Event via WSS| Client2
    
    Client1 <-->|Discover Public IP/Port| STUN
    Client2 <-->|Discover Public IP/Port| STUN
    
    Client1 <=====>|4. Direct P2P Media Stream <br> Video & Audio| Client2
    
    classDef client fill:#3b82f6,stroke:#1d4ed8,stroke-width:2px,color:#fff;
    classDef server fill:#10b981,stroke:#047857,stroke-width:2px,color:#fff;
    classDef ext fill:#8b5cf6,stroke:#6d28d9,stroke-width:2px,color:#fff;
    classDef stun fill:#f59e0b,stroke:#b45309,stroke-width:2px,color:#fff;
    
    class Client1,Client2 client;
    class Server server;
    class Pusher ext;
    class STUN stun;
```

## Signaling Flow

1. **Authentication & Discovery**
    - A client connects to the web app and joins a room.
    - It authenticates via the Signaling Server (`/api/pusher/auth`) and connects to a Pusher `presence` channel.
    - Other users in the room are discovered automatically via Pusher presence events.

2. **WebRTC SignalingExchange**
    - When a new participant joins, existing participants generate a WebRTC Offer.
    - They send this Offer using a simple `HTTP POST` to the Signaling Server (`/api/signal`).
    - The server triggers a Pusher event directed at the target user's private channel.
    - The target user receives the Offer, generates an Answer, and sends it back via the same route.
    - ICE candidates are discovered via Google's STUN server and exchanged through the exact same HTTP -> Pusher pipeline.

3. **Peer-to-Peer Connection**
    - Once the SDP (Session Description Protocol) Offers/Answers and ICE candidates are successfully exchanged, a direct Peer-to-Peer (P2P) WebRTC connection is established.
    - Audio and Video streams flow directly between clients without touching the server.

## Project Structure

- `/webrtc_client` - The frontend application (React, Vite, Pusher-JS)
- `/webrtc_server` - The stateless signaling backend (Node.js, Express, Pusher Server SDK)
