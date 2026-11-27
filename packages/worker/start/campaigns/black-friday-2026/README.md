# Black Friday 2026

Sale banner and checkout auto-apply for the `blackfriday-2026` campaign. It ends
Mon Nov 30, 2026, 11:59:59 PM MT. After that the server renders no banner and
applies no code, so this folder is dead code that can go at any time.

## What it does

- Signed out: a bar above the site header on marketing pages.
- Signed in: a card at the top of the workspace main column, when the org being
  viewed is on Free with no Stripe subscription, the viewer has `billing:write`
  there, and the viewer has no claim or live reservation for this campaign.
- Checkout: when that same rule holds and the person typed no code, Pro checkout
  applies `BLACKFRIDAY-YEARLY` or `BLACKFRIDAY-MONTHLY` by the chosen interval.
  If the code cannot be applied, checkout continues at full price.

## Files

| File                             | Role                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `offer.ts`                       | End time, list prices, discount percents, copy, countdown format, pre-paint script. Browser safe.                |
| `countdown.ts`                   | One client timer for the countdown, the end-of-sale hide, and dismissal (`localStorage`).                        |
| `banner.tsx`                     | `BlackFridaySiteBar` and `BlackFridayWorkspaceCard`.                                                             |
| `server.ts`                      | Eligibility (`blackFridayOfferAvailable`), shell data, and the checkout code. Holds the code names. Server only. |
| `black-friday-2026.node.test.ts` | Tests for all of the above, including checkout through `startWebsiteCheckout`.                                   |

The end time and prices in `offer.ts` must match the Stripe promotion codes
(`expires_at` 1796108399, 25% off once, 50% off for 2 months). Server HTML never
contains the time left: signed-out pages are shared from the edge cache, so a
script next to the banner fills the countdown from the visitor's clock before
first paint, and hides the banner for a visitor who dismissed it.

## Remove the campaign

1. Delete this folder.
2. `packages/worker/start/routes/__root.tsx`: remove the `BlackFridaySiteBar`
   import and its mount above `SiteHeader`.
3. `packages/worker/start/components/workspace-layout.tsx`: remove the
   `BlackFridayWorkspaceCard` import and its mount in `<main>` (the
   `fullPanel ? null : ...` expression around it goes too).
4. `packages/worker/start/server/shell.ts`: remove the `loadBlackFridayBanner`
   import and the `blackFridayBanner` field of the shell data.
5. `packages/worker/src/app/handlers/org-billing.ts` (`startWebsiteCheckout`):
   remove the `resolveBlackFridayCheckoutPromo` import and the `else` branch
   that calls it. `promoIsOptional` is then always false: remove it, the
   `!reserved` fallthrough, and the full-price retry in the `catch`.
6. `packages/worker/src/billing/checkout-promo.ts`: remove
   `hasBlockingPromoClaim` (only this campaign reads it).
7. `packages/worker/tsconfig-worker.json`, `tsconfig-start-tests.json`, and
   `tsconfig-start-server-tests.json`: remove the
   `start/campaigns/black-friday-2026/` entries.

8. `playwright.config.ts` and `playwright.ui-verify.config.ts`: remove the
   `storageState` that dismisses the banner for E2E and UI verify runs.

9. `e2e/workspace-sidebars.spec.ts`: remove the `useRouter` export from the
   `@tanstack/react-router` stub.

`git grep -n -i -e black-friday-2026 -e blackfriday` should then print nothing.

Nothing is stored on the server for this campaign beyond the normal promo claim
rows. The dismissal is a `localStorage` key
(`kody.campaign.blackfriday-2026.dismissed`) that nothing reads once this folder
is gone.
