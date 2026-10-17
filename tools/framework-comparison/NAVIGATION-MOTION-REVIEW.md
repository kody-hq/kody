# Navigation motion parity review

The initial review was source-only during edge measurements. Restoration and
subsequent browser evidence are recorded in
[Router motion patch](./ROUTER-MOTION-PATCH.md).

The original client sets `html[data-spa-nav]` before the first SPA DOM swap.
`public/styles.css:473` then stops applying the full-document `data-rise`
entrance animation. Without that marker, returning to home can replay a 700 ms
animation plus its stagger. Before restoration, the native router did not set
the marker and did not opt into view transitions. Navigation timing comparisons
from that earlier stage therefore did not compare identical motion policy. The
final private edge series runs after restoration and browser verification.

The original policy in `client/client-router.tsx:180` animates real page changes
except reduced motion, same pathname/search, transitions within each account,
admin or docs area, onboarding step changes, same-profile filters, and package
repository chrome changes. Its scheduler also skips active animations,
serializes update callbacks, drops superseded swaps, handles lifecycle promise
rejections, and falls back to an immediate swap if the browser API throws.

## Supported application APIs

The installed Router exposes `router.subscribe('onBeforeNavigate', listener)`
and `router.update({ defaultViewTransition: boolean })`. Its event includes
`fromLocation`, `toLocation`, `pathChanged`, `hrefChanged`, and `hashChanged`.
Prefer `router.update` over direct writes to `router.options`.

A browser-only subscription installed when creating the router can compute the
original pure policy from pathname plus search, excluding hash, and update the
boolean default before loading. Extract the existing pure policy into a shared
module instead of importing the original client router and its side effects. Do
not add a second list of shell and package rules.

In the installed `load-client.ts:1953`, `onBeforeNavigate` fires at foreground
load preflight. It is used for history loads, normal navigation, and the
replacement load after a redirect. Preloads do not use that foreground event. A
superseded transaction is checked before committing at lines 1848 and 1867, so
it cannot later apply an old policy by committing its obsolete page. This
supports a per-navigation boolean default for the current app, which has no
explicit `viewTransition` overrides.

`router.subscribe('onBeforeRouteMount', listener)` is the appropriate public
lifecycle event for adding `data-spa-nav` on a real client location change. Do
not add it during hydration or same-location focus refresh, which would cancel
the intended first-load entrance. In the installed source this event fires
inside the selected view-transition update, after publishing route matches but
before the renderer's transition acknowledgement. Browser verification must
confirm that the attribute exists before new home content starts its animation,
including Redact's scheduling behavior. `onResolved` is too late to rely on for
that ordering.

Use a boolean default, not a `types` callback that returns false. In
`router.ts:2456`, that callback runs only when the browser supports typed view
transitions. An older browser with the base API but no types support otherwise
runs the transition regardless of the callback's policy. Per-link booleans alone
also miss history, redirects and programmatic navigation.

## Concurrency limit

The public lifecycle approach restores selective policy. It does not reproduce
all original scheduler guarantees. The unpatched `router.startViewTransition`
method directly calls `document.startViewTransition` and returns
`updateCallbackDone`. It does not expose a scheduler option, retain the native
transition object for explicit cancellation, consume its `ready`/`finished`
rejections, or retry an update when the browser call throws. There is no
supported application option for installing the original scheduler around the
DOM commit.

Do not patch the global document API, override Router methods, delay navigation
with arbitrary timers, or build a parallel router to hide this limitation. First
test the built-in behavior with rapid superseding navigation. Router's
transaction ownership checks may make its native behavior sufficient, but source
inspection alone does not prove that browser lifecycle failures and visual
snapshots are equivalent. If a real failure is reproduced, the correct fix is a
tested upstream Router scheduler or transition integration API, with a tracked
dependency patch only if the project accepts maintaining it.

## Browser acceptance additions

- Fresh home load retains its normal entrance. Pricing to home by native link
  and Back suppresses the repeated `data-rise` entrance and preserves the
  document. Inspect computed animation names and the SPA marker, not just time.
- Home to pricing uses a page transition when supported. Docs guide to guide,
  account tab to tab, onboarding steps and package-file switches do not.
- Reduced-motion emulation suppresses transitions and entrance motion.
- A slow destination followed by a faster second destination ends on the second
  URL, title and content without blank main, stale snapshots, unhandled
  rejection or an unfinished transition. Include Back during that sequence.
- Test the base API without typed transition support, as well as unsupported
  browsers. A throwing transition API must not strand the navigation if that
  original recovery guarantee is required.

The lifecycle solution has low application maintenance cost if the policy is
shared and behavior-tested. It still depends on event ordering, so pinned Router
upgrades must run these browser checks. A library scheduler change has a higher
maintenance cost and should ship with upstream tests. Until these checks pass,
report motion parity as unverified and avoid attributing all click-to-ready
improvements to loading or rendering efficiency.
