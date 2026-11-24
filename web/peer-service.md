# Browser peer service

`dist/peer.js` exports `createPeerService(options)`. PeerJS is imported lazily when connecting from the locally bundled `dist/vendor/peerjs.js`, using PeerJS's public broker and default WebRTC ICE settings. No external JavaScript CDN fetch is needed. There is no recording, server chat history, hosted contact account, TURN server, or push notification. Some NAT/firewall combinations require a production TURN relay. Keep both browser pages open. A stable device ID must be different on each device/tab; duplicate IDs produce an explicit error.

The checked-in browser ESM bundle pins official `peerjs@1.5.5` and bundles its dependencies with `esbuild@0.25.12`. To regenerate it, run `npm ci --ignore-scripts --no-audit --no-fund` then `npm run vendor:peer` from this project. `scripts/vendor-peer.mjs` uses `platform:browser`, ESM output, and ES2020 target; the license is copied to `dist/vendor/peerjs.LICENSE.txt`. Package installation is build-time only; the static deployment serves the already-built file.

## Methods

- `await connect({id, name, language})`: ID matches `[A-Za-z0-9_-]{4,80}`, recommended stable `yueliao-...`; language is `zh` or `vi`.
- `await addFriend(peerId)`: connects the data channel and exchanges device-local profiles; resolves `{id,name,language,online:true}`. The remote page automatically receives the contact callback. This is a prototype connection flow, not a moderated friend-request inbox.
- `await send(peerId, payload)`: sends an object up to 900,000 JSON characters with PeerJS binary chunking. Resolves when written to the data channel; it is not an application-level delivery/read receipt. Receiver gets `{peerId,payload}`. The UI must render data as text and validate application message fields.
- `await call(peerId,'audio'|'video')`: explicitly requests microphone (and optionally camera) permission, then rings the peer. Returns the PeerJS MediaConnection.
- `await answer(call)`: explicitly requests media permission and answers the received MediaConnection. Accepts either `event.call` or the incoming event object.
- `hangup()`, `setMuted(boolean)`, `setCamera(boolean)`, `disconnect()`, and getter `localStream`.

All media tracks stop on hangup, refusal via `hangup()`, denied permission, call errors, disconnect, or timeout. Neither incoming notifications nor starting the app request microphone/camera access. Incoming/outgoing unanswered calls time out after 45 seconds. Friend connection and initial service connection each time out after 15 seconds.

## Callbacks

- `onStatus({state,message,peerId?})`: states `connecting`, `ready`, `error`, `disconnected`, `requesting-media`, `calling`, `incoming`, `in-call`; message is suitable Chinese text. Callback errors should not throw.
- `onContact({id,name,language,online})`: handshake completed or connected contact went offline.
- `onMessage({peerId,payload})`: arbitrary application payload from a contact who completed handshake.
- `onIncomingCall({peerId,kind,call})`: show an accept/decline UI. It does not answer automatically. Caller display name is untrusted metadata; use a stored contact label.
- `onCallStream({peerId,kind,localStream,remoteStream})`: initially remote stream is null. Attach streams to video/audio `srcObject`; mute local preview. Remote stream callback indicates the connection completed.
- `onCallEnd({peerId,reason})`: `ended`, `remote-ended`, `timeout`, `error`, `permission-error`, or `disconnected`.

An optional `loadPeer` function can inject a PeerJS-compatible constructor for tests. Browser callers can omit it. UI should call `disconnect()` on page teardown and avoid showing public-broker connectivity as a guaranteed ability to place a NAT-traversed call.

Metered TURN: set `METERED_DOMAIN` and secret `METERED_TURN_API_KEY` in hosted runtime configuration. `/api/turn` requires a registered device token, checks that its hash belongs to a registered mailbox user, and applies a D1-backed limit of 20 requests per device per minute before fetching ICE credentials. PeerJS and group calls send the device token from local storage. Without TURN variables, existing direct connections remain available. Partial or failing configuration reports an error rather than silently disabling TURN. Issued TURN credentials can still be copied by an authenticated user; configure provider-side quota and expiry in Metered.

Alternatively configure secret `METERED_TURN_USERNAME` and `METERED_TURN_PASSWORD` for global Metered UDP, TCP and TLS relays. These take precedence over API retrieval. Credentials are delivered at runtime to registered browsers for WebRTC, never embedded in source.

The optional mailbox layer in `dist/mailbox.js` stores pending messages in server D1. Peer hello exchanges only cloud addresses; it never shares the private device token. Offline-capable contacts must establish a mutual connection once on the new version.
