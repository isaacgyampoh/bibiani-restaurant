# MY FOOD — owner onboarding

How the client's real owner gets their own MY FOOD account, without anyone sharing a password.

## Security model

- **No public sign-up.** Supabase sign-up is disabled, so accounts are created only by the MY FOOD server.
- **Invitation first.** The operator (the MY FOOD developer) invites one email address for one restaurant. The invitation expires (14 days by default), works once, and can be revoked.
- **Email proof.** The owner receives a single-use link (valid one hour). Opening it is the proof that they control the address.
- **Own password.** The owner chooses their own password (at least 10 characters, breached passwords refused). Nobody else ever sees or sets it.
- **Owner role.** Only when the verified email matches an open invitation does the server create the staff record, with the **Owner** role across all branches. It then marks the invitation used and records `owner.onboarded` in the audit history.
- **Nothing to learn by probing.** The welcome screen answers the same for every email, including when email sending fails, so nobody can find out which emails are invited.
- **Kept out of logs and audit.** Passwords and tokens never go into audit records, logs or URLs. The invitation stores only the email and dates.
- **Owners vs staff:**
  - **Owners and managers** use email and password: full management, including staff, devices and settings.
  - **Staff** use a PIN on a paired till: operations only. A PIN session can never manage staff, devices or settings.

## Steps

### 0. Operator: invite the owner (once)

```bash
PLATFORM_DATABASE_URL=<production admin database URL> \
  pnpm platform:invite-owner --restaurant-id 4f82b0a9-e079-448c-8eb0-e93f2bc713f9 \
  --email owner@client-domain.com --note "Handover"
```

`4f82b0a9-…` is the real Chefelisha Restaurant.

- `--list` shows invitations, with emails masked.
- `--revoke <email>` cancels an open invitation.
- A new invitation for the same email replaces the old one.

**Before inviting:** production email must be able to reach the owner. Connect custom SMTP (see [PRODUCTION-ARCHITECTURE.md](PRODUCTION-ARCHITECTURE.md), Domain and email). Until then, Supabase's built-in sender delivers only to members of the Supabase organization, at most 2 emails an hour.

### 1. Owner opens MY FOOD

`https://bibiani-restaurant.vercel.app/welcome` (or the custom domain). Branded screen: **Set up your restaurant**.

### 2. Owner enters their email

**Send verification link.** The screen says "If this email was invited, a link is on its way".

### 3. Verification email

It arrives from the configured sender. Branded template: `supabase/templates/recovery.html`, subject "MY FOOD — confirm it's you".

### 4. Owner opens the link

The link lands on `/welcome/verify`: "Email verified: …". An expired or used link shows **Send a new link**.

### 5. Owner enters their name and chooses a password

**Create owner account.** The server verifies the email-link session, matches the invitation and creates the Owner, all audited.

### 6. First-time setup guide

The owner lands on **Set up your restaurant** (`/setup`, also in the menu as **Set-up guide**). It has 13 steps, each ticked automatically from the real configuration, and any step can be skipped:

1. Restaurant details
2. Logo and branding (MY FOOD branding is already applied)
3. Contact information
4. Currency (GHS)
5. Tax and service charge (optional; ask the accountant)
6. Dining areas and tables
7. Kitchen stations (including whether screens and printed tickets show prices)
8. Staff (each with their own PIN)
9. Menu (categories, dishes, prices, options, photos)
10. Recipes and stock (optional)
11. Receipt settings (optional)
12. Customer display (optional)
13. POS devices

## After the handover

- The earlier operator login on the real restaurant (created at go-live for the developer) can then be deactivated by the new owner in **Staff**, or kept for support if the owner agrees.
- Staff: **Staff → Add staff member** (name, email, role, starting PIN). The person replaces the starting PIN with their own at first sign-in. Duplicate PINs are refused without revealing whose they are.
- **Recovery:**
  - owners and managers: **Forgot password?** on the sign-in screen;
  - staff: **Forgot PIN?** on the till. It sends a link to their registered email; the new PIN replaces the old one and the change is audited.

## Verified

- **Automated tests** (`packages/testing/test/owner-onboarding.test.ts`):
  - same answer for invited and uninvited emails;
  - link only for invited emails;
  - accept refused without an email-link session;
  - Owner with full management;
  - invitation used once;
  - expired invitations ignored;
  - nothing sensitive in audit.
- **Browser test on staging** (`e2e/onboarding-pairing.spec.ts`): invitation → `/welcome` → link → name and password → setup guide → the Staff page lists the new Owner. The email step itself is replaced by the identical admin-generated link.
- **Not verified:** real email delivery. It needs custom SMTP on the client's domain.
