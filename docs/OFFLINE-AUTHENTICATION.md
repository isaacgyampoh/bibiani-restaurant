# MY FOOD — offline staff sign-in on the hub

## The problem

- In the cloud, a staff PIN is checked against a keyed digest. The key is an environment-wide server secret (the "pepper").
- Copying that secret to a restaurant PC would weaken every restaurant, so it never leaves the cloud.
- Storing a Supabase session and calling it "offline login" is not authentication.

## How the hub does it

1. **Its own secret.** On first start the hub generates its own random pepper and token-signing key. The Windows app keeps them encrypted with the Windows key store (DPAPI, `safeStorage`); a copied data folder alone does not reveal them.
2. **Learning a PIN (online).** When someone types a PIN on a hub till that the hub does not know:
   - the hub asks the cloud (`POST /v1/hub/pin-verify`, hub login only, with the cloud's own lockouts);
   - if valid, the hub stores **its own** digest of that PIN for that person, and the PIN's version number;
   - the PIN itself is never stored, logged or sent anywhere else.
3. **Offline.** The hub checks PINs against its own digests with the usual rules:
   - 5 wrong PINs per till, or 30 per restaurant, within 10 minutes lock PIN sign-in for 10 minutes;
   - every attempt is recorded, and lockouts are audited.
4. **Role and permissions.** These come from the latest snapshot. A PIN session never has management permissions (staff, devices, settings), exactly as in the cloud.
5. **Changing a PIN on a hub till.** This needs the internet:
   - the change is made in the cloud (`POST /v1/hub/pin-change`, audited with the hub), so the new PIN works everywhere;
   - offline, the till says so and the current PIN keeps working.
6. **Revocation.** At the next sync:
   - a PIN reset in the back office bumps the PIN version, so the hub drops its copy;
   - a deactivated staff member cannot sign in;
   - a changed role takes effect.
7. **Sessions.**
   - Hub sessions are short-lived signed tokens (1 hour) with rotating refresh tokens, stored as hashes only.
   - They are valid only on this hub; the cloud refuses them.
   - Device logins (tills, screens) are separate hub logins, with passwords stored as scrypt hashes.

## PIN sessions are bound to their device (cloud and hub)

- Every PIN sign-in is recorded server-side (`pin_sessions`: session id → staff member and device).
- **The binding decides the device**, not the browser's `x-device-id` header. It also tells a PIN session apart from an email-link session: Supabase marks both as "otp", but only PIN sessions are bound.
- **Where the person signs in matters:**
  - on the person's own personal device, the full role applies;
  - on a shared till, staff, device and settings management are closed.
- **A deactivated or unpaired device** ends its PIN sessions immediately.

## Approving devices at the hub

- Pairing a till or screen needs someone whose role may manage devices.
- On the hub this is done in the hub window, **on the hub PC only** (loopback address), with that person's PIN.
- The PIN is checked by the same use case and lockouts as above.
- Being at the hub PC plus the PIN stands in for the password sign-in the back office requires.

## Limits (stated plainly)

- **First sign-in needs the internet.** A person who has never signed in on this hub while online cannot sign in offline.
- **Stale access for a short while.** Until the hub syncs, a PIN changed or revoked in the back office still works on the hub. Offline, that can be a while.
- **Short PINs can be guessed if the hub's secret is taken.** A 4–6 digit PIN could be brute-forced by someone who obtains both the hub's database and its secret. The Windows key store protects the secret against a copied disk, not against someone with full control of the signed-in Windows account. Keep the hub PC's Windows account password-protected.

## Tests

- `packages/testing/test/hub-pins.test.ts` (8 tests):
  - first sign-in needs the cloud;
  - the hub holds its own digest, not the cloud's;
  - a PIN change works offline afterwards;
  - PIN changes offline are refused;
  - lockout;
  - a back-office reset revokes the old PIN;
  - deactivation;
  - no conflicts on sync;
  - hub-only endpoints.
- `apps/hub/test/hub-http.test.ts`:
  - console only from the hub PC;
  - a cashier cannot approve devices;
  - refresh-token rotation;
  - forged token refused;
  - a PIN session cannot manage.
