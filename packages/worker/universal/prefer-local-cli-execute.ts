/**
 * Prefer-local CLI execute copy shared by MCP instructions, execute nudges,
 * and entitlement limit / how-to-reduce text.
 */

/**
 * Prefer-local guidance for MCP server instructions and tool descriptions.
 * Copy is Kent-locked with the always-on MCP stub budget (~600 chars for the
 * full stub including this paragraph).
 */
export const preferLocalCliExecuteGuidance =
	"Start with `search`. If you can run shell commands, run code locally with `npx -y @kodycodes/cli@latest execute --local` (Node 22+). If it's not signed in, call `api` with `cliCredentialBootstrap` and run its `cli_command` yourself. Without a shell, use `execute`."

/** One-line install + local execute command for nudges and limit errors. */
export const preferLocalCliExecuteCommand =
	'npx -y @kodycodes/cli@latest execute --local'

/**
 * Once-per-conversation warning when hosted execute keeps minting fresh
 * workers. Include the install one-liner and bootstrap path.
 */
export const preferLocalExecuteNudgeWarning = `Fresh hosted execute code spends Worker compute days. Prefer local: \`${preferLocalCliExecuteCommand}\` (Node 22+). If it is not signed in, call \`api\` with \`cliCredentialBootstrap\` and run its \`cli_command\`. Details: search({ entity: "guide:local_execute" }).`

/**
 * Limit-error fragment: how to install the CLI and run locally after the
 * reuse-code advice.
 */
export const preferLocalExecuteLimitGuidance = `Shell-capable hosts can run \`${preferLocalCliExecuteCommand}\` (Node 22+); if it is not signed in, call \`api\` with \`cliCredentialBootstrap\` and run its \`cli_command\``
