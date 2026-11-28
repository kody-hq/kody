# Internet-visible packages and capability approval

Internet-visible is a **package app** flag, independent of **forkable** (public
/ `is_private = 0` community listing + anonymous git read).

| Toggle           | Meaning                                                                   | Default                                        |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Forkable         | Community can read and fork source; lists on `/community`                 | Off (private). Public packages are forkable.   |
| Internet-visible | Hosted app may be served on the public internet after capability approval | Off. Apps without the flag stay session-gated. |

Either, both, or neither. Enabling internet-visible requires the owner to
approve a one-page credential and capability summary (stable credential ids,
hosts, storage) for the **resolved dependency tree** (root + transitive `kody:@`
packages). Each package in the tree contributes only what it declares or was
given (`compute-package-capability-set.ts`): credentials that fill its
`kody.credentials` needs (org credentials and members' personal credentials
granted to the org, `listOrgReachableCredentials`) plus every credential a
stored `credential_mappings` row maps to one of those needs (org default, member
defaults, trigger overrides), its `kody.secretMounts`, its package-scoped
credentials, credentials granted to it (`allowed_packages`), and package storage
when its published source uses it or the published source cannot be read.
Implicit user-credential read for self-authored packages is not a declaration
and adds nothing, so account-wide credentials do not move the fingerprint.
Approving the capability set **records** a lockfile-like dependency snapshot
with the fingerprint and enqueues a `went_public` request on the shared
`package_approval_requests` queue (same page as credential-needs pauses). The
owner Approves that request to flip internet-visible on. Secret values never
appear on that page or in package code. Regular packages keep floating on
current `published_commit`
([ADR 0069](./decisions/0069-internet-visible-capability-pinning.md)).

Turning internet-visible on (settings toggle or `packageUpdate`) records the
`went_public` request right away when the capability set is not yet approved.
While that request is pending, the approval page shows one **Approve and make
internet-visible** button (`approve-capabilities-and-go-public`). It runs the
capability pin (`package.capabilities.approve`), then the `went_public` request
(`package.went_public.approve`), each with its own checks and org audit event.
The pin does not enqueue a new `went_public` request, so a request turned off
meanwhile stays off. If the visibility write loses a race after the request is
claimed, a fresh `went_public` row is re-queued so Approve is not lost.

When the capability set is **already** approved (matching pin), the settings
toggle and `packageUpdate` turn internet-visible on immediately — they refresh
the pin and approve `went_public` without sending the owner to the approval page
again. The two steps were never split for a security reason; they share one
queue
([ADR 0068 amendment](./decisions/0068-credentials-own-placement-scoped-clients.md)).
An approval bundle's went-public item cannot be approved until the capability
set is, so it points at the package's approval page instead.
`approvalPendingList` lists pending `went_public` rows for anyone with
`package:write` on the package (same bar as the approval page); `canApprove`
still needs `package:publish`.

When the current published version has no security audit, the toggle response
(`securityAudit`) and `packageUpdate` (`security_audit`) carry the agent's next
step (`security-audit-next-step.ts`): audit, record with
`packageSecurityAuditRecord` using the returned `package_id`,
`published_commit`, and `fingerprint`, then hand the owner the approval link.
The audit is informational and approves nothing.

## Republishing an approved app

Every runtime reader (members, the owner, jobs, module calls, and anonymous
visitors) runs `serving_commit`, so members and the public never run different
commits. A publish moves `published_commit` before its build finishes, so
everyone keeps the previous commit until `serving_commit` advances.

`advanceServingCommit` (`package-capabilities/serving-commit-advance.ts`) moves
the serving pointer once a build is complete. For an internet-visible app with
an approved commit that served (`getServedPackageCapabilityApproval`), it
computes the new commit's capability set first:

- When every entry is already in that approval (the same set or a narrower one),
  it inserts the carried forward approval in the same D1 batch as the pointer
  move, so no request sees the new serving commit without its approval.
- When the set asks for more, or cannot be checked, the pointer does not move.
  The source records the commit as `entity_sources.held_commit` and everyone
  stays on the approved commit. Approving it (`approvePackageCapabilitySet`) or
  turning internet-visible off (`clearInternetVisible`) calls
  `releaseHeldServingCommit`, which advances to the held commit. A newer publish
  replaces the hold.
- A commit that already has its own approval (approved while it built) advances
  and is marked served.

Anonymous HTTP visitors still read the commit their cached approval names
(`toPinnedSourceView`), which only differs from the serving commit while that
cache trails an advance. Anonymous realtime sockets need the approved commit to
be the serving commit. An app that was never approved keeps returning 403 to
anonymous visitors, and its republishes advance for members. Apps that are not
internet-visible never hold a commit. There is no members-only preview of a held
commit; test it with local dev or a dev check.

Everything else an app runs follows the same commit. Jobs sync only when a
commit starts serving: `advanceServingCommit` syncs them to that commit
(`syncPublishedPackageJobs` with `commit`) before it moves the pointer, as the
publisher or, on release, the approver. A sync that fails throws before the
pointer moves, so the hold stays and approving again retries it. Publish-time
projection syncs jobs to the serving commit only, so a held build never adds,
removes, re-enables, or rewrites a job. Subscriptions, skills, and package
metadata are projected at publish and settled back on hold through the settle a
failed rebuild uses (`refreshSavedPackageProjection` with
`rebuildArtifacts: false`), then projected again on release. Readers that load a
manifest by source (`loadPackageManifestBySourceId`,
`loadManifestsForSavedPackages`) read `toUnheldSourceView`, the serving commit
while the published one is held, so webhooks, events, subscription dispatch,
secret access, and enablements follow it too. Capability checks pin the commit
they inspect (`commit`).

