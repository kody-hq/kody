# Website process flows

These diagrams describe the migration working tree, not a claim that every flow
has passed deployed parity testing. They describe website infrastructure, not
the internal execution of every package or background job.

## Who owns what

| Concern                                                               | Owner                                | Boundary                                                 |
| --------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| HTTP document handling and website RPC transport                      | Start                                | Native file routes and typed server functions            |
| Matching, URL/search state, navigation, preload, scroll, route errors | Router                               | Loaders coordinate readiness, not a second payload cache |
| Reusable server data, freshness, mutation status and reconciliation   | Query                                | Keys include actor and resource scope                    |
| Rendering, local drafts and component lifecycle                       | Redact through React-compatible APIs | Local UI state is not authoritative saved data           |
| Identity, permissions, write leases, audit events and business rules  | Kody server/domain code              | Enforced on each operation, independent of the UI        |
| Durable records and objects                                           | Existing database/storage services   | The migration does not require a new data model          |
| Cookie, schema, table and HTML helpers                                | Retained Remix leaf utilities        | No website routing or action dispatch ownership          |

## 1. Initial page request and hydration

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Start
    participant R as Router
    participant Q as Request QueryClient
    participant D as Authorized domain reads
    B->>S: GET document URL
    S->>R: Create request router and match file route
    R->>Q: Loader requests resource query
    Q->>D: Read through server boundary
    D-->>Q: Authorized data
    Q-->>R: Data and readiness
    R-->>S: Render document and head with Redact
    S-->>B: HTML and streamed Query state
    B->>B: Hydrate browser router and QueryClient
```

Each server request gets its own QueryClient. The browser retains its own client
across navigation. Successful and pending queries can be dehydrated for
streaming; settled authorization errors are not reusable hydration data.

## 2. Navigation and private access

```mermaid
flowchart TD
    A[Link, back button or URL change] --> B[Router matches destination]
    B --> C[Root identity and organization access check]
    B --> D[Destination loaders request Query resources]
    D --> E[Each server read independently authorizes]
    C --> F{Access allowed?}
    F -->|No| G[Redirect or access error]
    F -->|Yes| H[Wait for required destination data]
    E --> H
    H --> I[Commit matched page, head and scroll state]
```

Identity checks and destination reads start concurrently. Private warm
navigation can reuse data but still checks access. Known static public pages
skip that check. Permission-sensitive resources explicitly require fresh
foreground authorization. Retained pages use their matched location while the
next navigation is pending.

## 3. Repeated reads and performance

```mermaid
flowchart TD
    A[Loader or mounted component] --> B[Same normalized resource query key]
    B --> C{Cache state}
    C -->|Fresh| D[Reuse data]
    C -->|Stale| E[Render retained data and revalidate]
    C -->|Missing| F[Wait for authorized server read]
    C -->|Explicitly invalidated| G[Fetch authoritative state]
    E --> H[Query updates subscribed views]
    F --> H
    G --> H
```

Default freshness is 30 seconds and inactive cache retention is 5 minutes, with
resource-specific overrides possible. Query owns freshness even for intent
preloads. Automatic retries are disabled by default. Cancellation belongs to the
query, not an individual navigation that might share it.

Performance comes from reuse, deduplication and starting independent reads
together. More granular reads are not automatically faster: email detail uses
parallel list, detail and destination RPCs, trading reuse for more requests.
Production performance still needs matched measurements.

## 4. Website mutation

```mermaid
sequenceDiagram
    participant U as Form and local draft
    participant Q as Query mutation
    participant S as Typed Start server function
    participant K as Kody authorization and domain code
    participant DB as Durable storage
    U->>Q: Submit operation with captured actor and scope
    Q->>S: Typed input
    S->>S: Validate input, CSRF and document identity
    S->>K: Authenticate and bind explicit organization
    K->>K: Check permission and lifecycle/write protections
    K->>DB: Perform operation
    DB-->>K: Write result
    K-->>S: Operation outcome
    S-->>Q: Outcome, not reconstructed page
    Q->>Q: Patch relevant entity and reconcile queries
    Q-->>U: Pending status and guarded UI feedback
```

The organization is explicit validated input, not inferred from Referer. Shared
domain code retains resource authorization, relevant rate limits and audit
events. Normal website writes use an account write lease; account deletion has
its own exclusive lifecycle lock. Private responses use `private, no-store`.

## 5. Optimism, failures and navigation during a write

```mermaid
flowchart TD
    A[Mutation captures exact resource scope] --> B[Show pending or optimistic UI]
    B --> C[Server attempts write]
    C --> D{Response received?}
    D -->|Success| E[Apply confirmed entity result]
    D -->|Error or lost response| F[Do not assume server rolled back]
    E --> G[Reconcile captured resource queries]
    F --> G
    G --> H[Authoritative state replaces temporary UI]
    A --> I[Submitter may navigate away]
    I --> J[Mutation lifecycle still reconciles]
    I --> K[Old submitter cannot reset a new draft or navigate it]
