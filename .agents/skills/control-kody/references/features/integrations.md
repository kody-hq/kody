# Integrations and OAuth connect

Saved OAuth connections and the hosted connect start.

## How to get there

`/@<slug>/-/integrations` → `/@<slug>/-/integrations/:integrationName`. OAuth
apps: `/@<slug>/-/integrations/apps/:appSlug`. One-click grant:
`/@<slug>/-/integrations/approve`. Start connect: `/connect/oauth`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/integrations
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

`/connect/oauth` remains a browser flow and requires a real provider client.

## Gotchas

- Cloud Agents cannot complete a third-party OAuth dance without credentials in
  the environment. HTTP list/empty-state is the usual proof.
- `/docs/connect` is the public how-to, not the account page.
- OAuth access/refresh tokens and app client secrets live as AES-GCM ciphertext
  on `user_integrations` / `user_oauth_apps`, not as user secret-store rows.
- After a successful `/connect/oauth`, the success page shows a **What's next?**
  prompt the user can copy into chat. Agents `communitySearch` (prefer
  `trusted`) or create a helpers package.
- Account Integrations **Connect with Kody**, the `/connect/oauth` chooser,
  onboarding Step 2 featured buttons, and `integrationPlatformAppList` show only
  enabled + published platform apps. Draft apps stay hidden and keep serving
  existing connections. Never disable an app to hide it — move it to draft.
  Admins flip `enabled` and `visibility` separately on
  `/admin/platform-integrations`.
