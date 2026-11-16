# UI verify

`npm run ui:verify` is how an agent proves UI work before calling it done. It
starts the isolated E2E server, then renders the component gallery and a set of
key real pages headlessly in light and dark, at desktop (1280x800) and mobile
(390x844) widths. For every page it runs:

- **axe**: serious and critical WCAG A/AA violations.
- **Keyboard**: tabs through the page and fails any stop with no visible focus
  change (outline, shadow, border or background on the element, a wrapper, or a
  descendant) or with no size.
- **Visual**: compares against the committed PNGs in `e2e/ui-verify/baselines/`.

Output, always at the same paths:

| Path                           | What                                              |
| ------------------------------ | ------------------------------------------------- |
| `.tmp/ui-verify/report.md`     | Readable pass/fail report with what broke and how |
| `.tmp/ui-verify/results.json`  | Same, machine readable                            |
| `.tmp/ui-verify/screenshots/`  | Every target, light and dark, desktop and mobile  |
| `.tmp/ui-verify/test-results/` | Expected, actual and diff images for mismatches   |

CI runs it as the `🖼️ UI verify` job and uploads `.tmp/ui-verify` as the
`ui-verify` artifact on every run, so reviewers can open the screenshots.

## Commands

```sh
npm run ui:verify                       # verify everything
npm run ui:verify -- -g gallery         # only targets whose title matches
npm run ui:verify -- --update           # accept current rendering as baseline
```

## When it fails

Read `.tmp/ui-verify/report.md`. Each failure names the page, theme and width.

- `axe:` and `keyboard:` lines are real bugs. Fix the component or page. Do not
  add an exclusion unless the finding is a known, documented false positive;
  exclusions live next to the target in `e2e/ui-verify/targets.ts` with the
  reason.
- `visual:` lines mean the rendering changed. Open the diff image. If it is a
  regression, fix it. If the change is intended, run
  `npm run ui:verify -- --update`, look at
  `git diff --stat e2e/ui-verify/baselines` to confirm only the pages you meant
  to change moved, and commit the baselines with the change.

Screenshots render in the official Playwright Docker image that matches the
installed `@playwright/test` (`mcr.microsoft.com/playwright:v<version>-noble`),
so baselines match on every OS and in CI. The app still runs on the host; the
browser reaches it through Playwright's `exposeNetwork`. Without Docker, axe and
keyboard checks still run, visual diffs are skipped, and the report says so. CI
and `--update` fail instead of skipping.

## Component gallery

`/dev/ui` renders every shared component in `packages/worker/start/components`
in each variant, size and state. It is served only in local dev, tests and
previews (`isNonProductionRuntime`); production returns 404. Each gallery
section is its own baseline (`gallery-<section>-<theme>-<width>.png`), so a
component change only moves the baselines for that component.

When you add or change a shared component, add or update its section in
`packages/worker/start/pages/ui-gallery.tsx` (`uiGallerySections`) so it is
covered, then run `npm run ui:verify -- --update` for the new baseline.

## Adding a page

Add a target to `e2e/ui-verify/targets.ts`: a path, a session (`anonymous`,
`user`, `admin`), a `ready` check that waits for the page's real content, and a
visual mode (`page`, `sections`, or `none` with a reason when the content is not
deterministic). Keep the list to pages that exercise shared UI; feature behavior
belongs in normal E2E specs.
