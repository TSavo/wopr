# WOPR Protocol Specification

**Without Official Permission Required**

**Version:** 2
**Min Compatible Version:** 1

## Overview

WOPR uses JSON messages over Hyperswarm connections. All messages are signed and most are encrypted.

## Transport

- **Network:** Hyperswarm (DHT + NAT traversal)
- **Topic:** SHA256(publicKey) for direct connections
- **Encoding:** JSON over raw TCP streams
- **Framing:** Newline-delimited JSON (one message per line)

## Message Types

### P2P Messages

Used for direct peer communication (injections, claims, key rotation).

```typescript
interface P2PMessage {
  v: number;              // Protocol version (1 or 2)
  type: P2PMessageType;   // Message type
  from: string;           // Sender's Ed25519 pubkey (base64)
  encryptPub?: string;    // Sender's X25519 pubkey (base64)
  ephemeralPub?: string;  // Ephemeral X25519 for PFS (v2)
  session?: string;       // Target session name
  payload?: string;       // Encrypted message content
  token?: string;         // Invite token (for claims)
  reason?: string;        // Rejection reason
  versions?: number[];    // Supported versions (hello)
  version?: number;       // Negotiated version (hello-ack)
  keyRotation?: KeyRotationData;
  nonce: string;          // Unique nonce (hex)
  ts: number;             // Unix timestamp (ms)
  sig: string;            // Ed25519 signature (base64)
}

type P2PMessageType =
  | "hello"        // Initiate handshake
  | "hello-ack"    // Respond to handshake
  | "inject"       // Send message to session
  | "claim"        // Claim an invite token
  | "ack"          // Acknowledge success
  | "reject"       // Reject with reason
  | "key-rotation" // Announce key rotation
```

### Discovery Messages

Used for topic-based peer discovery.

```typescript
interface DiscoveryMessage {
  v: 1;
  type: DiscoveryMessageType;
  from: string;           // Sender's pubkey
  encryptPub?: string;    // For encryption
  topic?: string;         // Topic name
  profile?: Profile;      // Sender's profile
  reason?: string;        // Rejection reason
  accepted?: boolean;     // Connection response
  sessions?: string[];    // Granted sessions
  nonce: string;
  ts: number;
  sig: string;
}

type DiscoveryMessageType =
  | "announce"          // Broadcast presence
  | "withdraw"          // Leave topic
  | "profile-request"   // Request profile
  | "profile-response"  // Send profile
  | "connect-request"   // Request trust
  | "connect-response"  // Accept/reject
```

## Handshake Protocol (v2)

### Purpose

1. Negotiate protocol version
2. Exchange ephemeral keys for forward secrecy
3. Establish encrypted session

### Flow

```
Initiator                                    Responder
    │                                            │
    │  Hello                                     │
    │  {                                         │
    │    v: 2,                                   │
    │    type: "hello",                          │
    │    from: <pubkey>,                         │
    │    encryptPub: <x25519_pub>,               │
    │    ephemeralPub: <ephemeral_x25519>,       │
    │    versions: [2, 1],                       │
    │    nonce, ts, sig                          │
    │  }                                         │
    │ ──────────────────────────────────────────>│
    │                                            │
    │                                     HelloAck
    │                                     {
    │                                       v: 2,
    │                                       type: "hello-ack",
    │                                       from: <pubkey>,
    │                                       encryptPub: <x25519_pub>,
    │                                       ephemeralPub: <ephemeral_x25519>,
    │                                       version: 2,  // negotiated
    │                                       nonce, ts, sig
    │                                     }
    │ <──────────────────────────────────────────│
    │                                            │
    │  (derive shared secret from ephemeral keys)│
    │                                            │
    │  Encrypted messages...                     │
    │ <═════════════════════════════════════════>│
```

### Version Negotiation

1. Initiator sends list of supported versions in `versions[]`
2. Responder picks highest version they also support
3. Responder sends chosen version in `version`
4. If no common version, responder sends `reject` with reason "version-mismatch"

### Key Derivation

```
shared_secret = ECDH(my_ephemeral_private, their_ephemeral_public)
session_key = SHA256(shared_secret)
```

## Invite Token Format

```
wop1://<base64url-encoded-json>
```

### Token Structure

```typescript
interface InviteToken {
  v: 1;               // Token version
  iss: string;        // Issuer's Ed25519 pubkey
  sub: string;        // Subject's Ed25519 pubkey (recipient)
  ses: string[];      // Granted sessions ("*" for all)
  cap: string[];      // Capabilities (e.g., ["inject"])
  exp: number;        // Expiration timestamp (ms)
  nonce: string;      // Random nonce
  sig: string;        // Issuer's signature
}
```

