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
- `windowKeys`: server-admitted concurrent windows
- `issuedAt`, `notBefore`, `expiresAt`
- `jti`: unique lease id

Target lifetime: 5 minutes. The client refreshes before expiry. Revoked sessions/devices and expired memberships cannot obtain a new lease.

The signing private key belongs only on the account service. The verification public key belongs in the private engine. No signing secret may be shipped in the extension, native-core, installer configuration, or public repository.

## Phase B cryptographic profile

Phase B uses Ed25519. The deployment signing key is generated outside Git and loaded into the account service from its deployment secret store. The private engine accepts only the corresponding raw Ed25519 public key pinned at compile time through `GPTWORK_CAPABILITY_LEASE_PUBLIC_KEY_B64`.

A lease is accepted only after all of the following succeed:

1. signature verification with the pinned GPTWork lease verification key;
2. exact `version`, `issuer`, header type/key id, and `audience` match;
3. `notBefore <= now < expiresAt`, with a five-second bounded clock-skew allowance and a maximum signed lifetime of 900 seconds;
4. requested operation is present in `features`;
5. request identity matches the signed `deviceId`, `browserInstanceId`, and `extensionId` binding;
6. a window-scoped request uses a `windowKey` admitted by the signed lease;
7. malformed, unknown-key, expired, future-dated, wrong-audience, wrong-device, or wrong-feature leases fail closed.

The extension is not a verifier and does not contain authorization secrets. Native-core is not an authorization authority either; it checks only that a protected request carries a non-empty lease and then transports the opaque lease plus request binding unchanged to the private engine.

## Runtime flow

1. Extension authenticates normally and sends its live window keys to the account service.
2. Account service validates the bearer session and computes current entitlement/device/window admission. When `GPTLOCK_CAPABILITY_LEASE_ENABLED=1`, a successful authorized heartbeat returns one short-lived `capabilityLease` scoped to the server-admitted windows.
3. Extension keeps the lease only in service-worker memory. Account snapshots remain UI/cache data. The lease token is never decoded, edited, or persisted by the extension.
4. Protected extension callers add the local device/browser/extension/window request binding and forward the opaque lease through native-core.
5. Native-core transports the original protected message to private-engine. It does not verify claims or convert `authenticated`, `authorized`, `entitlement.active`, settings, or storage values into authorization.
6. Private-engine verifies the Ed25519 signature, issuer/audience/time/feature/client/window claims, and only then enters the existing private evaluator.

## Offline behavior

A transient server outage may use an already issued lease until its signed expiry. Cached account snapshots may keep UI stable but never extend authorization. After lease expiry, protected operations fail closed until the server issues a fresh lease.

## Key provisioning

Generate the Ed25519 key pair outside Git. Store the PKCS#8 private PEM only in the account-service deployment secret `GPTLOCK_CAPABILITY_LEASE_PRIVATE_KEY_PEM`. Enable issuance with `GPTLOCK_CAPABILITY_LEASE_ENABLED=1` only after that secret exists; startup intentionally fails if issuance is enabled without a valid Ed25519 private key.

The matching raw 32-byte public key is not secret. `createCapabilityLeaseIssuer(...).publicKeyRawBase64Url()` returns the exact base64url value that must be supplied as `GPTWORK_CAPABILITY_LEASE_PUBLIC_KEY_B64` when compiling the production private engine. A production artifact built without that value compiles for CI/migration compatibility but rejects every protected lease at runtime with `capability_lease_verifier_unconfigured`; it never falls back to a development key.

## Migration phases

### Phase A — boundary hardening (merged)

- Native-core rejects protected operations that omit a non-empty `capabilityLease` before private-engine dispatch.
- Private-engine independently rejects protected operations that omit a lease.
- Capability metadata advertises `capabilityLeaseRequired`.
- Regression tests cover missing-lease denial.

Phase A is a migration boundary, not a standalone release target. It must not be published to end users until Phase B restores protected operations through a real server-issued, cryptographically verified lease.

### Phase B — server issuance + cryptographic verification

Implemented acceptance criteria:

- [x] account service issues a short-lived lease only after the existing server-side session, membership/entitlement, device, and window calculation succeeds;
- [x] production signing key material is supplied only by deployment secrets and startup fails closed if lease issuance is enabled without it;
- [x] private-engine verifies a compile-time pinned public key and all signed claims before any protected evaluator runs;
- [x] extension refreshes the lease from heartbeat, keeps it in memory, and forwards it unchanged; native-core remains transport-only;
- [x] no development/test signing key is accepted by a production verification path;
- [x] tests cover valid lease, bad signature, expired/future lease, wrong issuer/audience, wrong device/browser/extension/window, missing operation feature, opaque extension transport, and server issuance after admission;
- [x] rollout remains server-first and backward compatible because lease issuance is feature-flagged and old clients ignore the additional heartbeat field.

### Phase C — remove client authority

- Treat `accountState.entitlement.active`, `authorized`, `allowedWindowKeys`, and cached snapshots as display/UX hints only.
- Remove any execution decision that depends solely on those values.
- Add adversarial tests that mutate extension storage/JavaScript account state and prove private operations remain denied without a valid server lease.

## Deployment order

1. Generate and install the deployment Ed25519 private key on the account service while leaving `GPTLOCK_CAPABILITY_LEASE_ENABLED=0`.
2. Deploy the server code and verify ordinary login/heartbeat behavior for existing clients.
3. Set `GPTLOCK_CAPABILITY_LEASE_ENABLED=1`, restart the service, and verify heartbeat returns a signed lease for an admitted account/window. Existing clients remain compatible because the field is additive.
4. Derive the matching raw public key and build the private engine with `GPTWORK_CAPABILITY_LEASE_PUBLIC_KEY_B64=<public-key-base64url>`.
5. Ship the compatible extension/native-core/private-engine together. Do not publish a Phase B client whose private engine was built without the pinned production public key.

## Repository boundary

The proprietary private-engine source must live in a private repository/monorepo and only its compiled artifact should enter the release pipeline. Removing files from the current public branch does not erase historical Git exposure; history and any previously published source must be treated as disclosed. This migration therefore does not claim source secrecy for code already published.
