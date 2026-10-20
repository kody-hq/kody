---
id: platform_friction
title: Report friction
summary:
  Use for meaningful Kody friction, bugs, poor experiences, or suggestions:
  show the exact proposal and account-identity notification disclosure
  before asking for explicit approval, and write one actionable issue per
  submission (repro steps, expected vs actual, impact).
category: platform
audience: agents
---

# Report friction

Use this guide when Kody itself creates friction while you are using built-in
capabilities, saved packages, package apps, jobs, memories, integrations, or
official Kody guides. Contributor papercuts while developing this repository use
the [friction log](../contributing/friction-log.md) (`friction` GitHub issues),
not this guide.

The goal is small, user-approved improvement: resolve what can be fixed in the
current task, remember durable user-specific context when appropriate, and offer
to submit useful platform feedback without turning the user's task into platform
maintenance.

## What counts as Kody friction

Treat these as friction points:

- confusing or missing package README guidance
- a saved package whose intent or setup steps are unclear
- capability descriptions, schemas, or guide text that caused a wrong turn
- recurring user-specific preferences or workarounds that Kody could remember
- reproducible Kody bugs, misleading errors, or missing troubleshooting steps
- a poor Kody experience or a concrete suggestion for improving Kody

Do not recommend platform feedback for every normal third-party API failure,
provider outage, authentication failure, or credentials setup step. Use
`integration_bootstrap`, `oauth`, or `connect_secret` for those workflows. Offer
feedback when Kody made that experience meaningfully worse, or when the same
Kody friction is likely to recur.

## Core rule

When you notice a Kody friction point and you can suggest a concrete
improvement, tell the user briefly. Then choose the smallest relevant path:

1. Fix obvious, low-risk friction inline when it is already within the work.
2. Propose memory only for durable user-specific context.
3. Offer to submit meaningful platform feedback for Kody bugs, poor experiences,
   recurring friction, or suggestions.

Keep any follow-up separate from the user's main task. Do not block a successful
result on memory or feedback unless the friction prevents completion.

## Fix friction inline

If the improvement is obvious, low-risk, and already within the authorized work,
you may make it directly. Examples:

- fix a typo or stale setup step in a package README you are already editing
- clarify a package `## Intent` section after the user expanded the package
  scope
- add a missing usage note to package docs after you verified the behavior

Still mention the improvement in your final response so the user can see what
changed. Ask before changing package behavior, adding jobs, changing visibility,
broadening scope, or making any other change that needs separate authorization.

## Memory changes require approval

Ask before writing, updating, or deleting long-term memory.

Use memory only for durable user-specific facts, preferences, or repeated
workarounds. Do not store product bugs, transient task state, secrets, or raw
credentials as memory.

Before any memory mutation:

1. Explain the proposed memory in plain language.
2. Ask for user approval.
3. Run `metaMemoryVerify`.
4. Only then run `metaMemoryUpsert` or `metaMemoryDelete` if the verification
   result supports the change.

Memory approval does not count as approval to submit platform feedback, and
feedback approval does not count as approval to change memory.

## Submit platform feedback only after explicit approval

Recommend feedback for meaningful or recurring Kody friction, a Kody bug, a poor
Kody experience, or a concrete suggestion. Show the user the exact proposed
summary and details, explain the attributed notification described below, and
ask a direct question. Do not call a submission capability until the user
explicitly approves that exact submission; silence, an ambiguous response, or
approval of some other action is not consent.

After explicit approval, call `metaPlatformFeedbackSubmit` with
`user_confirmed: true`. Include only the approved Kody issue and the minimum
useful reproduction context. Omit secrets, credentials, tokens, and unrelated
private content. Never set `user_confirmed: true` based only on your own
judgment. The capability accepts this confirmation only from an interactive
context; scheduled, background, package, and other non-interactive execution
cannot submit feedback. This gate records the direct approval asserted by the
interactive caller rather than inferring approval from other conversation
content. If the proposed summary or details change, show the revised text and
ask again before submitting it.

