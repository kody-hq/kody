---
title: Kody weekly: Machine access, app origins, and Desktop on Windows and Linux
date: 2026-11-20
description: Named machine access, an origin per package app, Kody Desktop for Windows and Linux, and rename-safe credentials, plus more updates and fixes.
order: 1
category: updates
---

Here is what shipped in Kody from November 14 to November 20, 2026. This week
machines on execution contexts get named, per-package access instead of an
all-or-nothing shell, every package app gets its own origin, and Kody Desktop
ships for Windows and Linux. Several changes need action: see Breaking changes
below.

## Give runs named machine access instead of a shell (early access)

### What shipped

Execution contexts are an early access experiment you turn on at
`/account/experiments`. A machine's local policy can now define named commands
(a fixed executable with allowed argument shapes, run without a shell), local
network destinations (IP addresses or CIDR ranges plus ports), and host folders.
You manage them with `kody context capability`, the machine reports them to
Kody, and Kody authorizes each one before a run's first use and records every
use. A run can call a named command with the unrestricted shell turned off.

The operator can limit the shell, any named command, destination, or folder, and
the whole local network to a list of saved packages; unlisted packages and ad
hoc code get a clear refusal. Named commands and destinations can be shared with
a person, a team, everyone in the org, or one of your profiles. Each context's
page has a new **Machine access** section that shows every entry and who holds
it, with grant and remove actions. Packages declare the machine access they use
in `kody.machine` in `package.json`, so you see what a package will touch before
you allow it.

### Why it matters

Letting an agent restart one container used to mean handing it a shell on the
machine. Now you expose exactly the commands and hosts a package needs, decide
which packages may use them, and read the audit trail.

### Example

Define a command on the machine with
`kody context capability add command my-command.json`:

```json
{
	"name": "my-command",
	"exec": ["node", "/opt/tools/my-command.mjs"],
	"args": [["status"], ["restart", { "pattern": "[a-z0-9-]{1,40}" }]]
}
```

Declare it in the package that uses it, then call it from that package:

```json
{
	"kody": {
		"machine": {
			"my-command": {
				"kind": "command",
				"description": "Check and restart services"
			}
		}
	}
}
```

```ts
await kody.command.run({ capability: 'my-command', args: ['restart', 'web'] })
```

