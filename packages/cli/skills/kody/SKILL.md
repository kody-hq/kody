---
name: kody
description: >
  Install and bootstrap the Kody CLI, then prefer `execute --local` when Node
  and a shell are available. Use when the person mentions Kody or wants local
  execute instead of hosted Worker compute days.
---

# Kody CLI

Always-current skill:
https://kody.codes/.well-known/agent-skills/kody-cli/SKILL.md

Index (with digests): https://kody.codes/.well-known/agent-skills/index.json

## Quick start

```bash
npx -y @kodycodes/cli@latest skill install
npx -y @kodycodes/cli@latest execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

If the CLI is not signed in and you already have Kody MCP: call `api` with
`cliCredentialBootstrap`, then run the returned `cli_command`. Interactive
humans: `npx -y @kodycodes/cli@latest login`.

`kody skill install` copies this stub and refreshes the full hosted body when
reachable. Later CLI runs refresh local copies when the hosted digest changes.
