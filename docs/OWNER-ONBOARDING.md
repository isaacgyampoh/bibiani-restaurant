# MY FOOD — owner onboarding (PIN first)

How the restaurant's owner gets their own MY FOOD account. Nobody shares a password or PIN, and there is no universal default PIN.

## Principles

- **Daily sign-in is a PIN.** Everyone, the owner included, signs in with their own PIN on a **registered device**:
  - a restaurant till or screen (paired by a manager), or
  - their own phone or laptop (registered through an emailed link).
- **Email is the security channel**, not the daily login: verification, recovery ("forgot PIN"), and registering a new device of your own.
- **PINs:** 4 to 6 digits, unique among the restaurant's staff, never stored raw. They are never shown, sent, logged, audited or put in URLs or browser storage.
  - A PIN already in use is refused with "This PIN is already in use. Please choose another PIN.", without saying whose it is.
  - Weak PINs (1234, 1111) are refused.
  - Wrong PINs lock sign-in on that device (5 tries) and for the restaurant (30 tries) for 10 minutes. Every attempt is recorded.
- **Owner's own device vs shared till.**
  - On the owner's (or a manager's) **own** registered device, their PIN gives their full role: staff, devices and settings included.
  - On a **shared restaurant till**, a PIN runs the till but cannot manage staff, devices or settings.
  - Each PIN sign-in is bound on the server to the device it happened on; the browser cannot claim another device.
  - Deactivating or removing a device stops its PIN sessions at once.

## Steps

### 0. Operator: invite the owner (once)

```bash
pnpm platform:invite-owner:prod --restaurant-id 4f82b0a9-e079-448c-8eb0-e93f2bc713f9 --email owner@their-domain.com --note "Handover"
```

`4f82b0a9-…` is the real Chefelisha Restaurant.

- `--list` shows invitations (emails masked).
- `--revoke <email>` cancels an open invitation.
- **While production email sending is not set up yet**, add `--link`. The command then also prints the single-use verification link the email would contain (valid 1 hour). Give it to the owner **privately** (in person or a direct message); whoever opens it can finish the owner sign-up.

### 1. Owner opens the link

Either the emailed link (from `…/welcome`, "Send verification link"), or the link from step 0. The link lands on **Welcome to MY FOOD**, showing "Email verified: …".

### 2. Owner enters their name and creates their PIN

The owner types a PIN twice and presses **Create owner account**. The server then:
- checks the email-link session;
- matches the invitation;
- creates the Owner with that PIN, after the uniqueness check;
- registers **this browser as the owner's device** ("<First name> device 1");
- signs them in with the PIN.

All of this is audited; the PIN never appears in the audit.

### 3. Set-up guide

The owner lands on **Set up your restaurant**, a 13-step checklist. Any step can be skipped and finished later.

### Every day after that

Open MY FOOD on that device and enter the PIN. Nothing else.

### Another phone or laptop

On the sign-in screen type **email + PIN** → **Sign in**. No link. That device is then registered as the owner's own device (visible in Devices & printing, removable there) and asks only for the PIN from then on.

- Only owners and managers can do this; other staff use the restaurant's paired tills.
- Wrong PINs count against that account only (never the restaurant's tills): 5 within 10 minutes lock it for 10 minutes; 10 in a day lock it for the day. Unknown emails and wrong PINs get the same answer.
- Recorded in Activity: `staff.email_pin_sign_in`, `device.personal_registered`, `security.email_pin_lockout`.

### Forgotten PIN

**Forgot PIN?** on the sign-in screen emails a link to choose a new PIN (needs production email sending), or another owner or manager resets it in **Staff**.

**Staff** (cashiers, waiters, kitchen) sign in with their PIN on the restaurant's paired tills. A manager gives them a starting PIN in **Staff**; they must replace it with their own at first sign-in. "Forgot PIN?" on a till sends them an email link to choose a new one.

## Email sending (needed before real emails reach the owner)

- **Today:** production uses Supabase's built-in email sender, which only delivers to members of the developer's Supabase organization (2 an hour). Until a real email provider is connected on the restaurant's domain, use `--link` (step 0) for onboarding.
- **Connect a real provider:** Supabase → Authentication → Emails → SMTP, with a sender on the restaurant's domain. Apply the MY FOOD email template `supabase/templates/recovery.html`.

## Verified

- **Automated** (`packages/testing/test/owner-onboarding.test.ts`, 6 tests):
  - same answer for every email;
  - a PIN session is not accepted as email proof;
  - the owner's PIN signs in on the new device;
  - PIN uniqueness, with a message that never names the holder;
  - weak PINs refused;
  - the sign-in link email;
  - registering another device needs an email-link session and device-management rights;
  - nothing sensitive in the audit.
- **Server rule** (`apps/api/test/pin-sessions.test.ts`, 6 tests):
  - full role on your own device;
  - restricted on a shared till;
  - the device header cannot override the binding;
  - email-link sessions recognised;
  - a deactivated device stops working.
- **Browser, on staging** (`e2e/onboarding-pairing.spec.ts`): invitation → link → name and PIN → set-up guide → Staff page opens, by PIN on the owner's own device.
- **Not verified:** real email delivery, which needs the email provider.
