---
id: cant_open_or_get_mail
title: If you can't open kody.codes or get mail from us
summary:
  Unblock NextDNS and similar DNS filters for kody.codes, and recover missing
  signup or verification mail when a provider is blocking our domain.
category: platform
---

# If you can't open kody.codes or get mail from us

## Site won't load (NextDNS or similar DNS filters)

NextDNS and some other DNS filters only block `.codes` if someone turned on TLD
blocking or another security list matched the domain. It is not blocked for
every NextDNS user by default.

**Fix:** In [my.nextdns.io](https://my.nextdns.io) → your profile →
**Allowlist**, add `kody.codes` (that covers subdomains too). If `.codes` was
added under Security → Block Top-Level Domains, remove it. Check **Logs** to see
which rule fired.

## Signup or verification email never arrives

If your mailbox provider is blocking `kody.codes` right now (for example a
Spamhaus DBL listing that Fastmail and some alias providers honor), resending
the same verification message will not get through and can make delivery worse.

**What to do:**

1. Try another address (Gmail and most providers still accept us), or use social
   login on the signup page.
2. Or contact [support](https://kody.codes/support) with the address you used —
   an operator can verify your account manually or send a one-time verification
   link over a path that is not `kody.codes` mail.

Signup also refuses an address that is missing an `@`, a known typo (the error
suggests the corrected address), a disposable inbox, or a domain that has no
mail servers. If a previous message to that address hard-bounced, Kody stops
sending verification mail and password-reset mail there. Verification asks for a
different address or support. A password-reset request still shows the same
generic success message. One address can receive at most 5 verification emails
in 24 hours; password resets do not count toward that cap. The verification
error says when to retry.

**If mail is delayed rather than blocked:** check Spam/Junk, then whitelist
`kody.codes` / `kody@kody.codes` (exact steps vary by provider). On Fastmail,
adding `*@kody.codes` as a contact helps once the domain is not blocklisted.

## For support / agents

Ask for: provider (Gmail, Fastmail, etc.), whether mail was rejected vs silent,
and if possible full headers or bounce text (`blacklisted`, `RLR613`,
`dbl.spamhaus.org`).

**Operator verification rescue** (no raw D1 write):

- Admin Users → find the account → **Mark email verified**, or **Mint verify
  URL** and send that one-time `/verify-email?token=...` link over Discord,
  chat, or another channel that is not `kody.codes` mail.
- Both actions are audited.
