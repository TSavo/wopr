# WOPR Threat Model

**Without Official Permission Required**

## Overview

WOPR is a self-sovereign AI session management system using peer-to-peer networking. This document describes the security architecture, threat vectors, and mitigations.

## Protocol Version

Current: **v2** (with v1 backward compatibility)

## Cryptographic Primitives

| Purpose | Algorithm | Key Size |
|---------|-----------|----------|
| Identity signing | Ed25519 | 256-bit |
| Key exchange | X25519 (ECDH) | 256-bit |
| Symmetric encryption | AES-256-GCM | 256-bit |
| Hashing | SHA-256 | 256-bit |

## Trust Model

WOPR uses a **pre-authorized trust model**:

1. Alice creates an invite token for Bob's specific public key
2. Token is signed with Alice's Ed25519 private key
3. Bob claims the token via P2P handshake
4. Both parties store each other's public keys
5. Future communications use those keys for authentication

**Key properties:**
- Tokens are non-transferable (bound to recipient's pubkey)
- Tokens expire (default: 7 days)
- Grants can be revoked at any time
- No central authority or certificate chain

## Threat Categories

### 1. Network Adversary (Passive)

**Capabilities:** Can observe all network traffic.

**Mitigations:**
- All P2P messages encrypted with AES-256-GCM
- Session-level forward secrecy via ephemeral X25519 keys
- No plaintext metadata in message payloads

**Residual risks:**
- Traffic analysis (timing, message sizes, connection patterns)
- IP addresses visible to network observers

### 2. Network Adversary (Active / MITM)

**Capabilities:** Can intercept, modify, or inject network traffic.

**Mitigations:**
- Protocol handshake authenticates both parties
- Messages signed with Ed25519 - tampering detected
- Replay protection via nonces and timestamps
- ECDH key exchange provides mutual authentication

**Residual risks:**
- If initial key exchange observed, attacker knows public keys (but not secrets)

### 3. Compromised Long-Term Key

**Scenario:** Attacker obtains Alice's Ed25519 private key.

**Mitigations:**
- Forward secrecy: past sessions cannot be decrypted (ephemeral keys)
- Key rotation: Alice can rotate to new key, old key invalidated after grace period
- Key history tracking: peers can still identify rotated identities

**What attacker CAN do:**
- Impersonate Alice going forward
- Sign new invite tokens
- Decrypt future messages (until key rotated)

**What attacker CANNOT do:**
- Decrypt past recorded sessions (forward secrecy)
- Access sessions after key rotation is propagated

### 4. Compromised Peer

**Scenario:** Bob's system is compromised.

**Mitigations:**
- Per-session access grants limit blast radius
- Revocation immediately stops attacker access
- No key escrow or recovery mechanisms

**What attacker CAN do:**
- Inject messages to sessions Bob had access to
- See Bob's peer list and access grants

**What attacker CANNOT do:**
- Access sessions Bob didn't have grants for
- Impersonate other peers (don't have their keys)

### 5. Denial of Service

**Capabilities:** Flood the victim with connections/messages.

**Mitigations:**
- Rate limiting per peer:
  - Connections: 10/minute, 5-min block
  - Claims: 5/minute, 5-min block
  - Injects: 10/second, 1-min block
  - Invalid messages: 3/minute, 10-min block
- Replay protection rejects duplicate messages
- Invalid signatures immediately drop connection

**Residual risks:**
- Distributed attacks from many keys
- Sybil attack (many fake identities)

### 6. Replay Attack

**Scenario:** Attacker records and replays valid messages.

**Mitigations:**
- Every message includes unique nonce
- Messages include timestamp (5-minute validity window)
- ReplayProtector tracks seen nonces
- 30-second clock skew tolerance

### 7. Protocol Downgrade

**Scenario:** Attacker forces use of weaker protocol version.

**Mitigations:**
- Hello message lists all supported versions
- Peers negotiate highest common version
- Minimum version enforced (v1)
- Version mismatch = connection rejected

### 8. Discovery Topic Flooding

**Scenario:** Attacker floods a discovery topic with fake profiles.

**Mitigations:**
- All profiles cryptographically signed
- Invites bound to specific recipient pubkey (intercepted tokens useless)
- AI-driven filtering of profile content
- Secret topic names as shared secrets
- Pubkey filtering if target is known

**What attacker CAN do:**
- Fill topic with garbage profiles
- Waste bandwidth/processing
- Make discovery slower

**What attacker CANNOT do:**
- Forge profiles (signatures fail)
- Use intercepted invites (wrong pubkey)
- Force connections (mutual acceptance required)

### 9. Discovery Impersonation

**Scenario:** Attacker creates profile claiming to be someone else.

**Mitigations:**
- Profiles are signed with the Ed25519 key
- The pubkey IS the identity - can't claim another's key
- Claiming a name means nothing - verify pubkey

**Attack fails because:**
```
Attacker profile:
  pubkey: ATTACKER_KEY
  content: {"name": "Alice"}  <-- lies
  sig: valid (but for ATTACKER_KEY)

Real Alice profile:
  pubkey: ALICE_KEY
  content: {"name": "Alice"}
  sig: valid (for ALICE_KEY)
```

Bob verifies invites against pubkey, not display name. Attacker's invite would be from ATTACKER_KEY, not ALICE_KEY.

### 10. Connection Request Spam

**Scenario:** Attacker sends many connection requests.

**Mitigations:**
- Rate limiting on connection requests
- AI decides whether to accept (can reject patterns)
- Connection requires profile exchange first
- Block repeated rejections

### 11. Topic Enumeration

**Scenario:** Attacker tries to discover what topics exist.

**Reality:**
- Topics are just hashes - no directory
- Attacker must guess topic names
- Common names ("global", "ai-agents") are public anyway
- Secret topics = security through obscurity (intentional)

**Recommendations:**
- Use obscure topic names for private discovery
- Treat topic names like passwords for sensitive use
- Share topic names through secure channels

### 12. Profile Content Attacks

**Scenario:** Attacker crafts malicious profile content.

**Mitigations:**
- Profile content is freeform JSON - parsed safely
- AI evaluates content (can spot manipulation)
- No code execution from profiles
- Content doesn't grant trust - only pubkey exchange does

**Residual risks:**
- Social engineering via profile content
- Phishing-style attacks in content

## Message Flow Security

### Handshake (Protocol v2)

```
Alice                                    Bob
  |                                       |
  |-- Hello {versions, ephemeralPub} ---> |
  |                                       |
  |<-- HelloAck {version, ephemeralPub} --|
  |                                       |
  | (derive shared secret from ephemeral keys)
  |                                       |
  |-- Encrypted message --------------->  |
  |                                       |
```

### Key Rotation Propagation

```
Alice (old key)                          Peers
  |                                       |
  | 1. Generate new keypair               |
  | 2. Sign rotation with OLD key         |
  |                                       |
  |-- KeyRotation {old, new, sig} ------> |
  |                                       |
  |    Peer verifies sig with old key     |
  |    Peer updates Alice's key           |
  |    Peer keeps old key in history      |
  |    (7-day grace period)               |
  |                                       |
```

## Data Storage Security

| File | Contents | Permissions |
|------|----------|-------------|
| identity.json | Ed25519 + X25519 keypairs | 0600 |
| access.json | Grants to other peers | 0600 |
| peers.json | Known peer keys | 0600 |

**Recommendations:**
- Store WOPR_HOME on encrypted filesystem
- Back up identity.json securely
- Consider hardware security module for high-value deployments

## Session Security

Each WOPR session runs with:
- `permissionMode: "bypassPermissions"` - full access to Claude tools
- `allowDangerouslySkipPermissions: true` - no confirmation prompts

**This is intentional** - WOPR sessions are meant for autonomous operation.

**Implications:**
- Injected messages have full system access via Claude
- Session context can mitigate (restrict what Claude does)
- Only authorized peers can inject

## Known Limitations

1. **No perfect forward secrecy for stored messages** - If you log messages after decryption, those logs aren't protected by PFS.

2. **Trust on first use (TOFU)** - Initial key exchange could be MITM'd if attacker controls network AND knows you'll accept their token.

3. **No key revocation propagation** - If Alice revokes Bob, Bob's peers don't automatically learn this.

4. **Metadata leakage** - Connection timing, frequency, and peer relationships are observable at network level.

5. **No anonymous operation** - Public keys serve as stable identifiers.

## Discovery Security

### Topic Security Model

```
Public Topics          Semi-Private Topics       Private Topics
("global")             ("rust-ai-hackers")       ("alice-bob-2024-xyz")
     │                        │                         │
     ▼                        ▼                         ▼
Anyone can join         Guessable names           Secret shared OOB
High spam risk          Moderate spam risk        Minimal spam risk
AI filtering needed     Community moderation      Trusted peers only
```

### Spam-Resistant Key Exchange

Even in a flooded topic:

```
[Topic full of spam]
   │
   ├── Spammer1: garbage profile
   ├── Spammer2: garbage profile
   ├── Alice: real profile (pubkey: ALICE_KEY)
   ├── Spammer3: garbage profile
   ├── Bob: real profile (pubkey: BOB_KEY)
   └── ... more spam ...

Alice sees Bob's profile → creates invite bound to BOB_KEY
Bob sees Alice's profile → creates invite bound to ALICE_KEY

Spammer intercepts Alice's invite → CANNOT claim (not BOB_KEY)
Spammer intercepts Bob's invite → CANNOT claim (not ALICE_KEY)

Only Bob can claim Alice's invite (proves he owns BOB_KEY)
Only Alice can claim Bob's invite (proves she owns ALICE_KEY)
```

### Recommendations for Discovery

- Use secret topics for sensitive introductions
- Verify pubkeys through secondary channel when possible
- Let AI filter connection requests
- Don't include secrets in profile content
- Treat public topics as hostile environments

## Security Checklist

### Identity & Keys
- [ ] Generate identity with strong entropy (`wopr id init`)
- [ ] Store identity.json on encrypted storage
- [ ] Backup identity.json securely
- [ ] Rotate keys periodically (`wopr id rotate --broadcast`)

### Trust Management
- [ ] Verify peer public keys out-of-band before trusting
- [ ] Use specific session grants (not `*`) when possible
- [ ] Monitor access grants (`wopr access`)
- [ ] Revoke unused grants (`wopr revoke <peer>`)

### Discovery
- [ ] Use secret topic names for private introductions
- [ ] Don't include sensitive info in profile content
- [ ] Verify pubkeys match expected values
- [ ] Configure AI to filter suspicious connection requests

### Operations
- [ ] Run daemon with minimal system privileges
- [ ] Keep WOPR updated for security patches
- [ ] Monitor daemon logs for suspicious activity
- [ ] Use encrypted filesystem for WOPR_HOME

## Version History

| Version | Changes |
|---------|---------|
| v1 | Static key encryption, basic auth |
| v2 | Hello/HelloAck handshake, ephemeral keys (PFS), rate limiting, replay protection, key rotation, discovery |
