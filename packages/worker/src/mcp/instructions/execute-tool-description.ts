import { preferLocalCliExecuteGuidance } from '#mcp/instructions/prefer-local-cli-execute-guidance.ts'

export const executeToolDescription = `${preferLocalCliExecuteGuidance}

Run one ephemeral ESM module with the caller's credentials and capabilities. Depending on what the code does, a call can make real changes (send messages, publish, delete, write data, spend money); some of those cannot be undone. Discover the capability with search first and adapt that entity's execute snippet; pass \`credentials\` when the module picks among named credentials (secret hosts may need account approval). Prefer a package over rewriting helpers. Project large results before returning (e.g. { id, subject, snippet }). Same user and \`code\` graph reuse one isolate for the UTC day — vary args via \`params\`. If the call is still running at the transport budget, the response is inProgress with runId and idempotencyKey (Kody assigns one when you omit it). Poll runGet. Retry with that key instead of starting the mutation again. Every routed response names where the run happened (input errors before routing may omit it): structuredContent.ranOn ({ kind: "cloud" | "context", id, name, attempts, fellBackToCloud, workerUnits }) plus a short text line such as "Ran on Kody cloud."

import { kody } from 'kody:runtime'
export default async function main(params) {
  return await kody.capability_id(params)
}`
