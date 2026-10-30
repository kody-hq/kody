/** Claim page view types, kept import-free so the client build can load them. */
export type AgentClaimOrg = {
	slug: string
	displayName: string | null
	role: string | null
}

export type AgentClaimRequest = {
	claimEmail: string
	attemptExpiresAt: number
	orgs: Array<AgentClaimOrg>
	selectedOrgSlug: string | null
}
