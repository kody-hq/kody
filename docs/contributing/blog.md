# Writing blog posts

The kody.codes blog is a small static catalog: Markdown files in
`packages/worker/src/blog/posts/`, imported in
`packages/worker/src/blog/catalog.ts`. The organization is deliberately small:
**one category per post, an optional series, one pinned post, no tags.** The
fixed lists live in `packages/worker/universal/blog-taxonomy.ts`; anything not
listed there fails the catalog parse and CI.

## Adding a post

1. Write `packages/worker/src/blog/posts/<slug>.md`. The slug is the file name:
   lowercase kebab-case, never `category`, `series`, or `rss`. A published slug
   is a permanent URL (`/blog/<slug>`); never rename one.
2. Add the default import and `{ slug, raw }` entry in `postSources` in
   `catalog.ts`.
3. Add the slug to `blogPostSlugs` in
   `packages/worker/universal/blog-post-slugs.ts` (the catalog test fails if the
   two lists differ).

## Frontmatter

```md
---
title: How to revoke AI agent access in one place
date: 2026-09-25
description: One or two sentences for the index, RSS, and meta tags.
order: 1
category: how-to
series: agent-credentials-for-team-leads
updated: 2026-10-12
featured: true
---
```

| Key                            | Required | Rule                                                                  |
| ------------------------------ | -------- | --------------------------------------------------------------------- |
| `title`, `description`         | yes      | Plain text, no quotes (the parser keeps them).                        |
| `date`                         | yes      | `YYYY-MM-DD` publish date.                                            |
| `order`                        | yes      | Integer tie-break for posts on the same date (lower first).           |
| `category`                     | yes      | Exactly one slug from the list below.                                 |
| `series`                       | no       | A series slug from `blog-taxonomy.ts`.                                |
| `updated`                      | no       | Last meaningful revision, not before `date`. Typo fixes do not count. |
| `featured`                     | no       | `true` pins the post as the index hero. At most one post.             |
| `image`, `imageAlt`, `ogImage` | no       | `/images/...` asset paths; `imageAlt` is required with `image`.       |

Any other key (including `tags`) fails the build.

## Inline screenshots

Blog screenshots live in Cloudflare R2, not in this repo. Do not commit files
under `packages/worker/public/images/blog/`. The worker serves
`/images/blog/<post-slug>/<name>.<ext>` from the `kody-community-assets` bucket
(binding `COMMUNITY_ASSETS`) at key `blog-images/<post-slug>/<name>.<ext>`, with
long-lived immutable caching, so upload a new file name instead of replacing an
object. Names are lowercase letters, digits, and dashes with an `avif`, `jpg`,
`jpeg`, `png`, or `webp` extension. The weekly post automation uploads its
screenshots there and hands the session ready paths.

Embed them as `![Caption](/images/blog/<post-slug>/<name>.webp)` or use the same
path in frontmatter `image`. Alt text is required, and never hotlink GitHub
attachment URLs; other hrefs render as links.

## Picking a category

Ask what the reader came to do:

| Category  | Pick it when the post...                                              |
| --------- | --------------------------------------------------------------------- |
| `essays`  | argues a position or explains why Kody works the way it does.         |
| `how-to`  | walks a reader through doing something: steps, checklists, playbooks. |
| `updates` | announces what shipped (weekly release notes, launches).              |
| `stories` | is about a person or team using Kody, in their words.                 |

If a post fits two, pick the one the title promises: "How to..." is `how-to`,
"Why..." is `essays`. Do not add a category for a single post; a new category
needs several posts that fit none of the four, and a taxonomy change in the same
PR.

## Series

Use a series for posts written to be read together (a guide in parts), not for
posts that merely share a topic. Add the series to `blogSeries` in
`blog-taxonomy.ts` (slug, title, one-line description) and set `series:` on
every part. Parts read oldest first by `date` and `order`; the series page and
the in-post series nav (part N of M, previous, next) are generated, so do not
hand-write "More in this series" lists. A series needs at least two posts.

## What the blog generates

- `/blog`: pinned post, series, latest posts outside `updates`, and the three
  newest updates. Category tabs link to the full archives.
- `/blog/category/<category>`: every post in the category, grouped by year (the
  archive; no pagination until a single category passes ~100 posts).
- `/blog/series/<series>`: every part in reading order.
- `/blog/rss.xml` and `/blog/category/<category>/rss.xml`.
- Per post: category and series links, reading time, updated date, series nav,
  up to three related posts (same category first), `/blog/<slug>.md`, and
  `/blog/<slug>/og.png` labelled with the category.

Search is left out on purpose: the category archives and the site search cover
the catalog at this size.
