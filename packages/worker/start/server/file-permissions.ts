import { assetCacheControls } from '#universal/file-assets.ts'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
import { filePermissionOptions } from '#universal/file-permissions.ts'

const scope = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	fileId: fileIdSchema,
})
export const readFilePermissions = createServerFn({ method: 'GET' })
	.validator(scope)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead },
			{ fileCollaborationAccess },
			{ fileStoreRpc },
			{ loadFileAncestors, filePublicParentAllows },
			{ listResourceCollaborators },
			{ isPersonalOrg },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/files/collaboration-access.ts'),
			import('../../src/files/client.ts'),
			import('../../src/files/tree-access.ts'),
			import('../../src/orgs/package-collaborators.ts'),
			import('../../src/orgs/is-personal-org.ts'),
		])
		return withWebsiteRead(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async ({ env, user }) => {
				const { request, access } = await fileCollaborationAccess(
					env,
					user.request,
					data.fileId,
				)
				if (!access.read) throw new Error('File not found.')
				const store = fileStoreRpc(env, request.org.id)
				const chain = await loadFileAncestors(
					(id) => store.metadata(request.org.id, id),
					data.fileId,
				)
				const file = chain.get(data.fileId)!
				const direct = access.manage
					? await listResourceCollaborators({
							db: env.APP_DB,
							orgId: request.org.id,
							resourceType: 'file',
							resourceId: file.id,
						})
					: null
				const ancestors = access.manage
					? await Promise.all(
							[...chain.values()]
								.filter((item) => item.id !== file.id)
								.map(async (item) => ({
									id: item.id,
									name: item.name,
									restricted: item.accessMode === 'restricted',
									grants: (
										await listResourceCollaborators({
											db: env.APP_DB,
											orgId: request.org.id,
											resourceType: 'file',
											resourceId: item.id,
										})
									).collaborators,
								})),
						)
					: []
				const invites = access.manage
					? await env.APP_DB.prepare(
							`SELECT id, invitee_email, invitee_username, preset, expires_at FROM invites WHERE org_id = ? AND resource_type = 'file' AND resource_id = ? AND kind = 'grant' AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC`,
						)
							.bind(request.org.id, file.id, new Date().toISOString())
							.all<{
								id: string
								invitee_email: string | null
								invitee_username: string | null
								preset: string | null
								expires_at: string
							}>()
					: null
				let publicVia: { id: string; name: string } | null = null
				if (access.manage && file.accessMode !== 'restricted') {
					for (const parent of ancestors) {
						if (
							filePublicParentAllows(chain, parent.id) &&
							(await store.hasPublicLink(request.org.id, parent.id))
						) {
							publicVia = { id: parent.id, name: parent.name }
							break
						}
						if (parent.restricted) break
					}
				}
				return {
					file,
					access,
					direct,
					ancestors,
					invites: invites?.results ?? [],
					personal: await isPersonalOrg(env.APP_DB, request.org.id),
					publicVia,
					publicLink: access.manage
						? await (
								await import('../../src/files/public-links.ts')
							).readManagedPublicLink(
								env,
								request.org.id,
								data.orgSlug,
								file.id,
							)
						: null,
					assetSettings: access.manage
						? await store.assetSettings(request.org.id, file.id)
						: null,
					publicLinkEnabled:
						access.manage &&
						(await store.hasPublicLink(request.org.id, file.id)),
				}
			},
		)
	})

export const changeFileCollaborator = createServerFn({ method: 'POST' })
	.validator(
		scope
			.extend({
				subjectType: z.enum(['user', 'team', 'org']),
				subjectId: z.string().min(1),
				preset: z.enum(['read', 'contribute', 'manage']).optional(),
				permissions: z
					.array(
						z.enum(filePermissionOptions.map((option) => option.permission)),
					)
					.min(1)
					.optional(),
				grantId: z.string().optional(),
				remove: z.boolean().optional(),
			})
			.refine(
				(value) => value.remove || !!value.preset !== !!value.permissions,
				'Choose a preset or custom permissions.',
			),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ callCapabilityAsWebsite },
			{ getStaticRegistry },
			{ fileCollaborationAccess },
			{ getGrantById },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/mcp/capabilities/registry.ts'),
			import('../../src/files/collaboration-access.ts'),
			import('../../src/orgs/access-writes.ts'),
		])
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) => {
				const request = context.user.request
				if (
					!(await fileCollaborationAccess(context.env, request, data.fileId))
						.access.manage
				)
					throw new Error('File access management is required.')
				if (data.remove) {
					if (!data.grantId) throw new Error('Choose a grant to remove.')
					const grant = await getGrantById({
						db: context.env.APP_DB,
						orgId: request.org.id,
						grantId: data.grantId,
					})
					if (
						grant?.resourceType !== 'file' ||
						grant.resourceId !== data.fileId
					)
						throw new Error('Grant not found on this file.')
				}
				const registry = await getStaticRegistry()
				await callCapabilityAsWebsite(
					context,
					registry.capabilityMap[data.remove ? 'accessRevoke' : 'accessGrant']!,
					data.remove
						? { grant_id: data.grantId }
						: {
								resource_type: 'file',
								resource_id: data.fileId,
								subject_type: data.subjectType,
								subject_id: data.subjectId,
								...(data.permissions
									? { permissions: data.permissions }
									: { preset: data.preset }),
							},
				)
				return { ok: true as const }
			},
		)
	})

export const revokeFileInvitation = createServerFn({ method: 'POST' })
	.validator(scope.extend({ inviteId: z.string().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ callCapabilityAsWebsite },
			{ getStaticRegistry },
			{ fileCollaborationAccess },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/mcp/capabilities/registry.ts'),
			import('../../src/files/collaboration-access.ts'),
		])
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			async (context) => {
				if (
					!(
						await fileCollaborationAccess(
							context.env,
							context.user.request,
							data.fileId,
						)
					).access.manage
				)
					throw new Error('File access management is required.')
				const invite = await context.env.APP_DB.prepare(
					`SELECT id FROM invites WHERE id = ? AND org_id = ? AND resource_type = 'file' AND resource_id = ? AND kind = 'grant'`,
				)
					.bind(data.inviteId, context.user.request.org.id, data.fileId)
					.first()
				if (!invite) throw new Error('Invitation not found on this file.')
				await callCapabilityAsWebsite(
					context,
					(await getStaticRegistry()).capabilityMap.inviteRevoke!,
					{ invite_id: data.inviteId },
				)
				return { ok: true as const }
			},
		)
	})

export const configureFileAsset = createServerFn({ method: 'POST' })
	.validator(
		scope.extend({
			cacheControl: z.enum(assetCacheControls),
			disposition: z.enum(['inline', 'attachment']),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { websiteCapabilityContext } =
			await import('../../src/app/website-capability.ts')
		const { setFileAssetSettings } =
			await import('../../src/files/public-links.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			(context) =>
				setFileAssetSettings(websiteCapabilityContext(context), data.fileId, {
					cacheControl: data.cacheControl,
					disposition: data.disposition,
				}),
		)
	})

export const createSignedFileAsset = createServerFn({ method: 'POST' })
	.validator(scope.extend({ minutes: z.number().int().min(1).max(1440) }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { websiteCapabilityContext } =
			await import('../../src/app/website-capability.ts')
		const { mintFileAssetUrl } = await import('../../src/files/public-links.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug, requireMembership: false } },
			(context) =>
				mintFileAssetUrl(
					websiteCapabilityContext(context),
					data.fileId,
					data.minutes,
				),
		)
	})
