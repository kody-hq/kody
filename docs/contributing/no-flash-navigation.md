# No-flash navigation

Router retains the committed page while the destination's required loaders run.
Query provides either cached data or the read that those loaders await. The
page, its document metadata, and its styles must remain consistent during that
transition.

## Data readiness

[`getRouter`](../../packages/worker/start/router.tsx) enables intent preloading
and blocking stale reloads. Router's preload stale time is zero because Query
owns payload freshness.

A route shares its query options between its loader and component. The loader
uses `loadPageQuery`; the component reads the same entry with `usePageQuery`. A
normal stale cache hit can render immediately and refresh in the background. A
cache miss or required authorization check keeps the committed page visible
until the destination is ready. Permission failures render the appropriate error
page instead of retaining unauthorized cached content.

[`page-query.ts`](../../packages/worker/start/page-query.ts) contains those
policies. [Web app rendering and server state](./tanstack-start.md) explains
identity checks, organization scoping, and mutation reconciliation.

## Document and styles

The root route's `shellComponent` owns the HTML document independently of loader
success. The loaded app layout owns the header, rail, footer, and page outlet.
Error and not-found components render inside that document.

[`PageHead`](../../packages/worker/start/components/page-head.tsx) follows the
committed page's exact Query cache reference, while Router retains
responsibility for document assets. A background payload update can update
metadata without another request or another copy of page data.

Feature styles belong to the rendered `FeaturePage` through Emotion `Global`.
The shared lazy feature component imports the stylesheet as raw CSS, so the
content and styles commit together and remain together while another route
loads. This moves 53,720 raw bytes (9,029 gzip before bundling) from a separate
stylesheet into feature JavaScript, and includes the styles inline on server
renders. It avoids a separate stylesheet request, at the cost of CSS in the
JavaScript payload and inline server HTML. Router alone does not guarantee that
an arbitrary external stylesheet has loaded before content paints.

[`history-navigation.spec.ts`](../../e2e/history-navigation.spec.ts) samples
computed color variables and layout every frame during slow, superseding, and
Back/Forward navigation, and verifies failed component loading recovers.
[`public-features.spec.ts`](../../e2e/start/public-features.spec.ts) also
samples the outgoing feature's computed style through Back navigation, so a
correct final screenshot alone cannot hide an intermediate unstyled frame.

## Motion and verification

[`navigation-motion.ts`](../../packages/worker/start/navigation-motion.ts) uses
Router events for view transitions. Persistent shells and reduced-motion
preferences constrain transitions. Link matching uses Router; the app does not
maintain a second click interceptor or navigation-data slot.

The browser suites cover account/admin navigation, query caching, document
metadata, and history. Their assertions check rendered content and data
freshness as well as the URL. Run them through `npm run test:e2e:run`; the full
local gate is `npm run validate`.
