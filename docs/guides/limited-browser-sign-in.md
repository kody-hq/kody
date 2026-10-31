---
id: limited_browser_sign_in
title: Sign in to an app from an e-reader or older browser
summary:
  Sign in to a Kody package app from a browser that cannot run Kody's page
  JavaScript (e-readers, older Chromium, JavaScript off) with your email and
  password, or with Sign in on another device (short code plus QR code).
category: platform
---

# Sign in to an app from an e-reader or older browser

Some browsers, such as the one built into an e-reader, cannot run the JavaScript
that Kody's sign-in pages normally use. You can still sign in to a Kody package
app from them.

## Email and password

Open the app and choose its sign-in link as usual. Kody's sign-in page works as
a plain form: enter your email and password and press **Sign in**. If your
account uses two-factor authentication, enter the code on the next page. Then
choose **Allow** on the app's consent page.

This works on browsers that run older JavaScript, such as e-readers. The page
draws a quick human check with a small script, so if JavaScript is turned off
completely, use **Sign in on another device** instead.

Passkeys and social sign-in (GitHub, Google, and others) need modern JavaScript,
so use your email and password, or the option below.

## Sign in on another device

1. On the sign-in page, choose **Sign in on another device**.
2. The browser shows a short code (like `BCDF-GHJK`), a QR code, and the address
   `kody.codes/device`.
3. On a phone or computer where you are signed in to Kody, scan the QR code or
   open the address and enter the code.
4. Check that the code matches and that the browser shown is yours, then choose
   **Allow**.
5. The first browser checks back every few seconds and opens the app, signed in.
   You can also press **Check now**.

Codes expire after 10 minutes and work once. If you did not start the sign-in
yourself, choose **Cancel** on the other device. Nothing is shared.

You can review or revoke apps you allowed in Account, Connected apps.
