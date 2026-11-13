import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import {
	getExecutionContext,
	loadContextAccess,
} from '#worker/execution-contexts/store.ts'
import { buildMcpUserContextFromGrantProps } from '#worker/mcp-auth-user-context.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { loadProfileChain } from '#worker/profiles/store.ts'

/**
 * How long one run reuses the D1 half of its execution-context lease check
 * (requester account, org membership, context access, profile chain). A burst
 * of CapabilityProxy calls from one run then costs one set of reads instead of
 * one per call. Suspension, membership removal, context access changes, and
 * profile revocation can take up to this long to reach a run that already
 * passed. Run end, lease expiry, context revocation, and the request
 * signature are still checked by the session Durable Object on every call.
 */
export const executionContextRunAccessReuseMs = 5_000

type RunAccessLease = {
	ecid: string
	runId: string
	orgId: string
	profileId?: string | null
	requester: { userId: string }
}

type RequesterContext = NonNullable<
	Awaited<ReturnType<typeof buildMcpUserContextFromGrantProps>>
>

export type ExecutionContextRunAccess =
	| {
			ok: true
			authContext: RequesterContext
			orgBinding: NonNullable<Awaited<ReturnType<typeof loadOrgBindingForOrg>>>
			context: NonNullable<Awaited<ReturnType<typeof getExecutionContext>>>
			profileChain: Awaited<ReturnType<typeof loadProfileChain>> | null
	  }
	| { ok: false; reason: 'requester' | 'org' | 'context' }

const runAccessCache = new PromiseLruCache<ExecutionContextRunAccess>({
	ttlMs: executionContextRunAccessReuseMs,
	limit: 512,
})

function runAccessCacheKey(lease: RunAccessLease) {
	return JSON.stringify([
		lease.ecid,
		lease.runId,
		lease.requester.userId,
		lease.orgId,
		lease.profileId ?? null,
	])
}

async function readRunAccess(
	env: Env,
	lease: RunAccessLease,
): Promise<ExecutionContextRunAccess> {
	const authContext = await buildMcpUserContextFromGrantProps(env, {
		userId: lease.requester.userId,
	})
	if (!authContext || authContext.suspended || !authContext.emailVerified) {
		return { ok: false, reason: 'requester' }
	}
	const [orgBinding, context] = await Promise.all([
		loadOrgBindingForOrg(env.APP_DB, authContext.user.userId, lease.orgId),
		getExecutionContext(env.APP_DB, lease.ecid),
	])
	if (!orgBinding || !context) return { ok: false, reason: 'org' }
	const access = await loadContextAccess(env.APP_DB, context, {
		userId: authContext.user.userId,
		orgId: lease.orgId,
	})
	if (!access.usable) return { ok: false, reason: 'context' }
	const profileChain = lease.profileId
		? await loadProfileChain(env.APP_DB, {
				orgId: lease.orgId,
				profileId: lease.profileId,
			})
		: null
	return { ok: true, authContext, orgBinding, context, profileChain }
}

/**
 * The D1 half of an execution-context run's per-call check, shared by that
 * run's calls for {@link executionContextRunAccessReuseMs}. Denials are never
 * reused, and each caller gets its own copy.
 */
export async function loadExecutionContextRunAccess(
	env: Env,
	lease: RunAccessLease,
): Promise<ExecutionContextRunAccess> {
	const cacheKey = runAccessCacheKey(lease)
	const access = await runAccessCache.getOrCreate({
		cacheKey,
		create: () => readRunAccess(env, lease),
	})
	if (!access.ok) {
		runAccessCache.delete(cacheKey)
		return access
	}
	return structuredClone(access)
}
