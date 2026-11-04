---
title: Why "just use AWS Lambda" breaks down for teams using AI agents
date: 2026-11-03
description:
  Lambda can run the code your agents write. The trouble is everything around
  it, like IAM, secrets, deploys, and review. Here's where it breaks for teams.
order: 18
---

An engineer's agent wrote a nice little function: every hour, check Stripe for
failed payments, look up the customer in your CRM, and post a summary to the
support channel. Now it needs to run somewhere that isn't a laptop. Someone on
the team says, "Just put it on Lambda."

It's a reasonable suggestion. Lambda runs code on a schedule, scales to zero,
and your team probably already has an AWS account. For one function written by a
person, it's a fine answer.

For a team where agents are producing these little functions every week, it
starts to break down. Not because Lambda can't run the code. Because of
everything you have to do _around_ the code before Lambda will run it safely.

## The work around the code

Here's what "just put it on Lambda" actually involves for that hourly job:

1. **An IAM role.** Someone writes a policy. In practice, it's often broader
   than it should be, because narrowing IAM policies is tedious.
2. **Secrets.** The Stripe key and CRM key go into Secrets Manager or Parameter
   Store, and the function needs permission to read them. The function code then
   reads the plaintext into memory.
3. **A schedule.** An EventBridge rule, with its own permissions.
4. **Packaging and deploys.** Bundling the code and its dependencies, plus some
   infrastructure as code so it's reproducible. Terraform, CDK, SAM, or
   Serverless, depending on who set it up.
5. **Logs and alerts.** CloudWatch log groups, and an alarm if you want to know
   when it fails.
6. **Ownership.** Some account, some person, some cost center.

A person who knows AWS does all that in an afternoon. An agent can do most of it
too, but now you've given the agent AWS credentials broad enough to create IAM
roles, which is a much bigger trust decision than the original function.

## Where it breaks for agent-built code

The work above was designed for code written occasionally, by people, and
deployed deliberately. Agent-built tooling is different in a few ways:

- **Volume.** If each engineer's agent produces a couple of useful automations a
  month, that's a lot of IAM roles, secrets, and stacks, each one bespoke.
- **The agent touches the secrets.** In the Lambda model, the function reads the
  plaintext key at runtime. That's normal for human code. For code an agent
  wrote and can rewrite, it means the agent can write code that does anything it
  wants with that key.
- **The deploy path needs broad cloud access.** For an agent to ship to Lambda
  on its own, it needs credentials that can create functions and roles. Few
  teams are comfortable with that, so a person ends up in the loop for every
  deploy, and the agent's speed advantage disappears.
- **Nobody can find anything.** Each function lives in its own stack, often in
  whoever's AWS account was handy. When a teammate wants the same automation,
  there's no catalog to search.

## What a team actually needs

Strip it down and the agent-built hourly job needs:

- somewhere to run code on a schedule or in response to a webhook
- access to Stripe and the CRM without the code holding the keys
- a deploy step an agent can do without cloud admin rights
- a record of what ran and as whom
- a way for teammates to find and reuse it

That's the job [Kody](https://kody.codes) does. It's the layer under your team's
assistants, and it's built for code that agents write.

## The same job in Kody

The agent saves the function as a Kody **package**, a repo-backed TypeScript
project. Then:

- **Credentials are names, not values.** The package declares that it needs a
  Stripe and a CRM credential. Kody fills the keys in at the network boundary,
  only for each key's approved hosts. The code never holds the plaintext, so the
  agent can't write code that leaks it. That's covered in
  [Your engineers are handing private keys to AI agents](/blog/engineers-are-handing-private-keys-to-ai-agents).
- **No IAM to write.** Access comes from the person running it: a scheduled job
  runs as whoever turned it on, with their live access in the org.
- **Publishing is the deploy.** The agent publishes the package, and server-side
  checks run (manifest, docs, bundle, typecheck, lint). No cloud admin keys.
- **The schedule is a job.** A person approves turning it on, so "an agent
  deployed a cron" always has a human decision attached.
- **What ran is recorded.** The Activity page shows each run with who started it
  and its log lines.
- **It's findable.** It lives in your team org, where teammates' agents can find
  it and run it, with the sharing rules from
  [How to share AI agent workflows across a team](/blog/share-ai-agent-workflows-across-a-team).

## Where Lambda (or something like it) still wins

I want to be fair about this, and Kody's own docs are clear about it. Kody runs
packages on Cloudflare Workers isolates. It doesn't host containers or
long-running processes. Some work doesn't fit in an isolate:

- huge dependency graphs, like PDF rendering libraries
- native addons, headless browsers, or large WASM
- multi-minute CPU work

For those, Kody's guidance is to keep the package as a thin orchestrator
(authenticate, call the heavy process, store results, notify) and run the heavy
part on infrastructure you operate: a Cloudflare Container, a Fly machine, or
yes, a Lambda function. The credentials and the orchestration stay in Kody. The
heavy compute lives where heavy compute belongs.

So it's not "Kody instead of AWS." It's "don't make every small agent-built
automation a cloud infrastructure project."

## A simple rule for your team

Here's the line I'd draw:

- **Agent-built glue** (call a few APIs, transform, notify, on a schedule or
  webhook): Kody package and job.
- **Heavy compute or long-running services:** your cloud, called from a thin
  Kody package.
- **Production services your team owns and operates:** your normal deploy
  pipeline, as before.

## Try it on the next "just use Lambda"

Next time someone suggests Lambda for something an agent wrote, try Kody first.
[Connect your agent](https://kody.codes/onboarding) and ask it: "Save this as a
Kody package and set it up as an hourly job." If it turns out to be too heavy,
the [heavy work offload guide](https://kody.codes/docs/heavy-work-offload) shows
how to split it.