### Token Validation

1. Decode base64url JSON
2. Check `exp > now`
3. Verify `sig` against `iss` pubkey
4. During claim: verify claimer owns `sub` pubkey

## Encryption

### Payload Encryption (v2 with PFS)

```
plaintext = JSON.stringify(message_content)
key = SHA256(ECDH(ephemeral_private, their_ephemeral_public))
iv = random(12 bytes)
(ciphertext, authTag) = AES-256-GCM(key, iv, plaintext)
payload = base64(iv || authTag || ciphertext)
```

### Payload Encryption (v1 static keys)

```
plaintext = JSON.stringify(message_content)
key = SHA256(ECDH(my_encrypt_private, their_encrypt_public))
iv = random(12 bytes)
(ciphertext, authTag) = AES-256-GCM(key, iv, plaintext)
payload = base64(iv || authTag || ciphertext)
```

### Payload Format

```
┌────────┬──────────┬────────────────┐
│ IV     │ Auth Tag │ Ciphertext     │
│ 12 B   │ 16 B     │ variable       │
└────────┴──────────┴────────────────┘
```

## Signature

### Signing

```
payload = JSON.stringify(message_without_sig)
signature = Ed25519_Sign(private_key, payload)
message.sig = base64(signature)
```

### Verification

```
{ sig, ...payload } = message
payload_bytes = JSON.stringify(payload)
valid = Ed25519_Verify(signer_pubkey, payload_bytes, base64_decode(sig))
```

## Key Rotation

### Rotation Message

```typescript
interface KeyRotation {
  v: 1;
  type: "key-rotation";
  oldSignPub: string;      // Current pubkey
  newSignPub: string;      // New signing pubkey
  newEncryptPub: string;   // New encryption pubkey
  reason: "scheduled" | "compromise" | "upgrade";
  effectiveAt: number;     // When rotation happened
  gracePeriodMs: number;   // How long old key valid (default: 7 days)
  sig: string;             // Signed with OLD key
}
```

### Verification

The rotation message is signed with the OLD key, proving the owner of the old key authorized the transition.

```
valid = Ed25519_Verify(oldSignPub, rotation_payload, sig)
```

### Grace Period

During the grace period (`effectiveAt` to `effectiveAt + gracePeriodMs`):
- Messages signed with OLD key are accepted
- Messages signed with NEW key are accepted
- Both keys resolve to same identity

## Message Flows

### Inject Flow

```
Sender                                      Receiver
   │                                            │
   │  1. Connect to receiver's topic            │
   │ ──────────────────────────────────────────>│
   │                                            │
   │  2. Handshake (Hello/HelloAck)             │
   │ <═════════════════════════════════════════>│
   │                                            │
   │  3. Inject message                         │
   │  {                                         │
   │    v: 2,                                   │
   │    type: "inject",                         │
   │    from: <pubkey>,                         │
   │    session: "dev",                         │
   │    payload: <encrypted>,                   │
   │    nonce, ts, sig                          │
   │  }                                         │
   │ ──────────────────────────────────────────>│
   │                                            │
   │                                       4. Verify:
   │                                          - Signature valid
   │                                          - Nonce not seen
   │                                          - Timestamp fresh
   │                                          - Sender authorized
   │                                            │
   │  5. Response                               │
   │  { type: "ack" } or { type: "reject" }    │
   │ <──────────────────────────────────────────│
```

### Claim Flow

```
Claimer                                     Issuer
   │                                            │
   │  1. Connect to issuer's topic              │
   │ ──────────────────────────────────────────>│
   │                                            │
   │  2. Handshake                              │
   │ <═════════════════════════════════════════>│
   │                                            │
   │  3. Claim message                          │
   │  {                                         │
   │    v: 2,                                   │
   │    type: "claim",                          │
   │    from: <claimer_pubkey>,                 │
   │    encryptPub: <claimer_x25519>,           │
   │    token: "wop1://...",                    │
   │    nonce, ts, sig                          │
   │  }                                         │
   │ ──────────────────────────────────────────>│
   │                                            │
   │                                       4. Verify:
   │                                          - Token valid
   │                                          - Token.sub == from
   │                                          - Token not expired
   │                                          - Token.iss == self
   │                                            │
   │                                       5. Grant access
   │                                            │
   │  6. Ack with issuer's encrypt key          │
   │  {                                         │
   │    type: "ack",                            │
   │    encryptPub: <issuer_x25519>             │
   │  }                                         │
   │ <──────────────────────────────────────────│
   │                                            │
   │  7. Claimer stores peer                    │
```

