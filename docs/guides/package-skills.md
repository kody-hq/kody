---
id: package_skills
title: Ship Agent Skills in a package
summary:
  Put skills/<name>/SKILL.md in a package, publish, and expose them over MCP to
  hosts that support Skills-over-MCP.
category: platform
audience: agents
---

# Ship Agent Skills in a package

> [!NOTE] Serving skills over MCP is behind the `mcp-skills-extension` feature
> flag because host support is partial and the shape may change. Signed-in users
> can turn it on from this page. Authoring and publishing skills works with the
> flag off.

A package skill is an [Agent Skill](https://agentskills.io/specification) that
lives inside a Kody package. The package stays the source of truth; Kody
validates it at publish and, for hosts that ask, serves it over MCP.

## Layout

```text
my-package/
├── package.json
├── README.md
├── AGENTS.md
├── src/index.ts
└── skills/
    └── hello-skill/
        ├── SKILL.md          # required
        ├── references/
        │   └── checklist.md  # optional
        ├── scripts/          # optional
        └── assets/           # optional
```

Rules:

- One directory per skill at `skills/<name>/SKILL.md`.
- `<name>` is lowercase letters, digits, and single hyphens (max 64), and must
  equal the `name` in the frontmatter.
- No `kody.skills` manifest key. The directory convention is the declaration.

## Minimal `SKILL.md`

```md
---
name: hello-skill
description:
  Greets the user by name. Use when the user asks for a friendly hello or wants
  to see how package skills work.
---

# Hello skill

1. Ask for the person's name if you do not have it.
2. Reply with a short greeting.
3. Read `references/checklist.md` before sending anything longer than a
   sentence.
```

`name` and `description` are required. `description` is at most 1024 characters
and should say what the skill does and when to use it. Optional frontmatter:
`license`, `compatibility`, `allowed-tools`, and a string-to-string `metadata`
map.

## Publish

Skills ride the normal publish path. Publish checks add a `skills` check:

```text
skills ok   Validated 1 package skill: hello-skill.
skills fail Skill "skills/hello-skill/SKILL.md" is missing frontmatter "name".
```

A malformed skill fails publish, like any other check, and nothing goes live. On
success Kody digests every file under each skill directory and stores a
content-free index per published version. Packages without `skills/` are
unaffected. See [Package authoring](./package-authoring.md) and the
[package lifecycle](./package-lifecycle.md).

## Browse skills in Kody

Open **Skills** in the workspace sidebar to browse published skills across
packages you can read. Use **All skills** for a flat list or **By package** to
group them. Search matches skill names, descriptions, and package names.

Select a skill to read its instructions and supporting files. Markdown has
rendered and raw views; other text files show their source, and binary files can
be downloaded. Open **History** to read archived published versions of a skill
and its supporting files. **Show changes** compares the selected file with
another version, including added and removed files. Version choices show the
package commit and publication time, plus the publisher when recorded, not
mutable drafts.

People with package write access can choose **Restore this version**, then
**Restore and publish**. This restores only that skill directory, including
supporting files and binary assets, as a new revision. Other skills and package
files stay unchanged. Normal publish checks and approval rules still apply. If
the package changes while history is open, reload before restoring. Read-only
collaborators can browse and compare versions but cannot restore. History
includes versions whose skill indexes and source snapshots are still available.
It does not reconstruct versions from before skills were indexed.

Browsing does not require the Skills-over-MCP feature flag or a connected agent.
Package read permissions still apply.

## Over MCP

When all of these are true, a connection serves the package's skills:

1. The `mcp-skills-extension` flag is on for the signed-in user.
2. The client connects on the 2026-07-28 MCP lane and declares the
   `io.modelcontextprotocol/skills` extension in that request's `_meta` client
   capabilities (the lane is stateless — there is no initialize handshake).

Then the connection answers:

```text
skills/list              -> [{ name, description, uri: "skill://you/my-package/hello-skill/SKILL.md", ... }]
skills/get               -> one skill's SKILL.md plus its file index (uri, digest, size)
resources/read           -> skill://you/my-package/hello-skill/references/checklist.md
```

Results are scoped to packages that connection can already use (your own, plus
shared or imported ones). The tool surface stays `search`, `execute`, and `api`.
With the flag off, or a client that does not advertise the extension, the MCP
surface stays those three tools.

## Which hosts support it

Honest status against the
[official extension matrix](https://modelcontextprotocol.io/extensions/client-matrix):

| Host                               | Skills over MCP                     |
| ---------------------------------- | ----------------------------------- |
| ChatGPT                            | Partial (import at submission time) |
| fast-agent                         | Partial                             |
| MCP Inspector                      | Partial                             |
| Claude Desktop / claude.ai, Cursor | No (empty Skills cell)              |

Hosts that do not advertise the extension can use the skill through search.
Discover it, then open the file:

```text
search({ entity: 'package:@you/my-package#skills/hello-skill/SKILL.md' })
```

## Turn it on

Signed-in users can opt in from the callout at the top of this page.
Experimenters get the flag when an admin enables `mcp-skills-extension` for the
`experiments_opt_in` audience. Default is off.

## Skill registries

A package can act as a skills registry by shipping many `skills/<name>/`
directories. A platform-wide personal registry such as `@kentcdodds/skills` is
out of scope for this feature.

See also: [Connect your agent](./connect-your-agent.md),
[Package lifecycle](./package-lifecycle.md), and
[Package authoring](./package-authoring.md). Decision record:
[0058](../contributing/decisions/0058-skills-over-mcp-progressive-enhancement.md).

## Read metrics

The Skills page shows the last 30 days of instruction reads, supporting-file
reads, distinct people, most-read skills, and recent reads with reader
attribution. The Overview includes a smaller Skills widget. Published skill and
package counts reflect the current catalog; read totals include readable
packages that no longer publish skills.

Kody records authenticated reads through MCP skill resources, search file
results, repoReadFile, the Skills viewer, the package file viewer, and raw
package file requests within an organization. Discovery and index requests,
failed reads, HEAD requests, and browser preloads do not count. Browser
acknowledgements are signed, bound to the reader and snapshot, and deduplicated
on retry. Supporting-file reads are separate from SKILL.md reads. Repo sessions
read mutable drafts, so their logs carry a file digest and no published commit.

Each content-free event records the organization, person or automation,
connection, channel, time, package, skill, file, version, and digest. Events
live in the organization's durable RunLog, are included in account exports, and
are removed with account deletion. The 30-day dashboard window does not expire
the underlying events. Metrics are filtered by package read permission.

A read is evidence that Kody delivered or displayed a file, not proof that an
agent followed its instructions or completed a task. Anonymous visitors, local
Git file reads, and cached or offline agent reads cannot be attributed to an
organization and are not counted. There is no historical backfill.
