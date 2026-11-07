---
title: Every personal agent needs a cloud
date: 2026-11-07
description:
  Personal agents build software to solve their users’ problems, and that
  software needs storage and an execution context
order: 1
category: essays
---

## The difference between an ad hoc question and a repeatable tool

Ask your agent "did any of the projects I follow announce anything new this
week?" and it can probably answer. It searches, reads a few release pages, and
gives you a tidy summary. That's an ad hoc question. It's answered once, and the
answer is done.

Now ask for the same thing every Monday morning, and only tell me what's new
since last time. That is a different request, even though it sounds almost the
same. It's a repeatable tool.

Picture a project announcement tracker built for that second request. To be
clear, this is a hypothetical. I haven't built it for this post. But the
questions it raises are real, and they show up the moment you try to build
anything like it:

- **Where do the seen items live?** "New since last time" means something has to
  remember what last time was. Not a vague sense of it. A list of announcement
  URLs, with dates.
- **How does it run again?** Monday at 8am, the tracker needs to start without
  you opening a chat window and asking nicely.
- **How do you come back to it?** On Thursday you want to look at what it found
  on Monday, or mark one announcement as worth a closer read. Scrolling back
  through a chat transcript to find Monday's summary is not an interface.

An ad hoc question needs a model and some tools. A repeatable tool needs a place
to keep its state, a way to run on its own, and somewhere you can return to.

## Software as an implementation detail

Here's the shift I keep coming back to. When a personal agent solves a problem
like this, the software it writes is an implementation detail. You asked for
Monday announcements. You didn't ask for an app. The agent wrote some code
because code is the reliable way to do the same thing every week.

That's what I mean by invisible software. The software is still there. It still
has bugs, it still needs to be correct, and you're still responsible for what it
does. What recedes is the friction: you didn't have to discover a product, sign
up, pay for it, and learn its settings before you got help. The tool was shaped
around your problem instead of the other way around.

Invisible doesn't mean there's nothing to look at. It means the software didn't
have to become a product before it could help you.

I talked through this idea in a video, with a couple of illustrative stories
about people whose agents built and adapted small tools for them:

> [!WATCH] https://www.youtube.com/watch?v=P00lzZaxv8U Watch: The Future of
> Software is Invisible

## What a repeatable tool actually needs

Go back to the tracker and list what it depends on.

**Persistent state.** The seen list has to survive between runs. This is worth
separating from memory in the sense most agents use the word. Preference memory
is "Kent likes short summaries and doesn't care about patch releases." That's
about the person, and any agent should be able to use it. Application state is
"these announcement URLs were already reported." That belongs to the tool, and
it has to be exact, not a fuzzy recollection.

**Stored, repeatable code.** Fetching, comparing, and formatting should be the
same code every Monday, not a fresh interpretation of a prompt.

**Triggers.** A schedule, a webhook, or an arriving email starts the run.
Without one, you are the trigger.

**Scoped integrations.** If the tracker reads a private GitHub org or posts to
Slack, its credentials should cover only that, and the code shouldn't hold a raw
token it could leak.

**A reachable interface.** Somewhere the result lives that you can open on
another day, from another device.

Then there's where all of that lives. It can't live inside one agent. I've
switched agents more than once in the last two years, and if the seen list,
code, and schedule live inside one agent's product, switching means rebuilding
the tracker. If it lives inside one person's agent, nobody else on the team can
use it or improve it.

So the tool needs a common home that doesn't depend on any one agent. That's the
point of the second belief on [our beliefs page](https://kody.codes/believe):
your agent is your choice, and switching agents should not mean starting over.
The home also can't become a new walled garden of its own. The first belief
there is that the best software is invisible, and that people shouldn't have to
open something new to benefit from it. A home that forces you into its own chat
app has just moved the wall.

## Code runs the work and shows the result

Code earns its place twice in a tool like this. First, it does the repeatable
work: fetch, compare, record, report. Second, it can present the result in a
form that fits.

For the tracker, the right view is probably a small table with a "read it"
checkbox. A spending tracker might want a chart, a booking flow a form, and
sometimes a short message is enough. Invisible software doesn't mean everything
happens in chat. The interface is whatever helps, and the agent can build that
too.

The test I use is simple. Can a person come back to the result without
reconstructing the task from conversation history? If the only way to see last
Monday's announcements is to scroll through a transcript and hope the agent
summarized them the same way, the tool isn't finished.

## Somebody still owns it

Once a tool runs on its own, all the usual engineering responsibilities come
back. They don't go away because an agent wrote the code.

- **Access.** What can this tool read and change? It should be the minimum it
  needs, granted on purpose.
- **Cost.** Every scheduled run costs something you should be able to see.
- **Failure.** When a feed changes shape, the tool will break. Someone should
  find out, and the failure should be visible somewhere other than silence.
- **Last success.** "When did this last work?" deserves a quick answer.
- **Stopping.** You need a way to turn it off that doesn't involve deleting it.
- **External effects.** Reading announcements is low stakes. Posting to a
  channel or emailing a customer is not, and those effects should be visible and
  approved before they start happening.

Hosting doesn't solve any of these by itself. Putting code on a server doesn't
make it reliable or secure. It makes it reachable. The rest is design: scope the
authority, make the effects inspectable, and keep a person in the loop where the
stakes are real.

## About that word "every"

The title says every personal agent needs a cloud. Let me qualify that honestly.

Plenty of agent work is transient. "Summarize this PDF" needs no state, no
schedule, and no interface beyond the answer. A local script you run by hand
doesn't need a cloud either.

The claim is about continuity. The moment a tool needs to run when you're not
there, remember what it did, or be reachable from your phone on Thursday, it
needs an execution context that's awake and storage that persists. A laptop
that's asleep at 8am Monday won't run your tracker, no matter how good the code
is.

"Cloud" here doesn't have to mean someone else's hosted service. A server you
run yourself counts. So does a hybrid, where some work runs on a machine you
control and the state lives somewhere durable. What matters is that the tool has
a home that outlives any one session and any one agent.

## Where Kody fits

This is the problem I built [Kody](https://kody.codes) to solve, so it's fair to
say how it maps.

Kody is a home your agent connects to over MCP, whichever agent you already use.
Memories hold preferences about you. Packages hold the code, with version
history, and durable storage holds application state like a seen list.
Credentials are used by name and filled in at the network boundary, only for
hosts you approved, so the code never holds the raw value. Jobs, webhooks, and
email triggers run saved packages with no model in the loop. And a package can
ship an app, so the tool has an interface you can return to.

On the responsibilities above, a few pieces are there today. Failures and recent
runs for every trigger show up on your Activity page. A job or webhook can be
turned off without deleting it. A webhook doesn't accept deliveries until a
person approves it, and a package can be locked so that every new version needs
an approval click on the website before it publishes. None of that makes a tool
safe on its own. You still decide what each tool may do.

More on the durable home idea is in
[Your agents' cloud](/blog/your-assistants-home), and on why so many automations
never got built, see
[The automations you never got around to building](/blog/the-automations-you-never-built).

So where do you start? Don't move your whole setup. Pick one thing you already
ask your agent for more than once. A weekly check, a recurring report, a list
you keep re-explaining.

Then ask the three questions from the tracker. Where would its state live? What
would start it? Where would you look at the result on another day? If the
answers are "nowhere," "me," and "scroll back," that's the task to turn into a
tool first.