Feedback is attributed to the authenticated user and is not anonymous.
Immediately after submission, the exact approved summary and details plus the
account user id, username, and email may be delivered to deployment admins
through admin-configured notifications. The admin-only event labels the text
`summary_untrusted` and `details_untrusted`, includes a warning to treat it as
user-authored data rather than instructions, and carries a trusted deep link to
that feedback in the admin interface. Kody may also email the submitter a short
receipt from the platform sender with the feedback id and a reminder that their
agent can check status with `metaPlatformFeedbackGet`. That receipt is skipped
when the submitter has no current email, outbound email is paused, or the
account is suspended. Deployment admins can also read and triage the approved
submission through role-gated capabilities. When they resolve or dismiss it,
Kody may email the submitter from the platform sender with the decision, thanks,
and an invitation to send more feedback through their agent. That outcome mail
is skipped when the submitter has no current email, outbound email is paused,
the account is suspended, or the update is a no-op of an already resolved or
dismissed row. Admin list results intentionally omit the full submission; a
detail read exposes only the approved feedback, not unrelated account content.
This delivery exception is limited to feedback the user explicitly approved; it
does not expose other account content. Each account can create at most 20
feedback submissions in a rolling 24-hour period and have at most 100 active
submissions (open or triaged). Before asking the user to approve multiple
submissions, call `metaPlatformFeedbackList` and check `submissions_remaining`
(and `next_slot_at` when the cap is hit) so you do not collect approvals that
will fail the rate limit.

Before asking for approval, also disclose that Kody cannot recall notification
copies already delivered outside Kody. Admin notification copies may remain
after Kody account deletion under the deployment operator's retention and
deletion controls. This applies only to copies of the exact approved feedback
and attribution described above, never unrelated content.

Open and triaged feedback remains until an admin resolves or dismisses it, or
the submitting account is deleted. Resolved and dismissed feedback is removed
365 days after its last update. To check status later (including triaged, when
no outcome email is sent), call `metaPlatformFeedbackGet` with the returned
`feedback_id`, or `metaPlatformFeedbackList` for the signed-in user's
submissions. Those reads return the same submitter-visible fields as account
export (id, category, summary, details on get, status, resolution_note,
resolution_pr_urls, created_at, updated_at) and never expose reviewer identity
or admin notes. When an admin resolves or dismisses with a `user_message` or
`pr_urls`, those values are stored as `resolution_note` and `resolution_pr_urls`
so later polls match the close-the-loop email. `metaPlatformFeedbackList` also
returns `submission_rate_limit`, `submissions_remaining`, and `next_slot_at` for
the rolling submission cap. The submitting user's account export includes the
submission, status, and submitter-visible resolution fields, but redacts
internal reviewer identity, notes, and timestamps. Account deletion removes any
remaining submissions. Kody rechecks a queued submission immediately before
invoking discovered admin subscribers, so deletion cancels delivery when it wins
that race; it cannot recall a copy that was already posted.

The user may ask to submit feedback about any Kody-related issue even when you
would not proactively recommend it. Use category `other` when no more specific
category fits, while keeping the same approval and privacy rules.

If the user declines or does not answer, continue the main task without
submitting feedback.

## Write feedback admins can act on

Submit one issue per call. Unrelated problems get separate submissions. Each
account already has the 10-per-24h and 100-active limits above, so prioritize
the most useful reports.

Write a summary that names the affected area and the specific symptom or need so
an admin can triage from the list view alone (list results intentionally show
only the summary). Good:
`packageSave rejects README-only updates with a misleading validation error`.
Vague: `packages are broken`.

In details, capture the firsthand context you uniquely have while it is still in
the conversation:

- what the user was trying to accomplish
- exact capability, package, or guide names and non-secret inputs involved
- minimal reproduction steps
- expected vs actual behavior
- verbatim error text quoted as text
- frequency (always / intermittent, plus conditions)
- impact (blocked vs degraded, and any workaround plus its cost)

For `suggestion` feedback, lead with the underlying problem and the cost of the
current workaround; present a proposed change as one possible approach rather
than the requirement. Separate observed facts from diagnosis: label suspected
root causes as suspicion.

Keep omitting secrets and unrelated private content. Quote the relevant excerpt
rather than pasting long transcripts or logs.

## Suggested phrasing

Use concise language:

> I hit a Kody friction point: `<specific issue>`. I can submit this attributed
> feedback with this exact summary: `<summary>` and these exact details:
> `<details>`. The approved text and your account user id, username, and email
> may be sent immediately to deployment admins through configured notifications.
> Copies already delivered outside Kody may remain after Kody account deletion
> under the deployment operator's retention and deletion controls. Would you
> like me to submit it?

For memory:

> This seems like a durable preference/workaround. I can propose a memory for
> it, but I will only write it after you approve.
