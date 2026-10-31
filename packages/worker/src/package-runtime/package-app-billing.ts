/**
 * Who pays for the metered work of one package-app request (ADR 0095).
 *
 * - A member of the owning org (any role): the owning org, as always.
 * - A person from outside the org on an internal (not internet-visible) app,
 *   allowed in by a grant: their own personal org pays for the metered work
 *   their requests cause. The publisher keeps the app's Dynamic Worker day.
 * - Anonymous and identity-only visitors, and every visitor of an
 *   internet-visible app: the publisher pays.
 *
 * The billed org rides on the request (caller context and visit ticket),
 * never on the cached worker, so the shared per-app worker does not fork per
 * visiting org.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type RequestBilling,
	type RequestContext,
} from '@kody-internal/shared/request-context.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { loadOrgBindingForPerson } from '#worker/orgs/repo.ts'

/** Pure decision: who is billed, given the visit's facts. */
export function decidePackageAppBilling(input: {
	ownerId: OwnerId
	visitor: Pick<RuntimePackageAppVisitor, 'role'> | null
	internetVisible: boolean
	visitorPersonalOrgId: OwnerId | null
}): RequestBilling | null {
	if (!input.visitor) return null
	if (input.visitor.role !== null) return null
	if (input.internetVisible) return null
	const orgId = input.visitorPersonalOrgId
	if (!orgId || orgId === input.ownerId) return null
	return { orgId }
}

/**
 * Resolve the billed org for a signed-in visitor. Only a visitor with no role
 * in the owning org on an internal app pays the personal-org lookup. When it
 * fails, the publisher pays (today's behavior) and the request still serves.
 */
export async function resolvePackageAppBilling(input: {
	db: D1Database
	ownerId: OwnerId
	visitor: RuntimePackageAppVisitor | null
	internetVisible: boolean
}): Promise<RequestBilling | null> {
	const { visitor } = input
	if (!visitor || visitor.role !== null || input.internetVisible) return null
	let visitorPersonalOrgId: OwnerId | null = null
	try {
		visitorPersonalOrgId = (
			await loadOrgBindingForPerson(input.db, visitor.userId)
		).org.id
	} catch (error) {
		console.warn('package-app-billing-personal-org-lookup-failed', error)
	}
	return decidePackageAppBilling({
		ownerId: input.ownerId,
		visitor,
		internetVisible: input.internetVisible,
		visitorPersonalOrgId,
	})
}

/** Stamp the billed org on a caller context's request, when there is one. */
export function withRequestBilling<T extends Pick<McpCallerContext, 'request'>>(
	callerContext: T,
	billing: RequestBilling | null | undefined,
): T {
	if (!billing || !callerContext.request) return callerContext
	return {
		...callerContext,
		request: { ...callerContext.request, billing } satisfies RequestContext,
	}
}
