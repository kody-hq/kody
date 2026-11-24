# Web app performance

How to measure a change to the web app, and what to fix first. Measure before
and after; put the numbers in the PR.

## What costs time

In production a page costs roughly **sequential depth × one binding round
trip**. A D1 read from a Worker placed away from the database takes tens of
milliseconds; locally it takes one or two. A page that reads 12 rows one after
another is fast on your machine and slow in production. So local wall-clock time
tells you little. Count round trips and how many of them wait on each other.

Fix in this order:

1. **Depth.** Start independent reads together (`Promise.all`), or send them as
   one `db.batch`. A read that needs an earlier result is the only kind that has
   to wait.
2. **Repeats.** A lookup that several layers need (user, org, membership, flag,
   entity source) goes through `memoizeReadPerRequest` in
   [`request-context.ts`](../../packages/worker/src/request-context.ts), so the
   shell, the session check, and the page share one read per GET.
3. **Count.** Drop reads the page does not render.

Page data on the client goes through `createPageQuery`
([TanStack Start](./tanstack-start.md)). A loader that calls a server function
directly is read on hover and again on click; a page query is read once.

## Measure

Start the dev server with the binding probe and sign in:

```bash
VITE_KODY_PERF_PROBE=1 npm run control-kody -- dev
npm run control-kody -- login --email <you>
```

The probe ([`perf-probe.ts`](../../packages/worker/start/perf-probe.ts)) records
every D1, Durable Object, R2, KV, and queue call against the request that made
it. It loads only in the dev server with that variable set; the production build
fails if the file is in it.

### Server: round trips per page

```bash
npm run app-perf -- ssr --org <slug> --package <org>/<name> --out before.json
# make the change
npm run app-perf -- ssr --org <slug> --package <org>/<name> --out after.json
npm run app-perf -- compare before.json after.json
```

Each line is one document request:

| Column    | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `d1`      | D1 round trips. A batch is one.                               |
| `depth`   | Round trips that waited for an earlier one. Lower this first. |
| `repeats` | Same SQL text sent again. Parameters are not compared.        |
| `other`   | Calls to other bindings, by name.                             |
| `ttfb`    | Local time to first byte. Only compare it against itself.     |

`--trace <route>` prints every round trip of one route with the function that
issued it, which is how you find the caller of a repeat or a serial chain.
`compare` prints the Markdown table for the PR. The route list is
[`tools/app-perf/routes.txt`](../../tools/app-perf/routes.txt); add a line when
you add a surface. Counts depend on the data in the account, so compare runs
against the same local data.

### Client: what a click waits for

```bash
npm run app-perf -- nav /@<slug>/-/overview /@<slug>/-/repositories /@<slug>/-/credentials
```

Opens the first path in Chromium, then hovers and clicks the link to each next
path. For each it lists the requests sent on hover, the requests sent on click,
and the time from click to the new URL. A page read that appears under both
hover and click means the preload was thrown away.

### Bundles: what every page downloads

```bash
npm run build
npm run app-perf -- bundle execution-contexts credentials
```

Prints the gzip size of the chunks every page loads before it can run, largest
first, and what each named route chunk adds on top. A library that only one
route needs belongs behind that route, not in the first list.
`--max-entry-kb <n>` exits non-zero when the every-page download is larger.

### Production

Never write to production data to measure. Read the `Server-Timing` header:

```bash
curl -s -o /dev/null -D - https://kody.codes/<path> | grep -i server-timing
npm run site-perf -- --url https://kody.codes/ --json
```

`ssr` is the time the Worker spent rendering. Compare several samples; the first
after a deploy is cold. [Weekly site performance](./weekly-site-perf.md) tracks
the landing page budgets, and [`/health`](./control-kody.md) shows which commit
is live.
