---
title: Every install is a fork you own
date: 2026-07-20
description:
  In most ecosystems, installing someone's automation means renting a black box.
  In Kody's community, one-click install creates a fork you own. Here's why that
  changes how you treat other people's code.
order: 5
category: essays
---

Think about the last time you installed someone else's automation. A browser
extension, a Zapier template, a marketplace app. You clicked install, it started
doing things, and from that moment on you were a tenant. You couldn't read what
it actually does. You couldn't change the part that almost fits your workflow
but not quite. And when the author updated it, abandoned it, or got acquired,
you found out the same way everyone else did: something broke.

I've spent my career teaching people to read code, and it still bugs me how much
of our tooling is built on the assumption that you won't. So when I built the
community side of [Kody](https://kody.codes), I made one decision that shapes
everything else:

**In Kody's community, every install is a fork you own.**

Not a subscription to someone's code. Not a pointer to their copy. When you
click Install on a public package, Kody creates a published fork in your
account. Your copy, in your account, yours to open, read, edit, schedule, and
run. The original author can't change it out from under you, because it isn't
theirs anymore.

## The ownership ladder

Here's the mental model I want you to walk away with. There's a ladder you climb
with any piece of software you depend on, and each rung is a level of ownership:

1. **Install it.** One click at
   [kody.codes/community](https://kody.codes/community). You now have a working
   fork.
2. **Open it and read the code.** Packages are repo-backed: real code with a
   `package.json` and version history, not a config blob. You can see exactly
   what it does before you trust it with anything.
3. **Change it.** The package almost fits? Make it fit. It's your fork. Ask your
   agent to tweak it, or edit it yourself.
4. **Schedule it.** Turn it into a job that runs on your schedule, with your
   secrets, on infrastructure that doesn't care whether your laptop is open.
5. **Publish your improved version back.** If your changes would help someone
   else, `communityPublish` puts your version out there, MIT licensed, for the
   next person to fork.

Most ecosystems stop you at rung one. The whole business model depends on you
staying there. Kody's community assumes you'll keep climbing, and every rung is
designed to be one conversation with your agent away.

You don't have to climb. Plenty of packages will work fine for you exactly as
installed. But the ladder is there, and knowing you _can_ read and change the
thing changes your relationship with it, even when you don't.

## You can only rate what you run

One design decision falls straight out of this model, and I think it's worth
calling out: **ratings require a fork.** You cannot rate a package you haven't
installed.

That sounds restrictive until you think about what a rating is supposed to mean.
In an app store, ratings are a popularity contest mixed with a support queue.
"One star, didn't work on my phone." In a commons, a rating should mean "I ran
this code, in my account, with my data, and here's how it went." Requiring the
fork is how you get that. You should only rate what you actually run.

Stars are separate. A star is a bookmark: "this looks interesting, I want to
find it later." No fork required, no judgment implied. Keeping the two apart
means the rating signal stays honest and the bookmark signal stays cheap.

## App store or commons

The difference I keep coming back to is the difference between an app store and
a commons.

An app store is a distribution channel. The relationship is vendor to customer:
they ship, you consume, and the platform sits in the middle taking a cut and
deciding what's allowed. Nothing wrong with that model for a lot of software.
But it's a strange fit for the small, personal automations an assistant runs on
your behalf, because those are exactly the programs you most need to trust, and
exactly the programs you're most likely to want to adjust.

A commons works differently. Someone publishes a package because they built
something useful for themselves and figured you might want it too. You fork it
because you do. Maybe you improve it and publish your version back, and now
there are two, and the next person picks whichever fits better. Code flows
through the community instead of being licensed out of it. MIT licensing on
published packages isn't a legal footnote here; it's the whole point.

There's a trade-off, and I'll name it plainly: a fork is yours, which means
maintaining it is yours too. If the original author ships an improvement next
month, it doesn't flow into your copy automatically. You'd fork again or port
the change over. That's real friction, and app stores genuinely spare you from
it. I'll take the friction, because the alternative is code I depend on but
can't inspect, running with access to my accounts, changing whenever someone
else decides it should. I've been burned by that trade before. You probably have
too.

## Try the ladder yourself

If you want to see what this feels like, the loop is short. Browse
[the community](https://kody.codes/community), install something small, then ask
your agent to show you the code. That second step is the one most people have
never done with software they installed, and it's the one that makes the rest of
the ladder feel real. The docs on
[public packages](https://github.com/kody-hq/kody/blob/main/docs/use/community-packages.md)
and
[packages generally](https://github.com/kody-hq/kody/blob/main/docs/use/packages.md)
cover the details, and the whole platform is
[Fair Source](https://github.com/kody-hq/kody) if you want to go deeper than
that.

If you don't have an account yet,
[create one at kody.codes/signup](https://kody.codes/signup). And once you're
in: don't stop at rung one. The code is yours. Read it.
