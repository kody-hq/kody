---
id: making_great_apps
title: Making a great app
summary:
  Start every package app from a recommended starter so it ships with light and
  dark themes, a mobile layout, accessible components, loading and error states,
  and sign-in and storage already wired up. Ask who the app is for, fork a
  starter, fill in content and logic, then run `kody app check`.
category: platform
---

# Making a great app

Use this guide when you are about to make a package app. Do these four things in
order. Each one has more detail below.

1. **Ask who the app is for.** Check in with the person before you build.
2. **Fork a recommended starter.** Search lists them under "Making an app".
3. **Fill in content and logic.** Keep the starter's design system and states.
4. **Check it.** Run `kody app check` and fix what it shows.

## Ask who the app is for

A short conversation saves a rebuild. Ask the person:

- Who will use it, and on which device (phone, laptop, both)?
- What is the one thing they need to do in it?
- Should visitors sign in, and whose data does it keep?

Write the answers into the app's README so the next agent sees them too.

## Fork a recommended starter

Run `search({ query: "make an app" })`. The "Making an app" section lists the
starters Kody recommends, best first, with what each one is for and the
`communityFork` call to copy it. Pick the one whose "Use when" matches the
person's answers.

Every starter is an ordinary package with a `kody.starter` manifest in
`package.json`. Its `customize` field tells you where to work:

- `customize.themeTokens`: the CSS custom properties for color, type, spacing,
  and radius in light and dark.
- `customize.routes`: the folder of pages.
- `customize.content`: the copy, names, and sample data to replace.

## Fill in content and logic

Change the content and add your pages. Keep what makes the starter feel
finished:

- **Theme tokens.** Style with the shared token names so light and dark both
  work: `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`,
  `--color-border`, `--color-primary`, `--color-on-primary`, `--color-danger`,
  `--font-sans`, `--radius`, and `--space-1` through `--space-4`. Adjust the
  palette in the tokens file to give the app its own look.
- **Mobile first.** Check every page at a phone width. Use the starter's layout
  and keep tap targets at least 44px.
- **Accessible components.** Reuse the starter's buttons, fields, and dialogs.
  Give every input a label and every icon button an accessible name.
- **Loading and error states.** Show the starter's pending and error views for
  every request, and an empty state for every list.
- **Sign-in and storage.** Read the visitor from the starter's session helper
  and save data through its storage helper rather than adding a new one.

For the app entry, client bundle, and publishing details, see
[Package apps](./package-apps.md) (`guide:package_apps`).

## Check it

After you build, run `kody app check` in the package folder and fix what it
shows. It looks at the running app in light and dark and at phone width, so it
catches the same things a person would notice first.
