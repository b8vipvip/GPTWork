# Server-authoritative capability lease migration

## Security invariant

GPTWork must never grant a protected private-engine capability because extension JavaScript, `chrome.storage`, a local account snapshot, or a caller-supplied boolean says the account is authorized.

The server is authoritative for login/session validity, membership expiry, device admission, and concurrent-window admission. A protected private-engine operation is allowed only when a short-lived capability lease issued by the server is present and valid at the private execution boundary.

## Lease v1 contract

The server issues a signed `leaseToken` only after evaluating the current authenticated session. The verified claims are:

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

Target lifetime: 5 minutes. The client refreshes before expiry. Revoked sessions/devices and expired memberships cannot obtain a new lease.

The signing private key belongs only on the account service. The verification public key belongs in the private engine. No signing secret may be shipped in the extension, native-core, installer configuration, or public repository.

## Phase B cryptographic profile

Phase B uses an asymmetric signature profile. The deployment signing key is generated outside Git and loaded into the account service from its deployment secret store. The private engine ships only the corresponding verification public key.

A lease is accepted only after all of the following succeed:

1. signature verification with the pinned GPTWork lease verification key;
2. exact `version`, `issuer`, and `audience` match;
3. `notBefore <= now < expiresAt`, with only a small bounded clock-skew allowance;
4. requested operation is present in `features`;
5. request identity matches the signed `deviceId`, `browserInstanceId`, and `extensionId` binding;
6. a window-scoped request uses a `windowKey` admitted by the signed lease;
7. malformed, unknown-key, expired, future-dated, wrong-audience, wrong-device, or wrong-feature leases fail closed.

The extension is not a verifier and does not contain authorization secrets. Native-core is not an authorization authority either; it transports the opaque lease and request identity to the private engine.

## Runtime flow

1. Extension authenticates normally and sends its live window keys to the account service.
2. Account service validates session + membership + device + windows and returns account state plus a short-lived `capabilityLease`.
3. Extension treats account state as UI information. It forwards the opaque lease to native-core with protected requests; it cannot mint or edit claims.
4. Native-core is a transport boundary. It requires a lease on protected operation names and forwards it to private-engine. It must not convert `authenticated`, `authorized`, `entitlement.active`, local settings, or storage values into authorization.
5. Private-engine verifies the lease and request binding before evaluation. Verification failure is fail-closed.

## Offline behavior

A transient server outage may use an already issued lease until its signed expiry. Cached account snapshots may keep UI stable but never extend authorization. After lease expiry, protected operations fail closed until the server issues a fresh lease.

## Migration phases

### Phase A — boundary hardening (merged)

- Native-core rejects protected operations that omit a non-empty `capabilityLease` before private-engine dispatch.
- Private-engine independently rejects protected operations that omit a lease.
- Capability metadata advertises `capabilityLeaseRequired`.
- Regression tests cover missing-lease denial.

Phase A is a migration boundary, not a standalone release target. It must not be published to end users until Phase B restores protected operations through a real server-issued, cryptographically verified lease.

### Phase B — server issuance + cryptographic verification

Implementation acceptance criteria:

- account service issues a short-lived lease only after the existing server-side session, membership, device, and window calculation succeeds;
- production signing key material is supplied only by deployment secrets and startup fails closed if lease issuance is enabled without it;
- private-engine verifies the pinned public key and all signed claims before any protected evaluator runs;
- extension refreshes the lease and forwards it unchanged; native-core cannot authorize by itself;
- no development/test signing key is accepted by a production build;
- tests cover valid lease, bad signature, expired/future lease, wrong issuer/audience, wrong device/browser/extension/window, and missing operation feature;
- deployment is ordered server issuer first, then compatible client/private-engine, so existing clients are not stranded.

### Phase C — remove client authority

- Treat `accountState.entitlement.active`, `authorized`, `allowedWindowKeys`, and cached snapshots as display/UX hints only.
- Remove any execution decision that depends solely on those values.
- Add adversarial tests that mutate extension storage/JavaScript account state and prove private operations remain denied without a valid server lease.

## Repository boundary

The proprietary private-engine source must live in a private repository/monorepo and only its compiled artifact should enter the release pipeline. Removing files from the current public branch does not erase historical Git exposure; history and any previously published source must be treated as disclosed. This migration therefore does not claim source secrecy for code already published.
