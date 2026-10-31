# Connect your agent

Kody is an MCP server. You use it from Cursor, ChatGPT, Codex, Claude Desktop,
Grok.com, Grok CLI, Grok Bot, Claude Code, OpenCode, OpenClaw, Hermes Agent,
Muse, Wajo, Cue, OpenMuse, Dots, Devin, Gemini, GitHub Copilot (VS Code or CLI),
the GitHub Copilot app, or any other AI agent that supports MCP — not from a
separate Kody chat app.

The three-step Get started flow lives in
[Connect your agent](../guides/connect-your-agent.md) and on `/onboarding`. This
page is the per-host install reference.

Agents discovering this host can read `/auth.md` for the OAuth registration
block and MCP URL, and `/.well-known/mcp/server-card.json` for the server card.

## Add the MCP server

1. Open Get started (`/onboarding`).
2. Choose the agent you want to connect.
3. Follow that host's steps (plugin, vendor CLI, or the MCP URL). Preview and
   local origins use that deployment's MCP URL (`https://<this-host>/mcp`). On
   [kody.codes](https://kody.codes) the MCP URL is `https://kody.codes/mcp`.
4. Complete the OAuth flow when the host opens it. Sign in or create an account
   if needed, then approve access. Approving gives that agent full access to
   this Kody account — not a limited permission set.

Once signed in, Account → Agents (`/@<slug>/-/agents`) is the durable home for
this: it lists every agent that has authorized (with revoke and **View connect
steps** for known hosts), shows the MCP URL with a copy button, and **Connect an
agent** opens `/@<slug>/-/agents/new` with the same per-host steps as Get
started for every agent Kody knows how to connect — including hosts that are
already connected, so you can re-view install steps for a second login, new
machine, or reinstall.

Your account email must be verified before authorize can finish or MCP can run.
If authorize asks you to verify, keep that tab open, finish verification (from
the email link or `/pending-verification`), then continue. You do not need to
restart the host connection. Unverified visits to Get started (`/onboarding`)
redirect to `/pending-verification`; after verification, onboarding shows the
MCP URL and setup prompt.

### Client notes

Get started shows one host at a time after you pick it. Use **Not listed** when
your agent is not in the featured chooser (More hosts are listed there), or when
you only have the MCP URL.

- **Cursor** — Install the official
  [Kody plugin](https://cursor.com/marketplace/kody), or in Cursor chat run
  `/add-plugin kody`. After install, Authenticate in the Cursor MCP list.
- **Claude Desktop** — Copy the MCP URL into Settings → Connectors (custom
  connector). Remote servers are not configured through
  `claude_desktop_config.json`. After connecting, start a new chat and ask
  Claude to list Kody tools before the first task — Claude Desktop often does
  not bind MCP tools until that next turn.
- **Grok.com** — On [grok.com/connectors](https://grok.com/connectors), click
  **New Connector**, select **Custom**, and paste the MCP URL. Complete OAuth
  when prompted. For Grok Business and Enterprise, a team admin must first add
  this custom MCP server in the cloud console; members can then connect it from
  the Grok connectors page. See xAI's
  [custom MCP connector docs](https://docs.x.ai/grok/connectors).
- **Grok CLI** — `grok mcp add --transport http --scope user kody <url>`. That
  writes `~/.grok/config.toml`. OAuth opens a browser on first use; in the TUI,
  `/mcps` then `i` authenticates. `grok mcp doctor kody` checks the connection.
  See xAI's [Grok CLI MCP docs](https://docs.x.ai/build/features/mcp-servers).
- **Grok Bot**: Grok Bot is Cursor's desktop assistant, not grok.com. Start from
  the [Kody Bot template](https://x.ai/bot/yTSGElYcIjFW_5IXu2I-e). It ships with
  the Kody plugin, mints its own long-lived Kody CLI credential so you never
  copy a token, installs `@kodycodes/cli`, runs `kody auth setup-git`, and
  includes skills for setup, the CLI workflow, search, and Kody foundations,
  plus a first-chat onboarding. Complete **Authorize** when Grok Bot asks to
  connect Kody. To add Kody to a Grok Bot you already use instead, add the
  official Kody plugin with
  [`grokbot://app/v1/plugin/add?id=56286216`](grokbot://app/v1/plugin/add?id=56286216),
  or open **Plugins** in the Grok Bot sidebar and add Kody. See Cursor's
  [Grok Bot plugin help](https://cursor.com/help/grok-bot/connect-plugins).
- **Claude Code** — After the CLI writes the remote entry, enter `/mcp` → Kody →
  Authenticate. Manual includes
  `claude mcp add --transport http -s user kody <url>`, or a `.mcp.json` entry
  with `"type": "http"`.
- **ChatGPT.com** — This is the web app. On [kody.codes](https://kody.codes),
  add the
  [Kody ChatGPT plugin](https://chatgpt.com/plugins/plugin_asdk_app_6a95fefc5c1081919756fdd35dd918ee)
  from the ChatGPT plugin directory, then complete OAuth when ChatGPT prompts
  you. That listing talks to production. Preview and local Get started keep the
  developer-mode app as the primary step so OAuth hits this deployment. You need
  an
  [eligible paid plan (Plus, Pro, Business, Enterprise, or Education)](https://developers.openai.com/api/docs/guides/developer-mode).
  In a managed workspace, ask an admin to enable plugins if the directory is
  missing. ChatGPT desktop is Codex — use that entry instead.

  <details>
  <summary>Or create a developer-mode app</summary>

  Turn on Developer mode (Settings → Security and login), then create an app
  under Settings → Plugins → Browse plugins → Create app with the MCP URL. Use
  the connector icon (`/images/kody-app-icon.png`, 256×256 and under ChatGPT's
  10 KB limit) — right-click Save as on the connect page, then upload it. The
  owner can edit a developer-mode app's name and logo later from Manage in Apps
  settings.

  </details>

- **Codex** — ChatGPT desktop is Codex. On [kody.codes](https://kody.codes), add
  the same
  [Kody ChatGPT plugin](https://chatgpt.com/plugins/plugin_asdk_app_6a95fefc5c1081919756fdd35dd918ee),
  then complete OAuth when ChatGPT prompts you. Preview and local Get started
  keep **Open Codex** / the CLI with this deployment's MCP URL.

  <details>
  <summary>Or add Kody as a Codex MCP server</summary>

  Get started offers **Open Codex** (`codex://mcp/add?name=kody&url=<url>`) so
  the desktop app launches when that protocol is registered. After the CLI
  writes the shared config, run `codex mcp login kody` if OAuth does not start.
  Manual includes `codex mcp add kody --url <url>` and the shared
  `~/.codex/config.toml` `[mcp_servers.kody]` `url` entry. If Codex asks you to
  log in again after about an hour, see
  [Codex keeps asking for `codex mcp login kody`](./troubleshooting.md#codex-keeps-asking-for-codex-mcp-login-kody).
  On a remote machine or VM, see
  [Remote or headless machines](#remote-or-headless-machines). If authorize says
  Kody could not load Codex's details, see
  [Authorize says Kody couldn't load the app's details](./troubleshooting.md#authorize-says-kody-couldnt-load-the-apps-details).

  </details>

- **OpenCode** — After the CLI writes the remote entry, run
  `opencode mcp auth kody` if prompted. Manual includes
  `opencode mcp add kody --url <url>` and a `mcp.kody` remote entry in
  `opencode.json` (`"type": "remote"`). On a remote machine or NAS, see
  [Remote or headless machines](#remote-or-headless-machines).
- **Copilot** — After the CLI writes the remote entry, complete OAuth in that
  host. Manual includes `copilot mcp add --transport http kody <url>`. In VS
  Code Copilot Chat, use Add to VS Code or `.vscode/mcp.json` with root key
  `servers` (not `mcpServers`) and `"type": "http"`, then Agent mode. You can
  also merge a `mcpServers` entry into `~/.copilot/mcp-config.json` (CLI does
  not read `.vscode/mcp.json`).
- **Copilot App** — In the GitHub Copilot app, open settings → **MCP Servers**
  and add a custom remote HTTP server with the MCP URL. Servers from Copilot CLI
  or repository MCP config are also available in the app.
- **Devin** — In Devin Desktop, add a custom remote MCP server and paste the MCP
  URL. Complete OAuth when Devin opens it. The same connector works from the
  mobile-friendly web app. Sessions created through the Devin API or run by a
  Devin service user cannot use a Personal OAuth MCP connection. Devin keeps the
  personal token under the human user, so those sessions report "requires OAuth
  authorization" even when Kody issued a valid token. Set the Kody MCP server in
  Devin to Organization access (Customize, then MCPs) and connect it once, or
  create sessions on behalf of the user with Devin's `create_as_user_id`. The
  service user must have `ImpersonateOrgSessions`; that attribution alone does
  not establish Personal OAuth MCP eligibility.
- **Gemini** — In the Gemini app or Jules, add a custom MCP connector and paste
  the MCP URL. Complete OAuth when Google prompts you.
- **OpenClaw** — Run
  `openclaw mcp add kody --url <url> --transport streamable-http --auth oauth`,
  then `openclaw mcp login kody`. `openclaw mcp doctor kody --probe` checks the
  live connection. Or in the Control UI: Settings → MCP → Add server, choose
  Streamable HTTP, and paste the MCP URL. See OpenClaw's
  [MCP docs](https://docs.openclaw.ai/tools/mcp).
- **Hermes Agent** — On the machine that runs
  [Hermes](https://github.com/NousResearch/hermes-agent), run
  `hermes mcp add kody --url <url> --auth oauth`. Hermes opens the Kody sign-in
  while it tests the connection, asks which tools to enable, and saves the
  server under `mcp_servers.kody` in `~/.hermes/config.yaml` (`url` plus
  `auth: oauth`). OAuth tokens stay out of that file, in
  `~/.hermes/mcp-tokens/kody.json`. If you edit `config.yaml` by hand, run
  `hermes mcp login kody` from a fresh terminal, then `/reload-mcp` in open
  sessions. `hermes mcp test kody` checks the connection. For a headless server,
  see Hermes's
  [OAuth over SSH guide](https://hermes-agent.nousresearch.com/docs/guides/oauth-over-ssh)
  and
  [MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).
- **Muse** — [Muse Code](https://dev.meta.ai/docs/muse-code/) reads MCP from
  `~/.config/muse/settings.json` under `mcp_servers`. Add a remote
  `streamable_http` server with this deployment’s MCP URL (see
  [Muse extending docs](https://dev.meta.ai/docs/muse-code/extending/)), then
  run `muse mcp login kody`. Do not paste `npx @kodycodes/cli install` into Muse
  chat — that runs in Muse's Linux VM and cannot configure Muse. After OAuth
  succeeds, headless Muse may ask you to paste a localhost URL into the Muse
  chat.
- **Wajo** — [Wajo](https://wajo.ai) (Fo) connects ChatGPT and Claude through
  Wajo sign-in. Paste the MCP URL where Wajo asks for a custom MCP server, then
  complete OAuth.
- **Cue** — [Cue](https://cue.im) (personal AI agents by Manus). When Cue
  exposes a custom MCP connector, paste the MCP URL and complete OAuth.
- **OpenMuse** — CopilotKit's self-hosted personal agent (not Muse Code).
  OpenMuse does not ship a one-click Kody connector; wire Kody into the harness
  behind your fork. See [OpenMuse and Kody](/docs/openmuse).
- **Dots** — [OpenAI Dots](https://openai.com/index/introducing-dots/). When
  Dots exposes a custom MCP connector, paste the MCP URL and complete OAuth.
- **Open WebUI** — Add an MCP Streamable HTTP connection to this deployment’s
  MCP URL and use **OAuth 2.1** (dynamic registration) first. Enabling the tool
  in a chat must open the Kody authorize window. If that window never opens on
  one browser or device, retry from another. Hosts that need a pre-registered
  confidential client can use **OAuth 2.1 (Static)** with a client minted at
  Workspace → Agents → Advanced → MCP OAuth clients. Register the exact Open
  WebUI callback (`{open-webui}/oauth/clients/mcp:{connection-id}/callback`) and
  set OAuth Server URL to this deployment’s origin when discovery from the MCP
  URL is not enough.

### Remote or headless machines

MCP OAuth finishes on a loopback callback (`127.0.0.1`) on the machine that runs
the agent. When that is a remote VM or NAS, your browser cannot reach it. Codex
and OpenCode have no device-code login for MCP, and Kody API tokens do not work
on `/mcp`. See
[Authorizing from a remote or headless machine](./troubleshooting.md#authorizing-from-a-remote-or-headless-machine)
for Codex `--no-browser`, OpenCode port forward, and `kody login --device`. Keep
callbacks on loopback and never expose a callback port publicly.

### Coding vs non-coding agents

Using packages that already exist works well from non-coding agents. Creating or
editing packages is smoother from a coding agent because those hosts edit files
and iterate on code. Either kind can be first; see
[Connect your agent](../guides/connect-your-agent.md#which-agent-should-go-first).

## Where to go next

- [Connect your agent](../guides/connect-your-agent.md) — Steps 2 and 3 after
  this host is connected
- [First steps](./first-steps.md) — search-first habits and common goals
- [Troubleshooting](./troubleshooting.md) — auth, empty results, and approvals
