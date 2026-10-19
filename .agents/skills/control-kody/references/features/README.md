# Feature Map

Verification notes for Kody surfaces. Routes come from
`packages/worker/start/routeTree.gen.ts` (`FileRoutesByFullPath`); this
directory only holds how to seed, reach, and assert each area. Load **one** file
for the surface you are changing.

```bash
npm run control-kody -- map
npm run control-kody -- map waiting
npm run control-kody -- map --check
```

`map` prints the generated inventory (kind + path), grouped by feature prefixes
in `tools/control-kody/feature-catalog.ts`. `map --check` fails when notes cite
unknown routes, a required user-facing prefix has no notes (and no exemption),
or a notes file is missing / orphaned. CI runs the same check via
`npm run feature-map:check`.

## Surfaces

- [login](./login.md)
- [signup](./signup.md)
- [onboarding](./onboarding.md)
- [password-reset](./password-reset.md)
- [two-factor](./two-factor.md)
- [passkeys](./passkeys.md)
- [account](./account.md)
- [connections](./connections.md)
- [packages](./packages.md)
- [secrets](./secrets.md)
- [integrations](./integrations.md)
- [mcp-servers](./mcp-servers.md)
- [jobs](./jobs.md)
- [workflows](./workflows.md)
- [webhooks](./webhooks.md)
- [follows](./follows.md)
- [activity](./activity.md)
- [waiting](./waiting.md)
- [experiments](./experiments.md)
- [memories](./memories.md)
- [email](./email.md)
- [billing](./billing.md)
- [admin](./admin.md)
- [community](./community.md)
- [marketing](./marketing.md)

## Seed users

| Environment | Email               | Password    | Notes                                   |
| ----------- | ------------------- | ----------- | --------------------------------------- |
| Local       | `jane@example.com`  | `ilikecode` | Non-admin. Prefer this.                 |
| Local       | `kody@example.com`  | `ilikecode` | Admin. Avoid unless needed.             |
| Preview     | `me@kentcdodds.com` | `ilikecode` | Non-admin. Empty until you create data. |

Runnable `request` / `browse` examples use `/@jane` (local). On preview, use
`/@user-me` instead. Assert sections keep inventory placeholders
(`/@{$orgSlug}`, `/@{$username}`).
