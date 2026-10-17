import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { adminUsersReadInput } from './admin-users-input.ts'

async function adminContext(permission?: 'read:user:any' | 'update:user:any') {
	const [
		{ env },
		{ getRequest, setResponseHeader },
		{ getEnv },
		{ setAuthSessionSecret },
		auth,
	] = await Promise.all([
		import('cloudflare:workers'),
		import('@tanstack/react-start/server'),
		import('../../src/app/env.ts'),
		import('../../src/app/auth-session.ts'),
		import('../../src/app/permissions-server.ts'),
	])
	const bindings = getEnv(env)
	setAuthSessionSecret(bindings.COOKIE_SECRET)
	const request = getRequest()
	setResponseHeader('Cache-Control', 'private, no-store')
	const actor = permission
		? await auth.requireUserWithPermission(request, bindings, permission)
		: await auth.requireUserWithRole(request, bindings, 'admin')
	return { env: bindings, request, actor }
}

export const readAdminOrgLimits = createServerFn({ method: 'GET' })
	.inputValidator(z.object({ orgId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { env } = await adminContext()
		const { loadAdminOrgLimits } =
			await import('../../src/admin/org-limit-overrides.ts')
		return loadAdminOrgLimits({ db: env.APP_DB, target: data })
	})

export const updateAdminOrgLimits = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({
			orgId: z.string().min(1),
			changes: z.array(
				z.object({
					key: z.string(),
					value: z.union([z.number(), z.literal('unlimited'), z.null()]),
					expiresAt: z.string().nullable().optional(),
				}),
			),
			reason: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async () => {
			const { env, actor } = await adminContext()
			const [
				{ applyAdminOrgLimitOverrideChanges },
				{ orgAuditWriterFromRequest },
				{ parseLimitOverrideKey },
			] = await Promise.all([
				import('../../src/admin/org-limit-overrides.ts'),
				import('../../src/orgs/org-audit.ts'),
				import('../../universal/plans.ts'),
			])
			const changes = data.changes.map((change) => {
				const key = parseLimitOverrideKey(change.key)
				if (!key) throw new Error('Unknown limit key.')
				return { ...change, key }
			})
			return {
				...(await applyAdminOrgLimitOverrideChanges({
					db: env.APP_DB,
					audit: orgAuditWriterFromRequest(env, actor.request),
					target: { orgId: data.orgId },
					changes,
					reason: data.reason,
				})),
			}
		})
	})

export const readAdminCreditWallet = createServerFn({ method: 'GET' })
	.inputValidator(z.object({ stableUserId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { env } = await adminContext('read:user:any')
		const [{ loadAdminCreditWallet }, { parseOwnerId }] = await Promise.all([
			import('../../src/admin/credit-grants.ts'),
			import('@kody-internal/shared/owner-person-ids.ts'),
		])
		const stableUserId = parseOwnerId(data.stableUserId)
		if (!stableUserId) throw new Error('stableUserId is required.')
		const wallet = await loadAdminCreditWallet(env, { stableUserId })
		if (!wallet) throw new Error('User not found.')
		return wallet
	})

export const grantAdminCredits = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({
			stableUserId: z.string().min(1),
			amountCents: z.number(),
			note: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async () => {
			const { env, actor, request } = await adminContext('update:user:any')
			const [{ grantAdminCreditsToUser }, { parseOwnerId }, { getRequestIp }] =
				await Promise.all([
					import('../../src/admin/credit-grants.ts'),
					import('@kody-internal/shared/owner-person-ids.ts'),
					import('../../src/audit-log.ts'),
				])
			const stableUserId = parseOwnerId(data.stableUserId)
			if (!stableUserId) throw new Error('stableUserId is required.')
			const result = await grantAdminCreditsToUser({
				env,
				target: { stableUserId },
				grantedBy: { stableUserId: actor.mcpUser.userId, email: actor.email },
				amountCents: data.amountCents,
				note: data.note,
				path: '/admin/users',
				ip: getRequestIp(request) ?? undefined,
			})
			return result.wallet
		})
	})

export const readAdminUsersPage = createServerFn({ method: 'GET' })
	.inputValidator(
		adminUsersReadInput.extend({ page: z.number().int().positive() }),
	)
	.handler(async ({ data }) => {
		const { env } = await adminContext('read:user:any')
		const { readAdminUsersData } = await import('../../src/admin/users-data.ts')
		return readAdminUsersData(env, data)
	})

export const readAdminUserUsage = createServerFn({ method: 'GET' })
	.inputValidator(z.object({ stableUserId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const { env } = await adminContext('read:user:any')
		const [{ loadAdminUserUsageData }, { parsePersonId }] = await Promise.all([
			import('../../src/admin/user-usage-data.ts'),
			import('@kody-internal/shared/owner-person-ids.ts'),
		])
		const stableUserId = parsePersonId(data.stableUserId)
		if (!stableUserId) throw new Error('stableUserId is required.')
		const payload = await loadAdminUserUsageData(env, stableUserId)
		if (!payload) throw new Error('User not found.')
		return payload
	})

export const readAdminCodemodItems = createServerFn({ method: 'GET' })
	.inputValidator(
		z.object({
			runId: z.string().min(1),
			afterId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { env } = await adminContext()
		const { readAdminCodemodRunItems } =
			await import('../../src/admin/codemods-operations.ts')
		return readAdminCodemodRunItems(env, data)
	})
