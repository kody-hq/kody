/**
 * The request context: one shape for every request source. `org` decides
 * whose data a request touches (every storage key follows it); `actor` and
 * `attribution` decide who is acting and who pays; `credential` is what
 * authenticated the request and may narrow it. `authorize` reads only this
 * shape. See docs/contributing/architecture/authorization.md.
 */
import { type OrgPermission } from './org-permissions.ts'
import { type OwnerId, type PersonId } from './owner-person-ids.ts'

export type OrgRole = 'owner' | 'member' | 'billing'

export type RequestOrg = {
	id: OwnerId
	/** Public handle. Null only when the identity row has no valid username. */
	slug: string | null
}

export type RequestActor = {
	userId: PersonId
	username: string | null
}

/**
 * `event` covers platform-originated topics (status incidents, fleet
 * alerts) that reach a subscriber package with no emitting run.
 */
export type AutomationSource = 'webhook' | 'schedule' | 'email' | 'event'

export type RequestAttribution =
	| { kind: 'user'; userId: PersonId }
	| { kind: 'automation'; source: AutomationSource; sourceId: string }

export type RequestCredentialKind =
	| 'session'
	| 'mcp-oauth'
	| 'api-token'
	| 'cli'
	| 'package-app'
	| 'inbound-email'
	| 'webhook'
	| 'schedule'
	| 'platform-event'
	/** A run on a registered execution context; the id is the run id. */
	| 'execution-context-run'

export type RequestCredential = {
	kind: RequestCredentialKind
	id: string | null
	/** The org this credential is bound to. */
	orgId: OwnerId
	/** Null means the credential does not narrow the actor's permissions. */
	scopes: ReadonlyArray<OrgPermission> | null
	/**
	 * The profile this credential acts as (ADR 0092), or absent/null for the
	 * person themselves (the live mirror).
	 */
	profileId?: string | null
	/** That profile's chain at authentication: ids, root first (attribution). */
	profileChain?: ReadonlyArray<string> | null
	/**
	 * Execution-context runs only: true when the requester operates the
	 * context, so the run has the Kody access the same run has in Kody cloud.
	 */
	contextRunByOperator?: boolean
}

export type RequestContext = {
	org: RequestOrg
	/**
	 * Null only for a trigger event with no enablement, which holds no
	 * permissions and runs nothing.
	 */
	actor: RequestActor | null
	attribution: RequestAttribution
	credential: RequestCredential
	/** Null for a request with no person and for outside collaborators. */
	membership: { role: OrgRole } | null
	/**
	 * The org billed for metered work this request causes, when it is not
	 * `org`. Only a visit from another org to an internal package app sets it
	 * (ADR 0095). Absent means `org` pays.
	 */
	billing?: RequestBilling
}

export type RequestBilling = { orgId: OwnerId }

/** The org a request's metered work is charged to. */
export function billedOrgIdOf<T extends string | null | undefined>(
	request: Pick<RequestContext, 'billing'> | null | undefined,
	fallback: T,
): OwnerId | T {
	return request?.billing?.orgId ?? fallback
}

/**
 * The parts of a request context a downstream run inherits from the run
 * that started it (nested invokes, workflow steps, emitted package events,
 * sealed secret providers). The org is always re-resolved, never inherited.
 *
 * `membership` is the starter's role in `credential.orgId`. Downstream runs
 * execute as the org's own identity, whose role is Owner, so without it a
 * Member actor would inherit Owner. Lineage written before it existed omits
 * it; such a run keeps the role of the identity it uses only when the actor is
 * that identity (a personal org's owner), and otherwise gets no role.
 */
export type RequestLineage = Pick<
	RequestContext,
	'actor' | 'attribution' | 'credential'
> & { membership?: RequestContext['membership'] }
