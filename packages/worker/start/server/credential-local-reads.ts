import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { routes } from '#universal/routes.ts'
import { parseRouteInput } from './route-input.ts'

const orgSlug = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const credentialId = z
	.string()
	.min(1)
	.max(200)
	.refine((value) => !/[\\/]/.test(value) && value !== '.' && value !== '..')

const approvalPageInput = z.object({ orgSlug, credentialId })

/** The one-step page a refused CLI read links to. Reading it changes nothing. */
export const loadLocalReadsApprovalPage = createServerFn({ method: 'GET' })
	.validator((data: z.input<typeof approvalPageInput>) =>
		parseRouteInput(approvalPageInput, data),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ loadLocalReadsApproval },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('../../src/app/credential-local-reads'),
			import('./document-head'),
		])
		const pathname = `${routes.orgCredentials.href({
			orgSlug: data.orgSlug,
		})}/${encodeURIComponent(data.credentialId)}/local-reads`
		const { bindings, user } = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'credentials',
			returnTo: pathname,
		})
		const approval = await loadLocalReadsApproval({
			env: bindings,
			user,
			orgSlug: data.orgSlug,
			credentialId: data.credentialId,
		})
		return {
			approval,
			orgSlug: data.orgSlug,
			head: loadDocumentHead('orgCredentialLocalReads', pathname),
		}
	})

/** Turns local reads on or off for one secret. Website sessions only. */
export const saveCredentialLocalReads = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug,
			credentialId,
			enabled: z.boolean(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setCredentialLocalReads } =
			await import('#app/credential-local-reads.ts')
		const { requireOperationResult } = await import('#app/operation-result.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async ({ env, user }) =>
				requireOperationResult(
					await setCredentialLocalReads({
						env,
						user,
						credentialId: data.credentialId,
						enabled: data.enabled,
					}),
				),
		)
	})
