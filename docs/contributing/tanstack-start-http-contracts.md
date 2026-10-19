# Retained HTTP contracts

Website reads and mutations use native Start functions. These explicit HTTP
routes remain because browsers, crawlers, tools, providers, or downloadable
assets need a stable URL. They are registered in `packages/worker/start/routes`,
not a second backend router. GET routes also support HEAD unless consuming a
token.

Website consent, denial, inline login and client reset use
`submitOAuthDecision`, a native Start server function. The retained OAuth POST
and that function share the authorization operation, preserving the external
protocol contract without sending website mutations through its HTTP adapter.

| Method | Path                                                          | Consumer                                                                |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/oauth/authorize`                                            | OAuth clients, consent document and silent authorization, HEAD rejected |
| POST   | `/oauth/authorize`                                            | MCP client consent and inline login protocol                            |
| GET    | `/oauth/callback`                                             | OAuth client callback document, error status preserved                  |
| GET    | `/robots.txt`                                                 | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/sitemap.xml`                                                | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/auth.md`                                                    | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/.well-known/mcp/server-card.json`                           | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/.well-known/api-catalog`                                    | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/.well-known/agent-skills/index.json`                        | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/.well-known/agent-skills/:skillId/SKILL.md`                 | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/.well-known/security.txt`                                   | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/.well-known/openai-apps-challenge`                          | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/health`                                                     | Deployment and uptime checks                                            |
| GET    | `/health/components`                                          | Deployment and uptime checks                                            |
| POST   | `/sentry-tunnel`                                              | Browser error-reporting protocol                                        |
| GET    | `/og/:page.png`                                               | Browser assets and previews                                             |
| GET    | `/blog/rss.xml`                                               | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/blog/:slug.md`                                              | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/blog/:slug/og.png`                                          | Browser assets and previews                                             |
| GET    | `/docs.md`                                                    | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/docs/llms.txt`                                              | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/docs/connect.md`                                            | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/docs/:slug.md`                                              | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/docs/:slug/og.png`                                          | Browser assets and previews                                             |
| GET    | `/llms.txt`                                                   | Discovery, crawlers, feeds, or machine-readable documentation           |
| GET    | `/youtube-thumb/:videoId`                                     | Browser assets and previews                                             |
| GET    | `/account/export.json`                                        | Authenticated file download                                             |
| GET    | `/account/mcp-servers/logos/:serverId`                        | Browser assets and previews                                             |
| GET    | `/account/mcp-servers/oauth/callback`                         | External OAuth redirect                                                 |
| GET    | `/account/memories-export.json`                               | Authenticated file download                                             |
| GET    | `/account/packages.json`                                      | Retained client assets (package list JSON during asset retention)       |
| POST   | `/account/packages.json`                                      | Retained client assets (package mutations during asset retention)       |
| GET    | `/community/:listingId/raw(/*relativePath)`                   | Package source and README asset consumers                               |
| GET    | `/@:username/:kodyId/raw/:ref(/*relativePath)`                | Package source and README asset consumers                               |
| GET    | `/@:username/:kodyId/assets(/*relativePath)`                  | Package source and README asset consumers                               |
| GET    | `/community/:listingId/assets(/*relativePath)`                | Package source and README asset consumers                               |
| GET    | `/community/:listingId/icon/:iconCommit`                      | Browser assets and previews                                             |
| GET    | `/@:username/:kodyId/icon/:iconCommit`                        | Browser assets and previews                                             |
| GET    | `/account/repos/:repoId/icon/:iconCommit`                     | Browser assets and previews                                             |
| GET    | `/integrations/logos/:integrationSlug`                        | Browser assets and previews                                             |
| GET    | `/integrations/provider-marks/:slug`                          | Browser assets and previews                                             |
| GET    | `/community/:listingId/og.png`                                | Browser assets and previews                                             |
| GET    | `/orgs/:orgSlug/avatar/:hash.:ext`                            | Browser assets and previews                                             |
| GET    | `/profiles/:username/avatar/:hash.:ext`                       | Browser assets and previews                                             |
| GET    | `/profiles/:username/og.png`                                  | Browser assets and previews                                             |
| POST   | `/@:username/webhooks/:packageKodyId/:webhookName/:urlSecret` | External webhook sender                                                 |
| POST   | `/webhooks/stripe`                                            | External webhook sender                                                 |
| POST   | `/unsubscribe/tips`                                           | Mail providers using RFC 8058 one-click unsubscribe                     |
| POST   | `/auth`                                                       | CLI and preview authentication tooling                                  |
| GET    | `/auth/:provider/callback`                                    | External OAuth redirect                                                 |
| GET    | `/session`                                                    | CLI and preview authentication tooling                                  |

HTML and Markdown negotiation share native document routes. Permanent legacy
Guides and organization Connections redirects remain for bookmarks and search
engines. Signed email links, OAuth consent, and the Stripe checkout return
retain their public URLs and run their existing one-time operations through
Start.

The origin worker still owns MCP, OAuth/OIDC, WebSocket upgrades, package-app
hosting, and worker infrastructure protocols before website dispatch. The API
worker owns the official REST API. These are independent of website routing.

Most retired `/account/*.json`, `/admin/*.json`, and public JSON companion
routes are not a supported API. Use the official API or MCP for automation, and
the website UI (native Start server functions) to verify browser mutations.
`/auth` and `/session` remain explicit tooling exceptions.
`/account/packages.json` is retained so hashed client assets from the
asset-retention window can still mutate packages; new UI must not add callers to
other retired companions.

Website consent uses the `submitOAuthDecision` Start server function. It shares
approval, denial and client reset operations with `POST /oauth/authorize` while
keeping the original request for identity and cookie checks. The POST endpoint
remains for `tools/mcp-oauth-client.ts`, which submits authorization decisions
as an external MCP OAuth client. The site does not post to that endpoint.
