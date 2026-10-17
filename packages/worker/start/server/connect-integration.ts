import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
const scope = z.object({ orgSlug: z.string().optional() })
export const readConnectIntegration = createServerFn({ method: 'GET' })
	.validator(
		scope.extend({ name: z.string().min(1), app: z.string().optional() }),
	)
	.handler(async ({ data }) => {
		const { withWebsiteRead } = await import('./mutation-context.ts')
		return withWebsiteRead(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async ({ env, user }) => {
				const { loadAccountIntegrationByName } =
					await import('../../src/app/account-integrations-data.ts')
				return {
					integration: await loadAccountIntegrationByName(
						env,
						user,
						data.name,
						{ appSlug: data.app },
					),
				}
			},
		)
	})
export const readConnectChooser = createServerFn({ method: 'GET' })
	.validator(scope)
	.handler(async ({ data }) => {
		const { withWebsiteRead } = await import('./mutation-context.ts')
		return withWebsiteRead(
			{ scope: data.orgSlug ? { orgSlug: data.orgSlug } : undefined },
			async ({ env, user }) => {
				const { loadConnectOauthChooser } =
					await import('../../src/app/connect-oauth-chooser.ts')
				const { ownerIdFromCaller } =
					await import('../../src/request-context/owner-id.ts')
				return loadConnectOauthChooser({
					env,
					userId: ownerIdFromCaller({
						request: user.request,
						user: user.mcpUser,
					}),
				})
			},
		)
	})
