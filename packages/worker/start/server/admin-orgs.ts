import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const orgsInput = z.object({
	query: z.string(),
	status: z.enum(['live', 'deleted', 'all']),
	kind: z.enum(['personal', 'team', 'all']),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive().max(100),
	returnTo: z.string().regex(/^\/admin\/orgs(?:\/[^/?#\\]+)?(?:\?[^#\\]*)?$/),
})

export const loadAdminOrgs = createServerFn({ method: 'GET' })
	.validator(orgsInput)
	.handler(async ({ data }) => {
		const [
			{ readAdminOrgsData },
			{ loadDocumentHead },
			{ readAdminPageContext },
		] = await Promise.all([
			import('../../src/admin/orgs-data.ts'),
			import('./document-head.ts'),
			import('./admin-page-context.ts'),
		])
		const { bindings, user } = await readAdminPageContext(data.returnTo)
		const head = loadDocumentHead('adminOrgs', data.returnTo)
		if (!user) return { forbidden: true as const, head }
		return {
			forbidden: false as const,
			payload: await readAdminOrgsData(bindings.APP_DB, data),
			head,
		}
	})

export const loadAdminOrg = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			slug: z.string().min(1),
			returnTo: z.string().regex(/^\/admin\/orgs\/[^/?#\\]+(?:\?[^#\\]*)?$/),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadAdminOrgDetail },
			{ loadDocumentHead },
			{ readAdminPageContext },
		] = await Promise.all([
			import('../../src/admin/orgs-data.ts'),
			import('./document-head.ts'),
			import('./admin-page-context.ts'),
		])
		const { bindings, user } = await readAdminPageContext(data.returnTo)
		const head = loadDocumentHead('adminOrgDetail', data.returnTo)
		if (!user) return { forbidden: true as const, head }
		return {
			forbidden: false as const,
			payload: await loadAdminOrgDetail(bindings, { slug: data.slug }),
			head,
		}
	})

export const loadAdminOrgSeatQuantityReport = createServerFn({
	method: 'GET',
})
	.validator(
		z.object({
			returnTo: z.string().regex(/^\/admin\/orgs(?:\?[^#\\]*)?$/),
			checkStripe: z.boolean().default(false),
			limit: z.number().int().min(1).max(200).default(100),
			offset: z.number().int().nonnegative().default(0),
		}),
	)
	.handler(async ({ data }) => {
		const [{ readAdminPageContext }, { buildSeatQuantityReport }] =
			await Promise.all([
				import('./admin-page-context.ts'),
				import('../../src/billing/seat-quantity-report.ts'),
			])
		const { bindings, user } = await readAdminPageContext(data.returnTo)
		if (!user) throw new Error('Admin access required.')
		return buildSeatQuantityReport({
			db: bindings.APP_DB,
			env: bindings,
			since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
			checkStripe: data.checkStripe,
			limit: data.limit,
			offset: data.offset,
		})
	})
