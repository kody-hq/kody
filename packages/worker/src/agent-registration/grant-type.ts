/**
 * auth.md profile grant (ADR 0091) the agent polls `/oauth/token` with while a
 * person completes the claim. Kept in its own module so the origin handler can
 * route on it without loading the registration code.
 */
export const agentClaimGrantType = 'urn:workos:agent-auth:grant-type:claim'
