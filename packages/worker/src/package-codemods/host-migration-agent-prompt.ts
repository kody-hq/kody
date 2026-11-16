/**
 * The approved prompt owners paste to their coding agent for the package app
 * host migration. Placeholders: {owner}, {username}, {app}, {cutover date}.
 * Wording is approved text; do not edit it without a new approval.
 */
export const packageAppHostMigrationAgentPrompt = `My Kody package app @{owner}/{app} is moving to a new browser origin.

  OLD: https://{username}.kody.run/{app}/
       origin https://{username}.kody.run, app mounted at /{app}
  NEW: https://{app}--{username}.kody.run/
       origin https://{app}--{username}.kody.run, app mounted at /

Both addresses serve the same published version of this app until
{cutover date}. On that date every request to OLD becomes a redirect to NEW.
After that no code can run on OLD, and anything this app saved in the browser
under OLD is gone for good. Data on Kody's servers (packageStorage, Durable
Objects, anything else stored server side) is not affected. Do not copy,
export, or migrate it.

Goal: make sure this app works on NEW, and, only if it keeps browser data
people would miss, add a one-time move of that data from OLD to NEW. Publish
well before {cutover date}: each visitor's browser has to open the app on OLD
at least once after the publish for its data to move.

Rules for the whole task:
- If what you find in the code does not match this prompt, or you are unsure,
  stop and tell me. Do not guess.
- OLD is shared with my other apps. Never read, export, clear, or unregister
  anything this app's own code does not create. No localStorage.clear(), no
  deleting IndexedDB databases or caches you did not find in this app's code,
  no unregistering every service worker.
- Never move auth or session tokens, API keys, or other secrets. People sign
  in again on NEW.

Step 1. Make the app work on NEW.
Find and fix anything tied to the old address: hardcoded "/{app}" paths, a
build-time base or router basename (for example Vite base or a router
basepath), absolute https://{username}.kody.run URLs, cookies set with
Path=/{app} or a Domain attribute, Origin, CORS or location.origin checks,
web app manifest start_url and scope, and service worker scope. Every fix
must work on both origins. In server code read packageContext.appBasePath,
assetBasePath and hostedUrl from kody:runtime ("/{app}" on OLD, "" on NEW).
Browser code cannot import kody:runtime, so have the server render the base
into the page (for example a data-app-base attribute on <html>) and read it
there. Cookie names stay the same on NEW: cookiePrefix comes from the
package id, so do not rename any cookie, including names with a __Host- or
__Secure- prefix. Only the Path changes, and it follows the base: a cookie
set with Path=/{app} on OLD needs Path=/ on NEW. Also list any OAuth redirect URIs or webhook URLs registered with
outside services; I will update those by hand.

Step 2. Inventory browser storage, then wait for my OK.
List everything this app's code itself creates: localStorage and
sessionStorage keys, IndexedDB databases and stores, Cache Storage cache
names, service worker registrations, and cookies (named with
packageContext.cookiePrefix). Give the file and line that writes each one.
For each, propose migrate (data people created, drafts, settings) or skip
(caches, anything rebuilt from the server, sessionStorage, auth or session
cookies, tokens). Flag key names generic enough that another app on OLD might
use them too. Flag HttpOnly cookies that act as an anonymous identity for
server-side data (for example a random visitor id): page JavaScript cannot
read them, so tell me whether losing them matters.
If nothing needs migrating, stop here and tell me. Ship only the Step 1 fixes
and the service worker cleanup in Step 6.

Step 3. Export on OLD.
Put both origins in one module, overridable for local runs. In the browser,
detect OLD by comparing location.origin to the OLD origin exactly. When the
app runs on OLD, has data on the approved list, and has no "migrated" marker,
show a clear notice with a "Move my data to the new address" button. Do not
move data or redirect automatically on page load. The payload is JSON:
{ format: "{owner}/{app}-migration", version: 1, exportedAt, data } with only
the approved items. Encode non-JSON values (Blob, Date, ArrayBuffer in
IndexedDB) explicitly, for example base64 with a type tag.

Step 4. Transfer. Build both paths.
a. Window handoff (default). The button opens a dedicated import page on NEW
   with window.open, from the click so popup blockers allow it. When NEW is
   loaded and ready, it posts { type: "ready", nonce } to window.opener with
   targetOrigin set to the exact OLD origin. OLD accepts it only when
   event.origin is exactly the NEW origin and event.source is the window it
   opened, then posts the payload with the nonce, targetOrigin set to the
   exact NEW origin. NEW accepts it only when event.origin is exactly the OLD
   origin, event.source is window.opener, and the nonce matches. NEW replies
   "imported" or an error. Never use "*" as targetOrigin. Never put the data
   in a URL. NEW may first bounce through Kody sign-in, so OLD waits up to
   2 minutes for "ready", then offers the file fallback.
b. File fallback (always). "Download my data" on OLD saves the payload as a
   .json file. "Import data" on NEW reads a file the visitor picks.
Do not add a server endpoint to relay the data. If you think this app needs
one (very large data, or an HttpOnly identity cookie that must carry over),
stop and explain why first. If a relay is truly needed, key it per visitor,
give it a short TTL, and delete the data on first read.

Step 5. Import on NEW.
Validate format, version and the shape of every field before writing
anything. Reject unknown versions with a clear message. If NEW already has
data for an item, never overwrite it silently: ask the visitor whether to keep
the new data or replace it with the old. Write the items, then record an
"imported" marker with exportedAt so importing the same payload again does
nothing and says it already ran.

Step 6. After a confirmed import, and service workers.
On OLD, set the "migrated" marker, keep the old data in place (do not delete
it), and from then on send visitors on OLD to the matching NEW URL. If this
app registers a service worker: make sure the update with the export code
actually reaches visitors on OLD (an old cache-first worker can keep serving
the old build): the page calls registration.update(), and the new worker
calls skipWaiting() and clients.claim(), so the new version takes over
without waiting for every tab to close; after migration, or right away if nothing migrates,
unregister only the registration whose scope is exactly
https://{username}.kody.run/{app}/; on NEW, register it with the scope built
from the rendered base ("/"). If the app has a web app manifest, tell me so I
can ask people who installed it to reinstall from NEW.

Step 7. Test.
Automated: export then import round-trips every approved item; malformed
payloads, a wrong format and an unknown version are rejected with nothing
written; a second import does nothing; conflicts are never overwritten
silently; the message listeners ignore other origins, other windows and wrong
nonces; nothing outside the approved list is read or written.
Local: run \`npx @kodycodes/cli@latest dev\` twice on different ports, once
with \`--app-base-path /{app}\` as OLD and once without as NEW, with the origin
constants pointed at those two local origins, and try the handoff and the
file fallback. Then run \`npx @kodycodes/cli@latest dev check\`.

Step 8. Ship and verify.
Commit, push, and publish. A push alone does not change what is served; only
publish does. Then on the real addresses: create data on OLD, move it, and
confirm it on NEW; run the move again and confirm nothing duplicates; try the
file fallback; confirm my other apps on OLD still work. Finally tell me what
you migrated, what you skipped and why, anything I must update outside Kody,
and that each visitor needs to open OLD once before {cutover date}.`
