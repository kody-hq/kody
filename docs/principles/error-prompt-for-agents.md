# Error prompt for agents

Any user-facing error in a surface the user’s agent cannot already see must use
the error-prompt primitive (`Copy prompt for your agent`).

## When it applies

The human is staring at a browser page, connect/OAuth gate, package-app HTML
error, public 404/500, unauthorized shell, or an email about a failure — and
MCP/CLI/API did not already return that same actionable error to the agent.

## When it does not

Skip surfaces where the agent already gets the failure through a capability
(`runGet`, `jobGet`, `webhookList`, matching mutations) unless that response
lacks actionable detail. Do not add a second lane beside the shared primitive.

## What to use

- Builder: `#universal/error-agent-prompt` (`buildErrorAgentPrompt`) and presets
  in `#universal/error-agent-prompt-presets`
- Hydrated UI: `#start/components/error-agent-prompt-button`
  (`ErrorAgentPromptButton`)
- Static HTML (no client entry): `renderErrorAgentPromptStaticHtml`
- Always stamp `data-error-agent-prompt`
- Never put secret values, tokens, or other users’ private data in the prompt;
  redaction runs in the builder

## Enforcement

- Inventory: `tools/error-agent-prompt-surfaces.ts` (`adopt` + `skip`)
- Guard: `npm run error-agent-prompt:check` (also in `npm run validate`)

New dedicated error pages that match the candidate patterns must be classified
into `adopt` or `skip` before validate passes.

## Related

- [Fail loudly at the right layer](./fail-loudly.md)
- [Harness engineering](../contributing/harness-engineering.md)
- [Keep agent context lean](./lean-agent-context.md)