An internet-visible app
[keeps serving its approved commit while a new commit is held](../../packages/worker/src/package-capabilities/serving-commit-advance.node.test.ts).
[`packagePublishExternalPush`](../../packages/worker/src/mcp/capabilities/packages/publish-external-push.node.test.ts),
[`repoPublishSession`](../../packages/worker/src/mcp/capabilities/repo/repo-publish-session.node.test.ts),
and
[`packageSave`](../../packages/worker/src/mcp/capabilities/packages/save-package-entitlements.node.test.ts)
report `held_for_approval`, not `published`, `already_published`, or `ok`, with
`serving_commit`, `held_commit`, `approval_url`, and `message`.
`packagePublishExternalPush` first returns `dispatched` with a `workflow_id`;
the held result comes from `packageRunResult`. Unlike `locked` and
`approval_required`, the hold happens after the publish builds the commit. A
durable publish run treats the hold as a refusal, and the CLI exits 1.
[`packageGet`](../../packages/worker/src/mcp/capabilities/packages/get-package.ts)
reports the serving commit as `published_commit` and `serving_commit` while a
commit is held. It returns null for `held_commit` and `approval_url` on a
successful read without `package:write`.

The
[serving update](../../packages/worker/src/package-capabilities/serving-commit-advance.ts)
requests an email notice when it first records the hold, whether the publish was
direct or automatic. The
[email goes to the package-owning account's owners](../../packages/worker/src/package-capabilities/held-for-approval-notice.ts),
not necessarily the publisher. Waiting lists holds as `publish-held` items until
approval, and the owner package page shows the approval link.

## Self-publish

`packageUpdate` (`internet_visible: true`) and the settings toggle approve going
public themselves when `evaluateSelfPublish`
(`packages/worker/src/package-capabilities/self-publish.ts`) finds all of these:

- the resolved capability set the owner would approve is empty (no credentials,
  hosts, or storage on the approval page — nothing for the owner to click);
- the package and every package in its resolved dependency snapshot are
  published, each still at the commit the snapshot pins (otherwise
  `stale_dependencies`), since only the current publish is read;
- none of them declares `kody.credentials` (or has a fresh needs closure that
  does), `secretMounts`, `secretProvider`, `subscriptions`, `emits`, `jobs`, or
  `webhooks`;
- a security audit with verdict `pass` is recorded
  (`packageSecurityAuditRecord`) for the package's current published commit and
  capability fingerprint;
- the caller has `package:publish` on the package.

It does not wait on the `credential-need-enforcement` flag. The credential door
refuses every credential to a self-published package
(`self-published-package-guard.ts`), so declaring nothing stays equivalent to
using nothing while public this way. Agents still cannot self-approve a
non-empty capability set.

It is evaluated in three places, all through `attemptSelfPublish`: when
`packageUpdate` sets `internet_visible: true` (again on every re-toggle), when
the settings toggle turns internet-visible on, and when
`packageSecurityAuditRecord` records a `pass` while a `went_public` request is
pending. Anything that fails a check stays pending for the owner, and the
response's `self_publish_blocker` names the first failed check (`not_audited`
and `audit_concerns` for the audit).

`selfPublishPackage` then records the capability pin (refusing if the package
was published again since the audited commit), enqueues or reuses the one
pending `went_public` request and marks it `selfPublish: true` in place,
approves it through `approveWentPublicRequest` (the same checks as the owner's
click), and writes one org audit event, `package.went_public.self_publish`. If
the approval fails or throws, the mark is cleared in place, so the request stays
pending for the owner and an owner Approve never reads as self-publish;
`packageUpdate` then reports `self_publish_error` with the owner's
`approval_url` (or errors when nothing is pending anymore). From
`packageSecurityAuditRecord`, self-publish marks and approves only the pending
request the audit saw and never enqueues one, so a request the owner withdrew
meanwhile is not replaced.

The credential door (`resolveCredential`) refuses every credential to a package
that is internet-visible and whose latest approved `went_public` request is a
self-publish one, with `credential_need_undeclared`
(`self-published-package-guard.ts`). That covers by-name helpers that
credential-need enforcement does not limit (`secretJwtSign`,
`integrationTokenRefresh`, `kody.mcp`). It holds whatever the package declares
later, and whether or not credential-need enforcement is on, until the owner
approves going public again (turn internet-visible off, then on).

## Publisher-supplied credentials in apps

Package apps resolve publisher-supplied `kody.credentials` needs as the
publisher (ADR 0068). In a package-app visitor run, executor-supplied needs use
the visitor's pick via `credential.visitor`; direct and trigger runs keep their
existing resolution order. `ownerCredentialForVisitors: true` still parses as a
leftover alias for `supplier: "publisher"` and stays in the capability
fingerprint so existing approvals stay stable. Omit it on new packages. See
[Packages](../use/packages.md#publisher-supplied-credentials-in-apps).

## ADR 0001 exception

Public-site pinning of an approved dependency snapshot is the accepted exception
in [0069](./decisions/0069-internet-visible-capability-pinning.md).

## Forks

A fork does **not** inherit the origin's approval record. Credentials are
org-local. The forker's approval page starts empty of grants and shows the
origin capability set as review context only. The forker must approve in their
own org before their copy can be internet-visible. See
[0069](./decisions/0069-internet-visible-capability-pinning.md).

## Out of scope

Kody-account login for public apps with roles; third-party visitor auth; image
storage via other packages. Custom domains are a separate feature
([0071](./decisions/0071-package-app-custom-domains.md)).
