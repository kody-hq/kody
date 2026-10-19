# Examples over prose

Show one example that matches the current code. When a procedure has several
steps, make it a script or a Kody package. The page keeps three things: when it
applies, the command, and what failure looks like.

## Example

Local CLI execute has one guide and one skill. Other pages link them.

- When: Node ≥22 and `@kodycodes/cli` are available.
- Command: `npx @kodycodes/cli execute --local`
- Failure: `--local` cannot run. Use Open API / MCP `api`, or fix the
  environment.

The no-hosted-execute member of `npm run docs:check` rejects guidance that sends
agents to the hosted execute tool in that failure case.

- [Local CLI execute](../guides/local-execute.md)
  (`search({ entity: "guide:local_execute" })`)
- [prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)
