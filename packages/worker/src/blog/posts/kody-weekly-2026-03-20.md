---
title: Kody weekly: Saved skills now take parameters
date: 2026-03-20
description: Saved skills can declare typed parameters, plus 3 other updates: GitHub GraphQL access, skill run hints, and mobile layouts.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from March 14 to March 20, 2026. These were Kody's
first two tagged releases, made while it was still in early development, and
they centered on the MCP `search` and `execute` tools: reusable skills, GitHub
access, and layouts that work on a phone.

## Saved skills take parameters

### What shipped

`meta_save_skill` and `meta_update_skill` accept an optional `parameters` list.
Each parameter has a `name`, a `description`, a `type` (`string`, `number`,
`boolean`, or `json`), and optional `required` and `default` values. When you
run the skill with `meta_run_skill`, you pass values in `params`, and the saved
code receives them as the `params` variable (or as its first argument). Kody
rejects missing required parameters and unknown names, and fills in defaults for
anything you leave out. Parameter definitions are stored with the skill and
included in its search details, so your agent can see what inputs a skill
expects before it runs it.

### Why it matters

Before this, a saved skill's inputs lived in its code, so reusing a workflow for
a different repository or date range meant editing the skill or saving a near
copy. Now one saved skill covers the pattern and your agent supplies the values
at run time. That keeps the code you save small, reusable, and easy to find in
`search`.

### Example

1. Save a skill that declares its inputs. This one wraps the new
   `github_graphql` capability, which can run mutations, so the skill is saved
   with matching `read_only`, `idempotent`, and `destructive` flags:

```json
{
	"title": "List open pull requests",
	"description": "Lists the newest open pull requests for a GitHub repository.",
	"keywords": ["github", "pull requests"],
	"code": "async () => codemode.github_graphql({ query: 'query($owner: String!, $name: String!, $count: Int!) { repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: $count) { nodes { number title } } } }', variables: { owner: params.owner, name: params.repo, count: params.count } })",
	"parameters": [
		{
			"name": "owner",
			"description": "Repository owner",
			"type": "string",
			"required": true
		},
		{
			"name": "repo",
			"description": "Repository name",
			"type": "string",
			"required": true
		},
		{
			"name": "count",
			"description": "How many pull requests to return",
			"type": "number",
			"default": 10
		}
	],
	"read_only": false,
	"idempotent": false,
	"destructive": true
}
```

2. Run it with values for this call. `count` falls back to its default:

```json
{
	"skill_id": "YOUR_SKILL_ID",
	"params": { "owner": "my-org", "repo": "my-repo" }
}
```

PRs: [#19](https://github.com/kody-hq/kody/pull/19),
[#21](https://github.com/kody-hq/kody/pull/21)

## More updates

- **MCP:** Adds GitHub GraphQL to the coding capabilities. `github_graphql`
  sends a query or mutation with optional variables and returns the `data` and
  `errors` from GitHub, and `github_graphql_api_docs` fetches GitHub's GraphQL
  reference pages from docs.github.com as markdown. Calls use the GitHub token
  configured for the server. ([#20](https://github.com/kody-hq/kody/pull/20))
- **MCP:** Makes saved skills easier to run. Each skill hit from `search` now
  includes a `usage` hint with the exact `meta_run_skill` arguments and a note
  about optional `params`, and the `meta_run_skill` description includes a
  params example. ([#21](https://github.com/kody-hq/kody/pull/21))
- **Dashboard:** Makes the home page and chat work on phones and tablets. Home
  feature cards stack into a single column with tighter spacing, and on smaller
  screens chat shows one panel at a time: the thread list at `/chat`, then the
  conversation when you open a thread, driven by the URL. Desktop still opens a
  thread automatically. ([#1](https://github.com/kody-hq/kody/pull/1),
  [#3](https://github.com/kody-hq/kody/pull/3))

## Fixes

No user-facing fixes this week.

## Try it

Skills and capabilities from this week were found and run through the `search`
and `execute` tools. Read
[Search and execute](https://kody.codes/docs/search-and-execute) to see how your
agent uses them in Kody today.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
