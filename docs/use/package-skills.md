# Package skills

Ship Agent Skills (`skills/<name>/SKILL.md`) inside a package and serve them to
MCP hosts that support Skills over MCP. Usage lives in the
[Package skills guide](../guides/package-skills.md)
(`search({ entity: "guide:package_skills" })`).

Serving skills over MCP is an experiment (flag `mcp-skills-extension`).
Publishing skills works without it. Turn it on at
[`/account/experiments`](https://kody.codes/account/experiments) or with
`experimentSet({ experiment: "package-skills", enabled: true })`.
