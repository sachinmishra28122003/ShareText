# AirText.io — Instant P2P Text and File Sync

AirText.io is a lightweight, zero-server workspace designed to mirror prompts, text snippets, and files instantly between your laptop and mobile device. Hosted completely free on GitHub Pages, it requires no account creation, no database, and no server configuration.

---

## How to Use

### 1. Initial Pairing
1. **Open AirText on your Laptop:** Visit your hosted GitHub Pages URL (e.g., `https://<username>.github.io/airtext`).
   * The app will automatically generate an unguessable private room hash (e.g., `#sync-4k2a-9x1b`).
2. **Connect your Phone:**
   * Click the QR code icon in the top navigation bar.
   * Scan the QR code using your phone's camera.
   * Alternatively, copy the room URL via the link icon and paste it into your mobile browser.
3. **Check Connection:** The top status indicator will switch from amber (Standby) to green (Direct P2P Synced), displaying the name of the linked device.

### 2. Daily Workflow
* **Instant Text Sync:** Start typing or pasting your prompt in the editor on your laptop. As you type, the mobile screen mirrors the text with a live arrival pulse.
* **One-Tap Copy:** Tap the "Copy Prompt" button on mobile to copy the mirrored text directly to your clipboard for quick pasting into personal apps or AI assistants.
* **Send Files:** Click the "Attach" button to transfer code files, logs, screenshots, or documents directly to your connected device.
* **Theme Switching:** Tap the moon/sun icon in the navigation bar to toggle between dark and light modes.
* **Bookmark Once:** Bookmark the full room URL (including the `#hash`) on both devices so you never have to pair via QR code again.

---

## How It Is Built

AirText is built as a serverless, static web application utilizing the following technologies:

### 1. Peer-to-Peer Networking (WebRTC and PeerJS)
* **Zero Backend Infrastructure:** Instead of storing keystrokes in a central database or routing files through a paid cloud server, AirText uses the browser's native WebRTC RTCDataChannel.
* **Public Signaling:** PeerJS provides the lightweight initial handshake over free public broker servers to exchange ICE candidates. Once the connection handshake finishes, all data flows strictly point-to-point between your laptop and phone.

### 2. Deterministic Room Routing and Identity
* **Cryptographic Isolation:** Each room derives its unique identifier from the URL hash (`window.location.hash`). High entropy prevents session collisions.
* **Host/Client State Machine:** 
  * The first device to open the URL claims the room host ID (`airtext-h-<roomKey>`).
  * The second device automatically falls back to client mode (`airtext-c-<roomKey>`) upon detecting an occupied host slot and establishes the WebRTC link.
* **Device Handshake:** Both browsers exchange platform user-agent signatures on open to display verified peer metadata (e.g., "Linked: Desktop / Laptop").

### 3. State and Performance Optimizations
* **Debounced Event Streaming:** Text input listeners utilize a debounce timer (~100 ms) before transmitting change vectors, preventing data-channel congestion during rapid typing.
* **Offline-Ready Local Cache:** Text is synced locally to `localStorage` against the specific room hash, persisting drafts even if the tab is accidentally refreshed or closed.
* **In-Memory File Streaming:** Files are read using the FileReader API as binary Data URLs and relayed directly through the active data channel to avoid disk persistence.

---

## Project Structure
