/**
 * Org ids in `FIRST_PARTY_ORG_IDS` whose packages receive first-party admin
 * events next to site admins' own packages. Malformed ids are dropped.
 */
export function firstPartyOrgIds(env: { FIRST_PARTY_ORG_IDS?: string }) {
	return (env.FIRST_PARTY_ORG_IDS ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter((id) => /^[0-9a-f]{64}$/.test(id))
}
