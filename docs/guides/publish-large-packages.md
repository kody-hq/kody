---
id: publish_large_packages
title: Publish packages too big for Kody cloud
summary:
  When a publish hits the worker's memory, CPU, or payload limits, build the
  package on your own machine (`kody package publish --build local`) or on an
  execution context you operate (`--build context`). The CLI pushes HEAD first;
  Kody checks the upload against that commit, links any `kody:@` packages it
  imports, and writes the registry itself.
category: platform
---

# Publish packages too big for Kody cloud

Kody publishes run in Cloudflare Worker isolates (about 128 MB of memory). A
package with a large npm graph can run out of memory or CPU while Kody bundles
it, and the publish fails with a resource-limit error that links here.

You can move the heavy part, bundling, off Kody cloud:

```sh
# Build on this machine (commit first; the CLI pushes HEAD for you)
kody package publish @you/big-package --build local

# Build on an execution context you operate
git push
kody package publish @you/big-package --build context
```

In a terminal, `kody package publish` asks whether to build locally when Kody
cloud runs out of room. Agents and CI get these commands instead of a prompt.

> Building outside Kody cloud is part of the Execution contexts experiment. Turn
> it on at [Experiments](https://kody.codes/account/experiments); the same
> switch covers `--build local`, `--context`, and package bindings. See
> [try publishing from a context](./execution-contexts.md#try-publishing-from-a-context).

## Where a publish builds

With the experiment on, Kody picks where each publish builds, in this order:

1. **The context you name.** `kody package publish @you/pkg --context build-box`
   (or `context` on `packagePublishExternalPush`) builds there and never falls
   back. `--context cloud` builds on Kody cloud.
2. **The package's bound context.** A package can set one in `package.json`:

   ```json
   {
   	"kody": {
   		"publish": { "execution": { "context": "build-box" } }
   	}
   }
   ```

   This is a binding, not a default. When a publish does not name a context and
   the bound one is offline, busy, or its build fails, the publish fails. It
   does not fall back to your chain or to Kody cloud, and the previous version
   keeps serving. The error names the context and the two ways out: name a
   context for this publish (`--context <name>` or `--context cloud`), or change
   or remove `kody.publish.execution.context`, push, and publish again.
   `"context": "cloud"` binds the package to Kody cloud.

3. **Your execution context chain,** the same as `execute`: the contexts you
   operate, in order, then Kody cloud, unless your chain is strict. Contexts
   that are offline, busy, or that someone else operates are skipped.

Auto-publish on push works the same way. A package that subscribes to the repo
pushed event and calls publish from its handler gets these same rules.

With the experiment off, every publish builds on Kody cloud, a bound package
included, and naming a context other than `cloud` is refused.

## What runs where

| Step                                                                    | Where                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------- |
| Typecheck, and bundling every export, job, handler, and app target      | Your machine or context (same code as Kody)     |
| File manifest check, cheap publish checks, credential stamp             | Kody                                            |
| Hash, size, and package-identity checks for each target, sample rebuild | Kody                                            |
| Writing the registry and switching the serving version                  | Kody, only after every check and write succeeds |

Kody never publishes a commit it cannot see. `--build local` refuses uncommitted
changes, pushes HEAD to its upstream branch on the package's Kody remote if it
is not there yet (it never makes a commit), and builds only after Kody confirms
that exact commit is the head of the package repo. If Kody reports a different
commit, nothing is built or uploaded. `--build context` builds the commit Kody
sees, so push first.

Kody trusts nothing it did not compute itself:

- The build's per-file SHA-256 manifest must match the pushed commit's tree
  exactly.
- Every target must be one the commit's `package.json` declares, with the right
  hashes and sizes and no platform-reserved module names.
- Kody rebuilds a sample of targets itself and compares hashes (more for
  community-listed packages).
- A build never contains another Kody package. Each `kody:@` import stays a
  linked placeholder, and Kody fills it in when it commits the upload: the
  dependency's own published artifact, resolved for you the same way a cloud
  build resolves it, behind the same metered proxy. The dependency's package id,
  storage, secrets, and capabilities come from Kody, so you can import packages
  you can use but not write.
- Filling a placeholder copies that artifact into your package, so a large
  dependency still adds its size (and the size of the `kody:@` packages it
  imports) to your publish. Kody loads each dependency once per publish, writes
  a package that several dependencies share once, and builds an export and the
  jobs that share its entry file once, but importing a very large package from
  many different entry files costs that copy for each of them.
- Uploaded modules may bind only your own package. A build that inlines another
  package's code, binds another package's id, or ships its own module at a
  linked placeholder path is refused.

## When a build is refused

The publish result says exactly why. The version that was serving keeps serving.
Usually the fix is a clean, pushed checkout:

```sh
git status        # must be clean
git push          # if the CLI could not push for you
kody package publish @you/big-package --build local
```

The CLI pushes to the branch's upstream. A detached HEAD or a branch without an
upstream is refused; set one with `git push -u <kody remote> HEAD`.

Uploads resume: rerunning the same command skips chunks Kody already has.

## Limits

Building off the worker lifts Kody's compute limits but not its storage limits:
source stays capped at 32 MiB and each built target at about 20 MiB. Local and
context build time is free; only Kody's verification is metered.

## Execution contexts

A context build (named, bound, or from your chain, or `--build context`) runs on
a context you operate (not one shared with you). The context clones only this
package's repo with a read-only token that expires in about five minutes, builds
with no access to your credentials, and uploads with a ticket that only works
for that one build. See [execution contexts](./execution-contexts.md).

Related: [heavy work offload](./heavy-work-offload.md) for runtime work that
never fits a Worker.
