---
title: How to set up a team org for your AI-built apps
date: 2026-11-07
description:
  Your personal Kody org stays yours. Create a separate team org, decide what
  moves into it, set member permissions, and invite people with links.
order: 3
category: how-to
series: sharing-apps-with-your-team
---

Your first useful app probably lives in your personal Kody org. That is fine for
you. It stops being fine when five people depend on it. To give an AI-built app
a team home, you set up a **team org** next to your personal one.

A correction before you start, since it is a common assumption: you do not
convert your personal org into a team org. There is no setting for that. You
create a **separate** team org, and nothing from your personal org moves into it
automatically. That is a good thing. Your personal credentials, memories, and
experiments stay yours.

This post continues the made-up `release-checklist` example from
[part one](/blog/three-ways-to-share-an-ai-built-app). It reads GitHub and
Linear and shows a release checklist.

## Personal org vs team org

Every Kody account has a personal org, created at signup, with your username as
its handle. It can share a package one person at a time, as an outside
collaborator grant, but it has no members and no teams.

A team org has members, teams, a Grants page, and member settings. It is also
the billing and data boundary: its resources, usage, limits, and bill stay
inside it. If several people will rely on an app, it belongs there.

## Step 1: Create the team org

Create it from **Create organization** on the web, or have your agent call
`orgCreate`. Two things deserve a pause:

- **The handle is permanent.** `kody.codes/@<slug>` cannot be renamed later.
  Only the display name can change. Pick something you will still like in two
  years.
- **The org page is public by default.** That shows the org's name, photo, bio,
  and public packages. Members are never listed. If you would rather keep even
  that private, choose **Private** at creation or later in settings.

Plan limits cover how many orgs you can own, so check the
[Organizations guide](/docs/organizations) before you create one.

## Step 2: Decide what goes into it

Since nothing moves on its own, make a short list.

**Packages and apps.** To bring `release-checklist` over, fork it into the team
org: connect your agent to the new org and fork your personal package there. The
fork is a new package owned by the team org. Publish it from the team org and
that becomes the shared version. Check two things:

- Imports only work within one org. If the app imports another package from your
  personal org, fork that one too.
- The old copy keeps running in your personal org, with any grants you gave
  there. Decide whether to retire it, and tell people which one is current.

**Credentials.** This is the part to slow down on. Your personal GitHub token
should not quietly become the team's GitHub token. You can grant a personal
credential to a team org, but it then works there only in **your** own runs.
Nobody else can use it, Owners included. For a shared app, create credentials in
the team org itself, ideally ones meant for shared use. Then grant Use on them
to the people or teams that need them.

**Jobs and webhooks.** A scheduled job or webhook runs only after a person turns
it on for themselves, and every run acts as that person. Re-enabling it in the
team org is a deliberate choice of who it runs as.

## Step 3: Set member permissions

An Owner chooses what every Member can create without a grant, under
**Organization settings**, **Member permissions**:

| Setting                              | Default |
| ------------------------------------ | ------- |
| Members can create packages and apps | Off     |
| Members can create credentials       | On      |

Read those defaults carefully. Members cannot create packages until you allow
it, but they can add secrets, OAuth connections, and MCP servers. If you want
only some people creating, leave a setting off and give those people a targeted
create grant instead.

Neither setting lets a Member edit something someone else made. Changing an
existing package or credential still needs its own write access. Org-wide grants
are a separate tool, so look at them separately.

When a Member is refused, the error names the setting and points to the Grants
page, which is the clue to look for when someone says "it won't let me create
anything."

## Step 4: Invite people with links

You do not need everyone's email address. On the **Members** page, create an
invite link:

- It adds people as **Member** by default, optionally into default teams.
- It can be limited by number of uses and to verified email domains.
- It expires, after 7 days by default.
- The full URL is shown once. Kody keeps only a hash, and **Revoke** ends it
  right away.

Opening a link changes nothing. The person sees what it gives and who sent it,
then chooses **Accept** or **Decline**. For one known person, an addressed
invite works too.

Not everyone should be a member. A contractor who needs one app can stay an
**outside collaborator** with a grant on just that package. They see nothing
else in your org.

## Step 5: Know what membership costs

On the Pro plan, every live Owner and Member is a paid seat. Billing-only
members and outside collaborators are not seats. That is a real reason to keep a
contractor as a collaborator instead of a member, as long as their access is
what you want. Check [pricing](/pricing) for current plan details.

## What failure looks like

A few refusals you will see while setting up, and what they mean:

- **A Member cannot create a package.** The member setting is off and they have
  no create grant.
- **A teammate cannot open the app.** Membership alone does not grant app
  access. Part three covers this.
- **A job stopped.** The person it runs as lost access. It pauses and resumes
  once access is back. It never switches to someone else.
- **A fork fails to import something.** It still points at a package in your
  personal org.

## A prompt for your agent

This prompt plans the move without making it. Run it from an agent connected to
your personal org.

```text
I want to set up a separate Kody team org for my release-checklist app. Do not
create, fork, invite, grant, or change anything yet.
1. Inspect release-checklist: its imports, credential needs, jobs, webhooks,
   and who has access now.
2. Propose an org handle and say whether the org page should be public or
   private.
3. List what would need to be forked, which credentials the team org should
   create (by name and purpose only), and who should be a member versus an
   outside collaborator.
4. Recommend member permission settings and any targeted create grants.
Show the exact calls in order and wait for my approval before each one. Never
print credential values.
```

Next: choosing Read, Use, Contribute, or Manage for each person. Keep the
[Organizations guide](/docs/organizations) open for invite links, member
permissions, and seats.
