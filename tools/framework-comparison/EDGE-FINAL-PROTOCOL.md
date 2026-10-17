# Final private preview comparison protocol

Wait for the candidate deployment containing the verified document-head and
motion parity fixes, then confirm both origins and emitted runtime fingerprints.
Keep the immutable Remix deployment and data unchanged. No benchmark should
overlap builds, tests, deploys or other browser work.

Use the same applied-DevTools Lighthouse method as `edge-applied-final`, with
five samples for home, pricing and docs on mobile and desktop. Run targets
sequentially and reverse their order on alternate rounds. Use a fresh output
directory and fresh Chrome for every sample. Keep all failures, preserve retry
filenames and retry only missing successful slots. These scores are
applied-throttling scores, not standard simulated Lantern scores.

Authentication remains origin-scoped service-token request interception. Strict
Access did not issue a reusable browser cookie in the tested environment. Do not
weaken Access policy, inject credentials globally, or change Chrome transport
flags to get a preferred result. Interception is a measurement caveat, even
though both targets use it. The installed Puppeteer implementation enables Fetch
interception and continues requests individually; it does not explicitly disable
HTTP/2 or QUIC, and its cache setting follows the configured browser cache flag.
There is no evidence that it inherently breaks connection reuse.

The preflight warms document paths. Fresh browser state does not mean cold edge
or cold Worker. Report X-Kody-Cache and CF-Cache-Status per audited document,
location suffix, protocol, compression, outgoing cache-control/pragma, and
response timing. The prior formal series sent neither cache-control nor pragma
on its sixty initial document requests. Delivery records can include later
Lighthouse navigations, so never replace the first audited navigation's cache
classification with the final recorded document's status.

Acceptance checks for each sample: status200 on the measured document, exact
expected heading, one main element, expected path, no uncaught page errors, and
retained console warnings/errors. Preserve full sanitized Lighthouse JSON/HTML
plus allowlisted delivery records. Check secrets by exact value after writing,
without printing credentials. Scores from Access login pages, truncated HTML or
failed Chrome launches must never enter valid performance medians.

Report medians and ranges for FCP, LCP, TBT, CLS, transfer, requests and TTFB.
Also calculate LCP minus the server-response-time audit for each sample before
summarizing. Do not subtract independent medians and call the result a median
render delay. Retain actual LCP selectors, font requests and layout-shift
culprits. Compare the final candidate against its contemporaneous baseline;
older runs are diagnostic context, not interchangeable samples.

The prior HTTP control has ten alternating pairs per page with median header
times around26–34ms on both targets. It does not show a persistent slower
candidate response outside the browser. The six fresh-browser CDP checks found
one candidate response taking about2,044ms between request send completion and
response headers, with DNS/connect completed in about41ms. That outlier used
HTTP/3, but other HTTP/3 and HTTP/2 samples were fast, so neither protocol nor
framework causation is established. Do not explain the browser TTFB gap as
server rendering without additional evidence.

Before the final sixty audits, use a separate small smoke to verify the deployed
fixes, expected page content and absence of systematic docs layout shift. The
previous candidate's mobile docs CLS was consistently0.05824, with two paragraph
shifts and an explicit Wix web-font attribution. If the same defect remains,
investigate it before spending another full measurement run. No automatic change
to critical-resource ordering is warranted solely by the old localhost scores,
because edge timing did not reproduce that contention clearly.
