import { readOrgIdFromGrantProps } from '#worker/orgs/oauth-grant.ts'
import {
	loadOrgBindingForOrg,
	orgBindingForOrgFromRows,
	orgBindingForOrgStatements,
	type OrgBinding,
} from '#worker/orgs/repo.ts'

/**
 * Resolve the org this MCP OAuth grant is bound to from its stamped
 * `props.orgId` (ADR 0064). A grant without one fails closed.
 */
export async function loadOrgBindingFromGrantProps(input: {
	db: D1Database
	personId: string
	grantProps: unknown
}): Promise<OrgBinding | null> {
	const orgId = readOrgIdFromGrantProps(input.grantProps)
	if (!orgId) return null
	return await loadOrgBindingForOrg(input.db, input.personId, orgId)
}

export type OrgBindingPlan = {
	/** Statements to run in the same D1 batch as the caller's other reads. */
	statements: Array<D1PreparedStatement>
	/** First row of each statement's result, in `statements` order. */
	resolve: (rows: Array<unknown>) => OrgBinding | null
}

/**
 * Same resolution as {@link loadOrgBindingFromGrantProps}, but as prepared
 * statements so the caller can read the binding in one D1 batch (one
 * transaction) together with the user row it gates on.
 */
export function planOrgBindingFromGrantProps(input: {
	db: D1Database
	personId: string
	grantProps: unknown
}): OrgBindingPlan {
	const orgId = readOrgIdFromGrantProps(input.grantProps)
	if (orgId) {
		const statements = orgBindingForOrgStatements(
			input.db,
			input.personId,
			orgId,
		)
		return {
			statements: [statements.membership, statements.grant],
			resolve: (rows) =>
				orgBindingForOrgFromRows({
					membership: (rows[0] ?? null) as Parameters<
						typeof orgBindingForOrgFromRows
					>[0]['membership'],
					grant: (rows[1] ?? null) as Parameters<
						typeof orgBindingForOrgFromRows
					>[0]['grant'],
				}),
		}
	}
	return { statements: [], resolve: () => null }
}
