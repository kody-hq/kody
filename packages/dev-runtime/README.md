# @kodycodes/dev-runtime

The real [Kody](https://kody.codes) workers, built to run on your machine for
`kody dev`.

You don't need to install this package yourself. The first time you run
`kody dev` from
[`@kodycodes/cli`](https://www.npmjs.com/package/@kodycodes/cli), the CLI
installs the matching version of `@kodycodes/dev-runtime` into the Kody cache
and starts it for you. Both packages are released together at the same version.

```bash
cd ./my-package
npx @kodycodes/cli@latest dev
```

## What's inside

- The hosted origin, platform, runtime, jobs and highlight workers, plus a mock
  Cloudflare worker for Artifacts.
- Local wrangler configs for those workers, with local D1, Durable Objects, KV,
  R2, queues, workflows and worker loaders.
- The D1 migrations used to set up local state.

Your package app runs through the same package runtime as hosted Kody:
`packageStorage` uses the real StorageRunner Durable Object, and `events`,
`email`, `workflows`, realtime, jobs and `kody.*` capability calls run the real
handlers against local data. Nothing is proxied to hosted Kody, and nothing you
do locally touches your hosted account.

## What's mocked

Only the edges of the system:

- Outbound fetch goes through your package's `.kody/mocks.ts`.
- `packageSecrets` returns placeholders and never a real secret.
- Email is written to a local outbox at `/__kody/dev/outbox`.
- AI, Vectorize, Images, analytics and billing are stubbed or turned off.

Timing flags such as `--simulate-latency`, `--cold`, `--clock` and the CPU
warning are simulations, not exact Cloudflare behavior.

## Docs

- [Local testing with `kody dev`](https://kody.codes/docs/package-apps#local-testing-with-kody-dev)
- [Boundary mocks in `kody dev`](https://kody.codes/docs/package-apps#boundary-mocks-in-kody-dev)
- [Mock package secrets](https://kody.codes/docs/package-apps#mock-package-secrets)

Local state lives under `<kody cache>/dev-state/<hash of the package root>`.
Delete that directory to start over.

Copyright © 2026 [Kent C. Dodds](https://kentcdodds.com). MIT licensed.
