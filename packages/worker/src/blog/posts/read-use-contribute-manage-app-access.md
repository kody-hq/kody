---
title:
  Read, Use, Contribute, or Manage? Picking the right access for each teammate
date: 2026-12-18
description:
  What each Kody access preset lets a teammate run, read, change, and publish,
  what no preset grants, and how to check the access you gave.
order: 1
category: how-to
series: sharing-apps-with-your-team
---

You have a team org and a shared app. Now each person needs the right access to
it. Kody gives you four presets: **Read**, **Use**, **Contribute**, and
**Manage**. Picking the right access for each teammate is mostly about one
question per person: what should they be able to do?

This post continues the made-up `release-checklist` example from the
[series](/blog/series/sharing-apps-with-your-team). It reads GitHub and Linear
and shows a release checklist. Nothing here is a real team.

## The four presets on a package

| Preset         | Read source | Run it | Change it | Publish and share |
| -------------- | ----------- | ------ | --------- | ----------------- |
| **Read**       | Yes         | No     | No        | No                |
| **Use**        | Yes         | Yes    | No        | No                |
| **Contribute** | Yes         | Yes    | Yes       | No                |
| **Manage**     | Yes         | Yes    | Yes       | Yes               |

- **Read** means view, clone, and fork the source. Nothing runs.
- **Use** adds running your live package.
- **Contribute** adds pushing changes to it.
- **Manage** adds publishing, deleting, and choosing who else has access.

Org Owners already hold everything, so they never need a grant.

## The app is a separate resource

This is the detail that trips people up. A package and its hosted app are
separate things to grant. A Use grant on the `release-checklist` package lets
someone run the package from their agent. It does not, on its own, let them open
the app in a browser. Opening the app needs Use on the app itself.

Membership does not cover it either. A new Member of your team org holds the org
basics and whatever they are granted. They do not get app access by default. If
you want a whole team to run every app, an Owner can grant that org-wide to a
member or team. If you want everyone in the org to use one package, one grant to
the org covers current members and anyone who joins later, and someone who
leaves loses it right away.

So when you share, check two lines: the package grant and the app grant.

## Who you can grant to

Each grant goes to one of these:

- **A person** in the org.
- **A team**, so access follows team membership.
- **Everyone in this organization**, as a single live grant.
- **An outside collaborator**, someone who is not a member. They see that one
  resource and catalog search, nothing else in your org.

## What no preset gives

Presets are about one resource. Several things are deliberately not part of
them:

- **Billing.** No preset includes billing permissions, Manage included.
- **Secret values.** No preset reveals a secret. Not Use, not Manage.
- **Credential use.** A grant on the package does not let someone use the team's
  GitHub or Linear credential. When they run the package directly, each
  credential needs its own Use grant for that person.
- **Creating new things.** Making new packages or credentials is controlled by
  member permissions and create grants, covered in
  [part two](/blog/set-up-a-team-org-for-ai-built-apps).

## When Contribute is riskier than it looks

Some credentials always act as your org, no matter who runs the package. Kody
calls these **unmappable**. Anyone who can change such a package could change
its code to use those credentials however they like.

Kody handles this in three ways:

- **A warning at share time.** Granting Contribute or Manage still succeeds, but
  returns a warning that names each such credential (never its value).
- **Owner-only changes.** While a package has unmappable credentials, only
  Owners can push or publish it. Collaborators keep running it.
- **A per-grant exception.** An Owner can allow one person or team to change it
  anyway, on their grant.

Treat the warning as information, not protection. If you turn on the exception,
you are trusting that person with what those credentials can do.

## A starting point for the release checklist

One reasonable mapping, to adjust for your team:

| Who                          | Package    | App    |
| ---------------------------- | ---------- | ------ |
| Release managers team        | Contribute | Use    |
| Everyone in the org          | Use        | Use    |
| The author plus one backup   | Manage     | Manage |
| A contractor (outside)       | Use        | Use    |
| A client who wants their own | Read       | None   |

The contractor stays an outside collaborator on just this package and app, and
connects their agent with your org selected. The client gets Read so they can
fork their own copy with their own credentials, as in
[part one](/blog/three-ways-to-share-an-ai-built-app).

## Check the access you actually gave

A grant you did not test is a guess. After you share, check that each person can
do what you intended and is refused for the rest:

- **Read:** they can view and fork the source. Running the original is refused,
  and the app shows a no-access page.
- **Use:** they can run it. A push is refused.
- **Contribute:** they can push. Publishing is refused.
- **Manage:** they can publish and see the Collaborators tab.
- **No grant:** the package returns not found, the same as one that does not
  exist.
- **Unmappable credentials:** a collaborator's push is refused with
  `unmappable_credentials`, naming the credentials, unless an Owner allowed
  them.

Ask a teammate to try each one, or have an agent compare the grant list against
your plan. Owners can see everything, so testing as yourself proves very little.

## A prompt for your agent

This prompt audits and proposes. It changes nothing until you approve.

```text
Audit access to my release-checklist package and its app in my Kody team org.
Do not grant, revoke, or change anything yet.
1. List every grant on the package and on the app: person, team, everyone in
   the org, or outside collaborator, with the preset.
2. Flag anyone who can open the app but not run the package, or the reverse.
3. Say whether the package has unmappable credentials and who could change it.
4. Compare against this plan and list the differences: [your table]
Then show the exact calls you would make and wait for my approval. Never print
credential values.
```

The full rules are in the [package sharing guide](/docs/package-sharing). Next
in the series: who a shared app runs as, and how an Owner chooses.
