---
title: How to give an AI agent repo access without giving it your GitHub token
date: 2026-11-03
description:
  Let an AI agent read repos, open PRs, and check CI without ever seeing a
  GitHub token. A step-by-step setup with fine-grained tokens and Kody.
order: 2
---

Here's a request I see all the time. An engineer wants their agent to pull open
PRs across a few repos every morning and summarize what's blocked on review.
Reasonable. So the agent asks for a GitHub token, the engineer goes to
**Settings, Developer settings**, clicks "Generate new token (classic)," checks
`repo` because that's the box that makes errors go away, and pastes the result
into the chat.

That token can now push to every private repo the engineer can reach, in every
org they belong to, until somebody remembers to delete it. And the plaintext is
in a chat transcript.

The task needed read access to pull requests in four repos. The token grants
something much closer to "be this engineer on GitHub." This post is about
closing that gap without making the agent less useful.

## Two separate problems

It helps to pull this apart, because people tend to solve one and assume they've
solved both:

1. **Scope.** What is the token allowed to do at GitHub? That's decided when the
   token is created, and only GitHub can enforce it.
2. **Custody.** Who can read the token? Today, the answer is usually "the model,
   the transcript, and whatever file it ended up in."

A narrowly scoped token pasted into chat is still a leak waiting to happen. A
token nobody can read but that can delete repos is still a big blast radius. You
want both: a token that can only do the job, held somewhere the agent can use it
without seeing it.

## Step 1: make a token that matches the job

GitHub's **fine-grained personal access tokens** are the right tool here. The
classic OAuth App scopes are coarse: the provider guide in the Kody docs calls
out that `repo` is the only scope that reaches private repositories, and it
includes write. Fine-grained tokens let you pick repositories and permissions
one by one.

For the morning PR summary:

1. Go to
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Set **Resource owner** to the org that owns the repos.
3. Under **Repository access**, choose **Only select repositories** and pick the
   four repos.
4. Under **Repository permissions**, set **Pull requests** and **Contents** to
   **Read-only**. Add **Commit statuses** or **Checks** read-only if you want CI
   results. Leave everything else at **No access**.
5. Pick an expiration. 90 days is a sensible default for something you'll
   revisit.

If the agent's job grows later (say it should also comment on PRs), you edit the
token's permissions at GitHub. You don't hand over a broader one "just in case."

## Step 2: save it where the agent can use it but can't read it

This is where [Kody](https://kody.codes) comes in. Kody sits under whatever
assistant your engineer already uses and holds credentials on its side. When you
ask the agent to connect GitHub, a Kody-connected agent doesn't ask you to paste
the token. It sends a link to a Kody page, prefilled with:

- a name, like `githubAccessToken`
- a description of what it's for
- the approved host: `api.github.com`
- optionally, an expiry that matches the one you just set at GitHub

You paste the token into that page. It never goes through the conversation.

From then on, code refers to the token by name. Kody fills the value in at the
network boundary, only over HTTPS, and only for `api.github.com`:

```ts
const response = await fetch(
	'https://api.github.com/repos/acme/web/pulls?state=open',
	{ headers: { Authorization: 'Bearer {{secret:githubAccessToken}}' } },
)
```

If anything tries to send `{{secret:githubAccessToken}}` to any other host, the
request is refused. If GitHub's response echoes the token, Kody redacts it
before the code sees it. And there's no capability that returns the value, so
there's nothing for an injected instruction to ask for. When the expiry passes,
Kody treats the token as missing and stops sending it, which is a nice backstop
if the GitHub side gets forgotten.

## Step 3: turn the task into a package instead of a prompt

If the agent writes that fetch call fresh every morning, it works, but you're
trusting the model to write the same code correctly every time, and you can't
review what it'll do tomorrow.

The better move is to save the PR summary as a Kody **package**: a small,
repo-backed TypeScript project with named exports. The package declares the
credential it needs in `package.json#kody.credentials`, and at runtime it gets
an opaque client for it:

```ts
import { credential } from 'kody:runtime'

export default async function openPullRequests(params: { repo: string }) {
	const github = await credential('github')
	const response = await github.fetch(
		`https://api.github.com/repos/${params.repo}/pulls?state=open`,
	)
	return response.json()
}
```

`credential('github')` returns a client with `fetch`, not a token. Kody picks
the matching saved GitHub credential, and if there's more than one it stops and
asks instead of guessing.

Now the behavior is code you can read, diff, and version. You don't have to
start from scratch, either. There's a public `@kody/github` package in the Kody
community you can fork into your account and trim down. A fork is a copy you
own, so you can delete the exports you don't want the agent to touch.

## Step 4: let it run without the agent

Once the package exists, the morning summary doesn't need an agent session at
all. A Kody **job** can run the export on a schedule. No model is in that loop,
so it does exactly what the code says, and the run shows up in your account's
**Activity** page with who started it and how.

## Why this is better for a team lead

Compare where you ended up with where you started:

|                      | Classic token in chat           | Fine-grained token in Kody  |
| -------------------- | ------------------------------- | --------------------------- |
| What it can do       | Write to every private repo     | Read PRs in four repos      |
| Who can read it      | Model, transcript, config files | Nobody, including the agent |
| Where it can be sent | Anywhere                        | `api.github.com` over HTTPS |
| What runs            | Whatever the model writes today | A versioned package         |

The agent is just as useful. It can still read the repos, summarize the PRs, and
tell you what's stuck. It just can't become you on GitHub, and it can't leak a
token it never saw.

For the general version of this pattern across every provider, read
[least-privilege tokens for AI agents](/blog/least-privilege-tokens-for-ai-agents).
For why keys in agent context are risky to begin with, start at
[Your engineers are handing private keys to AI agents](/blog/engineers-are-handing-private-keys-to-ai-agents).

## Try it

[Connect your agent to Kody](https://kody.codes/onboarding), then ask it: "Set
up GitHub in Kody with a fine-grained token for these repos, read-only pull
requests." It'll walk you through the token page and send the save link. The
full steps are in the [GitHub provider guide](https://kody.codes/docs/github).
