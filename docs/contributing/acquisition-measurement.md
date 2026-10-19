# Measuring the use-case pages

The page registry in `packages/worker/universal/acquisition/metadata.ts` is the
shared list for search metadata, the sitemap, anonymous HTML caching, and
Scarf's exact public-path allowlist. It includes `/use-cases` and ten landing
pages. New entries must also have a server and client route.

## What is collected

| Tool                   | Coverage                                                                                                                                                                  | How to use it                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fathom                 | Existing production script tracks pageviews and SPA navigation. New `acquisition_<pageKey>_onboarding_clicked` events count onboarding CTA clicks on each landing page.   | Compare visits, referrers, and CTA events by page. A CTA click is intent, not an account creation.                                                                                               |
| Signup attribution     | Existing first-touch capture carries the landing path, referrer, and UTMs through signup. Existing `signup_started` and `account_created` Fathom events remain unchanged. | Use stored first-touch landing paths for actual signup attribution. Do not divide all-site account creations by a single page's traffic.                                                         |
| Scarf                  | All eleven exact paths are included. Existing tracker fires on page changes and return visits, strips queries/fragments, and skips non-production hosts, DNT, and GPC.    | Filter the pixel's `Page` field to these URLs to see identified company visits. Anonymous or unidentified visitors are not evidence of no company interest.                                      |
| Google Search Console  | All eleven canonical URLs are in `/sitemap.xml`; HTML and negotiated Markdown are available. No new browser tag is needed.                                                | After deployment, inspect the URLs and compare queries, impressions, clicks, CTR, and position by page. Sitemap inclusion does not guarantee indexing.                                           |
| Nozzle                 | Domain keyword tracking is independent of the page implementation. No browser tag is needed.                                                                              | Keep the existing US, English, desktop keyword set. Map ranking URLs to these pages; add missing target terms only within the existing collection budget.                                        |
| Cloudflare             | Existing zone analytics and any enabled Web Analytics beacon cover the host. No Worker request instrumentation is added for these pages.                                  | Use website page paths and Web Analytics for performance, separately from backend requests. Browser analytics cannot identify all agent or Markdown reads; those require request analytics/logs. |
| Semrush / Ahrefs / Moz | Research tools do not need page scripts.                                                                                                                                  | Use for opportunity and competitor research. Do not start duplicate paid rank-tracking campaigns.                                                                                                |
| RB2B                   | Not installed.                                                                                                                                                            | Still deferred.                                                                                                                                                                                  |

CTA events only run on `https://kody.codes`, respect DNT/GPC, and send a fixed
registry key rather than URLs, query values, email addresses, or page content.
Scarf and Fathom are separate measurements and their totals will differ. Do not
add internal UTMs to the links between these pages, since that would pollute
acquisition reporting.

## Launch checks

1. Verify the live sitemap, canonical tags, and a Markdown request for each
   page.
2. In Fathom site `WKKSDJGN`, verify that the firewall allows `kody.codes`. A
   successful beacon response alone does not prove dashboard ingestion.
3. Visit one live page, navigate to another, then click its onboarding CTA.
   Confirm both pageviews and the corresponding event in Fathom. Preview visits
   intentionally do not send these events. Event keys use registry names, such
   as `acquisition_gmail_onboarding_clicked` and
   `acquisition_scheduledWorkflows_onboarding_clicked`.
4. Confirm a production Scarf pixel request contains the public page path only,
   and confirm it appears in the Kody organization. An identified company is not
   guaranteed for the test visit.
5. Check Search Console indexing after deployment. Keep the existing sitemap
   submission if it already points to `/sitemap.xml`.
6. In Nozzle, confirm the existing keyword set still uses US, English, desktop.
   Missing collection data and a collected SERP with no Kody result are
   different states. Do not trigger another paid collection just to test page
   instrumentation.

Review weekly, using the same seven-day window. Start with impressions and
indexing, then clicks, landing-page visits, CTA intent, and attributed signups.
Record publication dates and substantial copy changes. Dashboard access and live
ingestion must be verified after deployment; local tests establish code
coverage, not production data delivery. Event keys are defined in code; see
[Fathom's event setup](https://usefathom.com/docs/events/overview).
