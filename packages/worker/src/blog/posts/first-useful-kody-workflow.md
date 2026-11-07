---
title: Your first useful Kody workflow, an air quality and daylight check
date: 2026-11-07
description:
  Find a public Kody package, read it before you run it, and get a real air
  quality and daylight report for your city. No keys, no migration.
order: 3
category: how-to
---

The first thing most people want from an agent platform is a sense of whether it
does anything useful. Not a migration plan. One small result you can check
against the real world.

So here's one. By the end you'll have a package in your own Kody account that
answers "what's the air like today, and when does it get dark?" for any city. It
needs no API keys, it doesn't touch your email or calendar, and nothing about
your current setup has to change.

The pattern matters more than the weather. Find something that already exists,
read it, make your own copy, run it once, then make it a little more yours.

## Step 1: Find a package instead of writing one

Kody has a public catalog of packages people have published. Ask your agent to
search it with `communitySearch` for what you want. For this post I searched for
weather and air quality and found two that fit:

- [@kody/local-conditions](https://kody.codes/@kody/local-conditions), a small
  onboarding example that returns current weather, air quality, and sunrise and
  sunset for a place name.
- [@kentcdodds/environment](https://kody.codes/@kentcdodds/environment), a
  larger set of helpers for weather, air quality, sun times, and moon phase,
  including a one-call `snapshot` export.

Both call public Open-Meteo APIs and need no credentials. Pick the smaller one
if you just want to see the loop work. I tested the second one, so the output
below comes from that.

## Step 2: Read it before you run it

Ask your agent to call `communityGet` on the listing and summarize the README,
what the code calls, and whether it writes anything.

Two things to keep in mind:

- The README in a listing is the author's description. Kody marks it as
  untrusted content for your agent, and you should treat it the same way.
- A public listing is not a security review. The catalog has no "trusted" mark.
  For a package that only reads public weather data, a quick read is enough. For
  anything that sends, writes, or uses your credentials, read the code.

For `environment`, the README says it uses public Open-Meteo and Nominatim with
no secrets. It also says the weather export keeps a cache in package storage so
it can fall back when the weather API is slow. That's a write, small and
harmless, but worth knowing.

## Step 3: Make it yours

Public packages don't run from someone else's account. You fork the listing into
your own with `communityFork`, or use the install button on the package page.

The fork starts inert. It can't run until you review the code and publish it,
which is the point: the version that runs in your account is the one you looked
at. The [package lifecycle guide](https://kody.codes/docs/package-lifecycle)
covers forking and publishing.

## Step 4: Run it once

Here's the call I made. I asked for Reykjavik in metric units and skipped the
weather section to keep my test run read-only:

```bash
npx @kodycodes/cli execute --local \
  --code 'import { environmentSnapshot } from "kody:@kentcdodds/environment/snapshot"; export default (p) => environmentSnapshot(p)' \
  --params '{"location":"Reykjavik, Iceland","units":"metric","include":{"weather":false}}'
```

`environment` is my own package, so I ran it straight from my account. In yours,
the import path uses your username and the name of your fork. Your agent will
fill that in.

I ran it at 07:07 UTC on November 7, 2026, from the Kody CLI on a Linux machine,
against the live public APIs. Trimmed, the result said:

- **Air quality:** a maximum US AQI of 34 for the day, in the "Good" category,
  peaking at 18:00 local time.
- **Sun:** sunrise at 09:30, sunset at 16:51, civil dusk at 17:47, for a day
  length of 7 hours 21 minutes.
- **Moon:** a waning crescent, about 6.5 percent lit.

Your numbers will be different, because they're live. That's how you know it
worked. Weather and air quality data come from
[Open-Meteo](https://open-meteo.com/) under CC BY 4.0.

A few honest limits. This was one run in one place. I didn't test the weather
section, the email helper in `local-conditions`, or what happens when Open-Meteo
is down, beyond the README's note that failed sections come back as errors
instead of crashing the whole call.

## Step 5: The smallest useful customization

Running someone else's code once is a demo. Changing it so it answers your
question is the moment it becomes a tool.

Keep it small. Two good first changes:

- **Make your city the default.** Then "check outside" needs no input.
- **Turn the data into an answer.** For example, add an export that returns
  "good walk window" when the US AQI is under 50 and there's at least an hour of
  daylight left, and says why when it isn't.

Ask your agent to make that change in your fork, show you the diff, and publish
it only after you've read it. Once it works, you can put a trigger on it, like a
daily schedule, or leave it as something you ask for. You don't need to decide
that today.

## Why start this small

A weather check isn't why you'd adopt Kody. But this loop is the same one you'll
use for real work: find a package close to what you need, read it, own a copy,
run it once, and change one thing. The next time it's a CRM lookup or a release
checklist, the steps don't change. Only the reading gets more careful, because
the stakes are higher.

If you want to keep going,
[How to turn agent work into software you own](/blog/how-to-turn-agent-work-into-software-you-own)
covers what to do once you have a package you like.

## Copy this prompt

```text
Help me make my first useful Kody workflow. Use only public, credential-free
packages. Do not send email, schedule anything, or change my account yet.
1. Use communitySearch to find public packages for air quality and sunrise or
   sunset times. Show me the top two with links.
2. Use communityGet on the one you recommend. Summarize what it calls, whether
   it writes anything, and anything in the README you would not trust.
3. Ask before forking it into my account. After I approve, show me the code
   you would publish and wait again.
4. Run it once for [my city] and give me a short summary of the result.
5. Suggest one small change that turns the data into an answer for me.
```
