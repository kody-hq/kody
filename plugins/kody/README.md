# Kody plugin for ChatGPT and Codex

This folder is the Kody plugin package, and
[`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) at
the root of this repository makes `kody-hq/kody` a plugin marketplace we can
update. Install Kody from here, not from the public ChatGPT plugin directory:
that listing is outdated and no longer updates, so uninstall it if you have it.

The plugin connects to the Kody MCP server at `https://kody.codes/mcp` with
OAuth. You sign in to Kody when you install it. The package holds no secrets.

## Codex CLI and IDE extension

```sh
codex plugin marketplace add kody-hq/kody --sparse .agents/plugins --sparse plugins/kody
codex plugin add kody@kody-hq
```

Start a new Codex session and sign in to Kody when asked. You can also run
`/plugins` in Codex and install Kody from the Kody marketplace tab. Run
`codex plugin marketplace upgrade kody-hq` to pick up plugin updates.

## Codex app and ChatGPT desktop app

1. Open Plugins and choose **Add plugin marketplace**.
2. Enter this source, then add the marketplace:

   ```text
   Source: kody-hq/kody
   Git ref: main
   Sparse paths:
   .agents/plugins
   plugins/kody
   ```

3. Open the **Kody** marketplace tab in the Plugins directory, install Kody, and
   sign in to Kody when asked.

## ChatGPT workspaces (Business, Enterprise, Edu)

A workspace admin imports the marketplace once, and members install Kody from
the workspace's plugins on ChatGPT web, desktop, and mobile:

1. Open **Admin** > **Plugins** and select **Add** > **Import marketplace**.
2. In **Source**, enter `https://github.com/kody-hq/kody`. Leave **Path** empty.
3. Select **Import marketplace** and authorize GitHub access when prompted.

New plugins are **Available** for installation, and members sign in to Kody when
they install it. See OpenAI's
[plugin management guide](https://learn.chatgpt.com/docs/enterprise/plugin-management).

## MCP only

Hosts without plugin marketplaces can add Kody as an MCP server instead. See
[Connect your agent](https://kody.codes/docs/use/connect-your-agent) or run:

```sh
codex mcp add kody --url https://kody.codes/mcp
```