```

Pending mutations supply temporary presentation state over Query's saved data.
Reads continue independently, including first navigation reads. Settlement
preserves those first-read promises, then confirms the captured actor and
resource scope, including inactive queries and writes whose responses were lost.
There is no global table that blocks reads by mutation family.

## 6. State ownership

```mermaid
flowchart LR
    A[URL and typed search parameters] --> B[Router matched page]
    B --> C[Normalized resource identity]
    C --> D[Query saved server state]
    E[Local draft, open dialog, typed search text] --> F[Rendered UI]
    D --> F
    G[Query mutation status and variables] --> F
    E --> H[Submit]
    H --> G
    G --> I[Server operation and reconciliation]
    I --> D
```

Presentation-only filters can change the URL without fetching the same data
again. Draft text can retain whitespace while query inputs normalize it. Secrets
and one-time credential or invite reveals stay outside reusable page caches.
Pending controls follow mutation status, not a local flag that can get stuck
when navigation changes.

## 7. Tab activation, session changes and refresh

```mermaid
flowchart TD
    A[Window activation or reconnect handling] --> B[Verify current identity]
    B --> C{Same authorized actor?}
    C -->|Yes| D[Refresh eligible private queries]
    C -->|No| E[Handle identity change and protected cache access]
    E --> F[Require current identity before private data renders]
    D --> G[Updated subscribed views]
```

Default Query focus/reconnect refetches are disabled. Kody's activation handler
checks identity first. Query metadata carries actor identity so refresh and
permission invalidation do not depend on a registry of page names.

## 8. One-time links, redirects and SEO

```mermaid
flowchart TD
    A[Incoming URL] --> B[Start file route]
    B --> C{URL purpose}
    C -->|Document| D[Router loader and head metadata]
    C -->|Legacy bookmark| E[Permanent redirect to canonical route]
    C -->|Signed or one-time flow| F[Foreground authorized loader]
    F --> G[Validate token and perform intended operation]
    G --> H[Result page or redirect]
    D --> I[Server-rendered HTML and navigation head updates]
    C -->|Crawler or feed| J[Explicit HTTP response]
```

One-time results do not enter a reusable resource cache. HEAD cannot consume
signed verification links. A failed request is not dispatched again to render an
error, since its operation may already have committed. Redirects, metadata and
token flows still need parity verification, not just a successful build.

## 9. External protocols and shared business logic

```mermaid
flowchart LR
    W[Website UI] --> S[Start server functions]
    X[Provider, browser asset or external tool] --> H[Explicit Start HTTP route]
    A[Official API or MCP consumer] --> P[Existing protocol worker]
    S --> D[Shared authorized business operations]
    H --> D
    P --> D
    D --> DB[Existing durable services]
```

External OAuth callbacks, webhooks, downloads, assets, discovery and health URLs
retain HTTP contracts. They do not justify a second website action router. See
[the endpoint inventory](./tanstack-start-http-contracts.md) for exact methods,
paths and consumers. User-authored package apps remain a separate runtime
concern.

## 10. Verification and deployment

```mermaid
flowchart TD
    A[Inspect code] --> B[Static review and checks]
    B --> C[Commit and open PR]
    C --> D[CI tests and build]
    C --> E[Normal PR preview deployment]
    D --> F[Inspect failures and fix root cause]
    F --> B
    E --> G[Verify deployed commit and preview behavior]
    D --> H[Local control-kody on changed surfaces]
    G --> I[Explicit merge and production approval]
    H --> I
```

Local verification uses [control-kody](./control-kody.md). CI success does not
prove visual or authenticated action parity. Use a PR preview only when local
cannot exercise the change.

## 11. Anonymous document caching

```mermaid
flowchart TD
    A[Start matches native route] --> B[Route declares anonymous cache policy]
    B --> C{Request eligible?}
    C -->|Session, authorization, referral or excluded request| D[Run authorized loaders and render]
    C -->|Anonymous GET or HEAD| E[Look up deployment-specific cache key]
    E -->|Miss| D
    E -->|Hit| F[Skip document loaders]
    D --> G{Successful complete response without cookies?}
    G -->|Yes, opted-in route| H[Store document with its matching CSP]
    G -->|No| I[Do not store]
    F --> J[Rewrite cached markup to current request nonce]
    H --> K[Deliver response]
    I --> K
    J --> K
    K --> L[HTML is private, no-store in the browser]
```

Native route metadata owns eligibility and the marketing or visibility-sensitive
TTL. Cache keys include the Worker version so a deployment cannot replay old
asset references. Cached HTML receives a fresh nonce that matches the delivered
CSP. HEAD returns no body and does not populate the cache. Method guards reject
actionable HEAD requests before document loaders. This lifecycle awaits CI
verification; it is not yet deployed evidence.

Implementation details and source links:
[web architecture](./tanstack-start.md).