## Discovery Flow

### Topic Join

```
Peer A                       DHT                        Peer B
   │                          │                            │
   │  announce(topic_hash)    │                            │
   │ ────────────────────────>│                            │
   │                          │<──── announce(topic_hash) ─│
   │                          │                            │
   │<─── peer_info(B) ────────│                            │
   │                          │──── peer_info(A) ─────────>│
   │                          │                            │
   │  connect                 │                            │
   │ ─────────────────────────────────────────────────────>│
   │                          │                            │
   │  announce { profile }    │                            │
   │ ─────────────────────────────────────────────────────>│
   │                          │                            │
   │<───────────────────────────────── announce { profile }│
   │                          │                            │
   │  (both know each other's pubkeys now)                 │
```

### Connection Request

```
Requester                                   Responder
   │                                            │
   │  connect-request                           │
   │  {                                         │
   │    type: "connect-request",                │
   │    profile: <requester_profile>,           │
   │    topic: "ai-agents"                      │
   │  }                                         │
   │ ──────────────────────────────────────────>│
   │                                            │
   │                                       (AI decides)
   │                                            │
   │  connect-response                          │
   │  {                                         │
   │    type: "connect-response",               │
   │    accepted: true,                         │
   │    sessions: ["help", "code"],             │
   │    reason: "Welcome!"                      │
   │  }                                         │
   │ <──────────────────────────────────────────│
   │                                            │
   │  (mutual trust established)                │
```

## Error Codes

| Code | Meaning |
|------|---------|
| 0 | OK |
| 1 | Offline (peer unreachable) |
| 2 | Rejected (not authorized) |
| 3 | Invalid (bad message format) |
| 4 | Rate limited |
| 5 | Version mismatch |

## Rate Limits

| Type | Window | Max Requests | Block Duration |
|------|--------|--------------|----------------|
| connections | 60s | 10 | 5 min |
| claims | 60s | 5 | 5 min |
| injects | 1s | 10 | 1 min |
| invalidMessages | 60s | 3 | 10 min |

## Replay Protection

- Each message has unique `nonce`
- Each message has `ts` (timestamp)
- Reject if:
  - `nonce` seen before
  - `ts < now - 5 minutes` (too old)
  - `ts > now + 30 seconds` (clock skew)

## Cryptographic Algorithms

| Purpose | Algorithm | Parameters |
|---------|-----------|------------|
| Signing | Ed25519 | - |
| Key Exchange | X25519 | - |
| Symmetric Encryption | AES-256-GCM | 12-byte IV, 16-byte tag |
| Hashing | SHA-256 | - |
| Key Derivation | SHA-256(ECDH output) | - |

## Wire Examples

### Hello Message

```json
{
  "v": 2,
  "type": "hello",
  "from": "MCowBQYDK2VwAyEA...",
  "encryptPub": "MCowBQYDK2VuAyEA...",
  "ephemeralPub": "MCowBQYDK2VuAyEA...",
  "versions": [2, 1],
  "nonce": "a1b2c3d4e5f6...",
  "ts": 1706123456789,
  "sig": "SGVsbG8gV29ybGQ..."
}
```

### Inject Message

```json
{
  "v": 2,
  "type": "inject",
  "from": "MCowBQYDK2VwAyEA...",
  "session": "dev",
  "payload": "base64(iv + authTag + encrypted)",
  "nonce": "f6e5d4c3b2a1...",
  "ts": 1706123456790,
  "sig": "V29ybGQgSGVsbG8..."
}
```

### Invite Token

```
wop1://eyJ2IjoxLCJpc3MiOiJNQ293QlFZREsyVndBeUVBLi4uIiwic3ViIjoiTUNvd0JRWURLMlZ3QXlFQi4uLiIsInNlcyI6WyJoZWxwIl0sImNhcCI6WyJpbmplY3QiXSwiZXhwIjoxNzA2NzI4MjU2Nzg5LCJub25jZSI6IjEyMzQ1Njc4OTBhYmNkZWYiLCJzaWciOiJTR1ZzYkc4Z1YyOXliR1EuLi4ifQ
```

Decoded:
```json
{
  "v": 1,
  "iss": "MCowBQYDK2VwAyEA...",
  "sub": "MCowBQYDK2VwAyEB...",
  "ses": ["help"],
  "cap": ["inject"],
  "exp": 1706728256789,
  "nonce": "1234567890abcdef",
  "sig": "SGVsbG8gV29ybGQ..."
}
```