Docs: [Execution contexts](https://kody.codes/docs/execution-contexts) ·
[Package authoring](https://kody.codes/docs/package-authoring) · PRs:
[#5250](https://github.com/kody-hq/kody/pull/5250),
[#5253](https://github.com/kody-hq/kody/pull/5253),
[#5260](https://github.com/kody-hq/kody/pull/5260),
[#5272](https://github.com/kody-hq/kody/pull/5272),
[#5278](https://github.com/kody-hq/kody/pull/5278),
[#5281](https://github.com/kody-hq/kody/pull/5281),
[#5287](https://github.com/kody-hq/kody/pull/5287),
[#5291](https://github.com/kody-hq/kody/pull/5291),
[#5295](https://github.com/kody-hq/kody/pull/5295),
[#5304](https://github.com/kody-hq/kody/pull/5304),
[#5310](https://github.com/kody-hq/kody/pull/5310),
[#5311](https://github.com/kody-hq/kody/pull/5311),
[#5312](https://github.com/kody-hq/kody/pull/5312),
[#5313](https://github.com/kody-hq/kody/pull/5313),
[#5314](https://github.com/kody-hq/kody/pull/5314),
[#5319](https://github.com/kody-hq/kody/pull/5319)

## Every package app gets its own origin

### What shipped

Package apps now serve at the root of their own host,
`{leaf}--{handle}.kody.run`, next to the existing path address. Each app gets
its own cookies, storage, and same-origin boundary, and sign-in returns to the
app's host. A profile package named `@{handle}/{handle}` can own your bare
`{handle}.kody.run` host so existing URLs keep answering. `kody dev` serves the
same shape locally at `{leaf}--{handle}.localhost`. From 2026-12-17 20:45 UTC
the old `/{app}/` path address redirects to the app's own host.

### Why it matters

Apps that shared one origin also shared browser storage and cookies. With an
origin per app, one app's data stays out of another's reach, and you can test
the real URL shape before the cutover.

### Example

1. Open your app at `https://my-app--your-handle.kody.run/`.
2. Update links, webhooks, and OAuth redirect URLs that still use
   `https://your-handle.kody.run/my-app/`.
3. Run `kody dev` and open the app at its `.localhost` origin to check it
   locally.

Docs: [Package apps](https://kody.codes/docs/package-apps) · PRs:
[#5248](https://github.com/kody-hq/kody/pull/5248),
[#5256](https://github.com/kody-hq/kody/pull/5256),
[#5259](https://github.com/kody-hq/kody/pull/5259),
[#5277](https://github.com/kody-hq/kody/pull/5277),
[#5349](https://github.com/kody-hq/kody/pull/5349)

## Kody Desktop for Windows and Linux

### What shipped

Every Kody Desktop release now includes Windows x64 and arm64 builds as MSIX
packages that update through App Installer, and Linux x64 and arm64 builds as
both an AppImage and a `.deb`. The AppImage updates itself; `.deb` installs get
a menu item that opens the download page. The download page sends each platform
straight to its installer.

### Why it matters

Kody Desktop was easiest to use on a Mac. Now the same app, with its machine
controls and sign-in, runs on the Windows and Linux machines your team already
uses.

### Example

1. Open [kody.codes/download](https://kody.codes/download) on Windows or Linux.
2. Install the MSIX, AppImage, or `.deb` it hands you.
3. Sign in through your browser when the app asks.

PRs: [#5183](https://github.com/kody-hq/kody/pull/5183),
[#5187](https://github.com/kody-hq/kody/pull/5187),
[#5188](https://github.com/kody-hq/kody/pull/5188)

## Credentials that survive renames, and more ways for agents to set them up

### What shipped

Execute picks, webhook settings, and provider doors now point at the credential
itself instead of its name, and `credentialUpdate` renames a secret in place:
grants, mappings, and history stay attached, and the response lists stored
settings that still name the old secret. Agents can create package-scoped
secrets directly by passing `package_id` to `secretSet`, with the same
permission checks as the website. Login credentials can opt into single-request
sessions that log in, send one request, and log out. Packages get owner-approved
JSON and GraphQL credential fields and path templates. Adding a new package to
an already locked integration or MCP server now returns an owner approval link
and changes nothing. With the profiles experiment on, `accessGrant`,
`accessRevoke`, and `accessList` accept `subject_type: "profile"`, and a
profile's page has a Give access form.

### Why it matters

Renaming a secret used to break whatever referred to it by name, and a package
secret had to start as an org secret that you locked by hand. Now agents can set
up credentials the way they will be used, and owners still approve anything that
widens access.

### Example

Create a package-scoped secret from `execute`:

```ts
await kody.secretSet({
	name: 'example-api-key',
	value: 'YOUR_TOKEN',
	scope: 'package',
	package_id: 'YOUR_PACKAGE_ID',
})
```

Docs: [Secrets](https://kody.codes/docs/secrets) ·
[Credentials](https://kody.codes/docs/credentials) ·
[Profiles](https://kody.codes/docs/profiles) · PRs:
[#5421](https://github.com/kody-hq/kody/pull/5421),
[#5390](https://github.com/kody-hq/kody/pull/5390),
[#5439](https://github.com/kody-hq/kody/pull/5439),
[#5429](https://github.com/kody-hq/kody/pull/5429),
[#5432](https://github.com/kody-hq/kody/pull/5432),
[#5434](https://github.com/kody-hq/kody/pull/5434)

## More updates

- **Execute:** Makes cloud `execute` faster: a package status read that took 3.5
  to 6 seconds now takes 1 to 2, because bundle and package caches hit and CLI
  auth batches into one request.
  ([#5423](https://github.com/kody-hq/kody/pull/5423),
  [#5417](https://github.com/kody-hq/kody/pull/5417))
- **Packages:** Lets any package's code emit that package's events wherever it
  runs, including exports called from `execute`, and adds `hostedUrl` and
  `appBasePath` to `packageContext` on every surface.
  ([docs](https://kody.codes/docs/package-subscriptions),
  [#5437](https://github.com/kody-hq/kody/pull/5437),
  [#5441](https://github.com/kody-hq/kody/pull/5441))
- **Credentials:** Scrolls credential deep links to their record and edits
  credentials in place, names why a secret cannot be read locally, and shows and
  validates allowed hosts on Key setup links.
  ([#5368](https://github.com/kody-hq/kody/pull/5368),
  [#5365](https://github.com/kody-hq/kody/pull/5365),
  [#5364](https://github.com/kody-hq/kody/pull/5364))
- **Dashboard:** Gives package pages one scrolling tab bar and redesigns MCP
  server pages for phones, on a shared set of dialogs, menus, form controls, and
  buttons. ([#5442](https://github.com/kody-hq/kody/pull/5442),
  [#5444](https://github.com/kody-hq/kody/pull/5444),
  [#5258](https://github.com/kody-hq/kody/pull/5258),
  [#5273](https://github.com/kody-hq/kody/pull/5273))
- **Email:** Adds an opt-in "What's New in Kody" newsletter, with an unchecked
  box at signup and a double opt-in page at `/newsletter`.
  ([#5182](https://github.com/kody-hq/kody/pull/5182),
  [#5217](https://github.com/kody-hq/kody/pull/5217))
- **Orgs:** Makes username suggestions at signup clickable buttons that fill in
  a handle the server already confirmed is free.
  ([#5350](https://github.com/kody-hq/kody/pull/5350))
- **CLI:** Runs local and hosted code against the owning org's real plan, shares
  one local package store between `kody execute --local` and `kody dev`, and
  runs inline code as TypeScript on contexts and `--local`, like Kody cloud.
  ([#5357](https://github.com/kody-hq/kody/pull/5357),
  [#5404](https://github.com/kody-hq/kody/pull/5404),
  [#5237](https://github.com/kody-hq/kody/pull/5237))
- Plus smaller changes, including feature pages for skills, agent profiles,
  execution contexts, email, and files
  ([#5342](https://github.com/kody-hq/kody/pull/5342)), a new This machine card
  ([#5380](https://github.com/kody-hq/kody/pull/5380)), usage ceilings that
  normal use never reaches ([#5326](https://github.com/kody-hq/kody/pull/5326)),
  and a confirmation before shared apps run as a visitor
  ([#5412](https://github.com/kody-hq/kody/pull/5412)). See the
  [full release list](https://github.com/kody-hq/kody/releases).

## Fixes

- **Platform:** Fixes brief database blips turning into hard failures; package
  pages answer with a retryable response and reads back off and retry.
  ([#5428](https://github.com/kody-hq/kody/pull/5428),
  [#5419](https://github.com/kody-hq/kody/pull/5419),
  [#5446](https://github.com/kody-hq/kody/pull/5446))
- **Packages:** Fixes publishes that stalled after approval, retried silently on
  memory or CPU limits, or rebuilt uploaded local and context builds in the
  cloud. ([#5407](https://github.com/kody-hq/kody/pull/5407),
  [#5398](https://github.com/kody-hq/kody/pull/5398),
  [#5122](https://github.com/kody-hq/kody/pull/5122),
  [#5185](https://github.com/kody-hq/kody/pull/5185),
  [#5366](https://github.com/kody-hq/kody/pull/5366))
- **Apps:** Fixes republishing an internet-visible app splitting or interrupting
  visitors; everyone stays on the approved version until the owner approves, and
  owners are told. ([#5201](https://github.com/kody-hq/kody/pull/5201),
  [#5232](https://github.com/kody-hq/kody/pull/5232),
  [#5222](https://github.com/kody-hq/kody/pull/5222))
- **Apps:** Fixes package app sign-in failing with `ERR_TOO_MANY_REDIRECTS` on
  paths with a trailing slash.
  ([#5196](https://github.com/kody-hq/kody/pull/5196))
- **Automations:** Fixes webhook deliveries vanishing after a 202, and one
  account's burst of webhooks or package events delaying everyone else's.
  ([#5160](https://github.com/kody-hq/kody/pull/5160),
  [#5162](https://github.com/kody-hq/kody/pull/5162),
  [#5190](https://github.com/kody-hq/kody/pull/5190))
- **Credentials:** Fixes approval links for org secrets opening your personal
  account, and OAuth connects that hid the provider's refusal reason.
  ([#5438](https://github.com/kody-hq/kody/pull/5438),
  [#5300](https://github.com/kody-hq/kody/pull/5300))
- **CLI:** Fixes `kody dev check` refusing package trees that publish accepts,
  and the daemon dying on dropped sockets.
  ([#5328](https://github.com/kody-hq/kody/pull/5328),
  [#5149](https://github.com/kody-hq/kody/pull/5149),
  [#5265](https://github.com/kody-hq/kody/pull/5265))
- **Platform:** Fixes: tightens secret storage and access checks.
  ([#5152](https://github.com/kody-hq/kody/pull/5152),
  [#5156](https://github.com/kody-hq/kody/pull/5156),
  [#5158](https://github.com/kody-hq/kody/pull/5158))

## Breaking changes

- **Apps:** From 2026-12-17 20:45 UTC, package app code no longer runs on
  `https://{handle}.kody.run/{app}/`; that address answers with a 308 to the
  app's own host, and browser data saved under the old origin is not readable
  there. **Action:** move links, webhooks, and OAuth redirects to
  `{leaf}--{handle}.kody.run` before 2026-12-17, or add a profile package
  `@{handle}/{handle}` to keep old paths answering.
  ([docs](https://kody.codes/docs/package-apps),
  [#5349](https://github.com/kody-hq/kody/pull/5349))
- **Execute:** A saved package that uses a machine's named command or local
  network destination now fails with `machine_need_undeclared` until it declares
  the entry. **Action:** add the entry to `kody.machine` (the error carries the
  JSON) and publish. ([docs](https://kody.codes/docs/execution-contexts),
  [#5291](https://github.com/kody-hq/kody/pull/5291))
- **Credentials:** Ad hoc code, or a package not on a credential's allowed
  packages list, that puts a locked credential in its own request is now
  refused. **Action:** call an export of a listed package, or have the owner add
  the calling package. ([#5226](https://github.com/kody-hq/kody/pull/5226))
- **Credentials:** A declared credential need with an explicit empty, invalid,
  denied, or unusable mapping no longer falls back to a Key with the same name.
  **Action:** repair the mapping or move the call to a scoped client.
  ([#5421](https://github.com/kody-hq/kody/pull/5421))
- **CLI:** Local mock execute of inline code that uses `packageStorage` now
  errors. **Action:** move the storage code into a package export and run
  `kody execute --local --target mock --invoke <export>`.
  ([#5404](https://github.com/kody-hq/kody/pull/5404))
- **CLI:** `kody dev check` needs `@kodycodes/cli` 3.46.0 or newer, and
  `kody package publish` JSON always returns the final result. **Action:**
  update the CLI. ([#5355](https://github.com/kody-hq/kody/pull/5355))
- **Packages:** Packages published with `--build local` or `--build context` on
  CLI 3.35.11 through 3.35.14 that import `kody:@` packages have broken
  artifacts. **Action:** republish them with a current CLI.
  ([#5252](https://github.com/kody-hq/kody/pull/5252))
- **CLI:** Contexts on CLI daemons older than this week's release no longer take
  chain-routed or named publish builds. **Action:** run `kody daemon update`.
  ([#5423](https://github.com/kody-hq/kody/pull/5423))

## Try it

- Turn on execution contexts at `/account/experiments`, define a named command,
  and limit it to one package, as described in
  [Execution contexts](https://kody.codes/docs/execution-contexts).
- Open one of your package apps at its `{leaf}--{handle}.kody.run` origin and
  move your links before the cutover.
- Install Kody Desktop from [kody.codes/download](https://kody.codes/download).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
