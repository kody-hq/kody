# Public marketing pages

Public homepage, pricing, FAQ, case studies, beliefs, support, legal, docs,
blog, Discord invite.

## How to get there

`/`, `/for/business`, `/pricing`, `/faq`, `/case-studies`, `/believe`,
`/with/:agent`, `/support`, `/about`, `/contact`, `/privacy`, `/terms`, `/docs`,
`/docs/:slug`, `/docs/connect`, `/llms.txt`, `/blog`, `/blog/:slug`, `/discord`.
Legacy `/guides*` URLs 308 to `/docs*`. Intra-docs navigation (doc to doc, or a
doc to `/docs` / `/docs/connect`) is an instant shell swap — no page
view-transition — so the sidebar does not re-animate. How Kody works (and other
interactive walkthroughs) stay in the article column; they do not break out over
the nav. The docs shell opts out of overflow anchoring so replacing the article
does not bump the rail. After hydrate it independently prefetches every sidebar
href (one loader request per slug, including `/docs/connect`) so a click adopts
a warm payload instead of waiting on a cold fetch. `/docs/package-skills` opens
with a flag callout for `mcp-skills-extension`: signed-in visitors use its
native opt-in server function to turn it on for themselves; signed-out visitors
log in with `redirectTo` back to that page. `/docs/mcp-events` does the same for
`mcp-events-extension` through its native opt-in server function. Custom secret
providers are documented at `/docs/secret-providers`. Open API is documented at
`/docs/open-api`; versioning at `/docs/api-versioning`; local CLI execute at
`/docs/local-execute`.

## Drive it

```bash
node tools/control-kody.ts health --origin https://kody.codes
node tools/control-kody.ts request GET /docs.json --skip-login --origin https://kody.codes
```

Anonymous HTML on `/` and several marketing routes is short-CDN-cached. The
cache key includes the query string, so `/?accountDeleted=1` is its own document
and shows "Your Kody account has been deleted"
(`data-testid="account-deleted-notice"`). Weekly site-perf owns landing budgets.
The `/` hero is centered: headline, subhead, an endlessly scrolling row of 64px
monochrome agent marks (SSR-shuffled `landingAgentOrder`, fades at both edges,
drifts until hovered, focused, scrolled, swiped, or dragged, magnifies marks by
pointer distance like the macOS Dock so gaps never shrink them (reduced motion
zooms only the hovered mark); one tab stop with arrow keys, Home, and End
between marks), and one "Connect your agent" CTA that copies an agent-led setup
prompt (without JavaScript it is a link to `/docs/connect-your-agent`). Each
mark links to `/with/:agent`, a short page for that agent with its shortest
connect steps (copyable commands), a setup-prompt button, and links to the other
agents. Agents without an official Kody path (`official: false`) lead with the
setup prompt and the MCP URL instead. Slugs come from `universal/with-agents.ts`
and unknown slugs 404. The homepage never links to `/onboarding` or `/signup`,
for any session. Below the hero come "Primitives for your agents" cards, "What
Kody is and is not", the agent orbit beside the example walkthrough,
testimonials, the team git/npm section, the first-party YouTube light player
with a horizontal video chooser, and the "Invisible software" close linking to
`/believe`. The interactive five-orb lantern lives on `/features`; the homepage
orbit keeps its decorative lantern. Feature pages are `/features/memory`,
`/features/packages`, `/features/triggers`, `/features/credentials`, and
`/features/apps`; `/features/secrets` and `/features/integrations` 301 to
`/features/credentials`. Signed-in visitors still see the player and chooser.
Chooser membership and order come from the unlisted playlist `PLBPBUA8boGLA`.
Client navigations use the native landing video read. The lite player embeds the
selected chooser video only, without a playlist id, so YouTube chrome uses that
video's title. Chooser ids are on the YouTube allowlist for `/youtube-thumb`
without a playlist round-trip on plain documents. `/?youtubeId=<id>` opens the
site-wide allowlisted YouTube overlay on those routes; unknown or disallowed ids
do not open the player.

## APIs

- `GET /docs.json`
- `GET /blog.json`
- `GET /discord.json`
- `GET /landing-hero-videos.json`
