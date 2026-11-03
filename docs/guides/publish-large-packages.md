---
id: publish_large_packages
title: Publish packages too big for Kody cloud
summary:
  When a publish hits the worker's memory, CPU, or payload limits, build the
  package on your own machine (`kody package publish --build local`) or on an
  execution context you operate (`--build context`). Kody still checks the
  upload against the pushed commit and writes the registry itself.
category: platform
---

# Publish packages too big for Kody cloud

Kody publishes run in Cloudflare Worker isolates (about 128 MB of memory). A
package with a large npm graph can run out of memory or CPU while Kody bundles
it, and the publish fails with a resource-limit error that links here.

You can move the heavy part, bundling, off Kody cloud:

```sh
# Build on this machine
git push
kody package publish @you/big-package --build local

# Build on an execution context you operate
git push
kody package publish @you/big-package --build context
```

In a terminal, `kody package publish` asks whether to build locally when Kody
cloud runs out of room. Agents and CI get these commands instead of a prompt.

> Builds outside Kody cloud are behind the `publish-offload` feature flag and
> are not enabled for accounts yet.

## What runs where

| Step                                                                    | Where                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------- |
| Bundling every export, job, handler, and app target                     | Your machine or context (same bundler as Kody)  |
| File manifest check, cheap publish checks, typecheck, credential stamp  | Kody                                            |
| Hash, size, and package-identity checks for each target, sample rebuild | Kody                                            |
| Writing the registry and switching the serving version                  | Kody, only after every check and write succeeds |

Kody trusts nothing it did not compute itself:

- The build's per-file SHA-256 manifest must match the pushed commit's tree
  exactly. A dirty working tree or a commit you have not pushed is refused.
- Every target must be one the commit's `package.json` declares, with the right
  hashes and sizes and no platform-reserved module names.
- Kody rebuilds a sample of targets itself and compares hashes (more for
  community-listed packages).
- A build may only inline Kody packages you can write. Otherwise publish on Kody
  cloud.

## When a build is refused

The publish result says exactly why. The version that was serving keeps serving.
Usually the fix is a clean checkout at the pushed commit:

```sh
git status        # must be clean
git push
kody package publish @you/big-package --build local
```

Uploads resume: rerunning the same command skips chunks Kody already has.

## Limits

Building off the worker lifts Kody's compute limits but not its storage limits:
source stays capped at 32 MiB and each built target at about 20 MiB. Local and
context build time is free; only Kody's verification is metered.

## Execution contexts

`--build context` runs on a context you operate (not one shared with you). The
context clones only this package's repo with a read-only token that expires in
about five minutes, builds with no access to your credentials, and uploads with
a ticket that only works for that one build. See
[execution contexts](./execution-contexts.md).

Related: [heavy work offload](./heavy-work-offload.md) for runtime work that
never fits a Worker.
