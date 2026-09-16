# Server-authoritative capability lease migration

## Security invariant

GPTWork must never grant a protected private-engine capability because extension JavaScript, `chrome.storage`, a local account snapshot, or a caller-supplied boolean says the account is authorized.

The server is authoritative for login/session validity, membership expiry, device admission, and concurrent-window admission. A protected private-engine operation is allowed only when a short-lived capability lease issued by the server is present and valid at the private execution boundary.

## Lease v1 contract

The server issues an opaque/signed `leaseToken` after evaluating the current authenticated session. The corresponding verified claims are conceptually:

- `version`: 1
- `issuer`: `https://gptlock.mv3.cn`
- `audience`: `gptwork-private-engine`
- `subject`: stable user identifier
- `sessionId`: server session identifier
- `deviceId`: server-admitted device identifier
- `browserInstanceId`: current browser instance
- `extensionId`: current extension identity
- `features`: bounded protected capabilities, initially `evaluate_request`, `evaluate_response`, `evaluate_context`
- `windowKeys`: server-admitted concurrent windows, or a server-defined wildcard only when policy permits
- `issuedAt`, `notBefore`, `expiresAt`
- `jti`: unique lease id

Target lifetime: 5 minutes. The client should refresh before expiry. Revoked sessions/devices and expired memberships cannot obtain a new lease.

The signing private key belongs only on the account service. The verification public key belongs in the private engine. No signing secret may be shipped in the extension, native-core, installer configuration, or public repository.

## Runtime flow

1. Extension authenticates normally and sends its live window keys to the account service.
2. Account service validates session + membership + device + windows and returns account state plus a short-lived `capabilityLease`.
3. Extension treats account state as UI information. It forwards the opaque lease to native-core with protected requests; it cannot mint or edit claims.
4. Native-core is a transport boundary. It requires a lease on protected operation names and forwards it to private-engine. It must not convert `authenticated`, `authorized`, `entitlement.active`, local settings, or storage values into authorization.
5. Private-engine verifies signature, issuer, audience, time bounds, operation feature, device/session binding, and where applicable window binding before evaluation. Verification failure is fail-closed.

## Offline behavior

A transient server outage may use an already issued lease until its signed expiry. Cached account snapshots may keep UI stable but never extend authorization. After lease expiry, protected operations fail closed until the server issues a fresh lease.

## Migration phases

### Phase A — boundary hardening (this branch)

- Native-core rejects protected operations that omit a non-empty `capabilityLease` before private-engine dispatch.
- Private-engine independently rejects protected operations that omit a lease. This prevents accidental unguarded call paths when the native transport evolves.
- Capability metadata advertises `capabilityLeaseRequired` so the extension can detect the hardened core.
- Regression tests cover missing-lease denial.

This phase intentionally does **not** accept a lease yet. Shipping a client-generated placeholder or trusting an unverified token would create a false security boundary. Protected operations remain fail-closed until Phase B is deployed end-to-end.

Phase A is a review/CI staging change only and must not be released to end users on its own.

### Phase B — server issuance + cryptographic verification

- Add authenticated `POST /api/v1/account/capability-lease` (or return a lease from heartbeat) after the existing server-side entitlement/device/window calculation.
- Generate a dedicated asymmetric signing key outside the repository and load it only in the server deployment secret store.
- Add lease verification to the proprietary private-engine using the pinned public key.
- Extension refreshes and forwards the opaque lease; native-core remains unable to authorize by itself.
- Enable protected operations only after valid lease verification is deployed.

### Phase C — remove client authority

- Treat `accountState.entitlement.active`, `authorized`, `allowedWindowKeys`, and cached snapshots as display/UX hints only.
- Remove any execution decision that depends solely on those values.
- Add adversarial tests that mutate extension storage/JavaScript account state and prove private operations remain denied without a valid server lease.

## Repository boundary

The proprietary private-engine source must live in a private repository/monorepo and only its compiled artifact should enter the release pipeline. Removing files from the current public branch does not erase historical Git exposure; history and any previously published source must be treated as disclosed. This migration therefore does not claim source secrecy for code already published.
