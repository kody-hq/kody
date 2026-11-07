# 0098: Kody hosts short-lived build boxes for packages that declare a build step, paid from credits

- **Status:** accepted
- **Date:** 2026-11-06
- **Amends:** [0025](./0025-no-package-services-primitive.md) (Kody still hosts
  no long-running package process; a build box lives for one build)

## Context

Publish bundles `kody.app.entry` with plain esbuild and no plugins
([0057](./0057-no-framework-platform-affordance.md)). `kody.dev.prebuild` runs
only for local `kody dev`, so anything that needs a build step before esbuild
cannot publish: TanStack Start's generated entry and manifest modules and
server-function compiler, other Vite-plugin frameworks, compiled CSS, generated
route trees. `kody package publish --build local` and `--build context` already
move bundling off Kody cloud, and Kody already checks the uploaded manifest
against the pushed commit and rebuilds a sample of targets. Neither runs a
package's own build command, and both need a machine the author operates.

## Decision

Kent decided on 2026-11-06:

1. **Kody hosts build boxes, build-only.** A package that declares a build step
   publishes through a short-lived, Kody-operated build box: one build, then the
   box is destroyed. It is one more build location in the existing publish
   routing, not a service, daemon, or runtime host.
2. **Pro orgs with enough credits only.** Free orgs, and Pro orgs whose prepaid
   credits do not cover the build cap, are refused before the box starts.
3. **Credits only.** Build-box time is its own meter, debited from prepaid
   credits from the first second; it never draws on the monthly include. Zero
   credits stops the publish; the serving version keeps serving.
4. **Framework-neutral.** The step is a declared command and declared outputs;
   Kody still bundles the outputs with its own esbuild. No framework is named,
   vendored, or special-cased (0057 stands).
5. **Community listing is allowed at launch.** Community packages are forked,
   not imported, so every fork runs its own build in its own org's box from
   source the forker holds. The listing says the package needs a build step,
   which needs Pro with credits to publish.

## Consequences

- Packages without a build step see no change in behavior or cost.
- The box gets no Kody secrets or package credentials, a committed lockfile with
  `npm ci`, outbound network limited to the package registry, and hard time and
  memory caps. Kody's manifest, identity, size, and sample-rebuild checks still
  run; the sample rebuild for a built package runs in a fresh box.
- Kody pays for box time it then bills; build-cache hits on an unchanged source
  and lockfile hash cost nothing.
- **Revisit if** box cost or abuse outgrows the credit price, a community
  package's fork run needs to import rather than fork, or Free orgs need builds.
