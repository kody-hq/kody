import {
	optionalOrgAuditWriter,
	orgAuditCauseFromCaller,
} from '#worker/orgs/org-audit.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	deleteSavedPackageProjection,
	PackageStorageCleanupError,
} from '#worker/package-registry/service.ts'

function createPackageDeleteConfirmNameError(packageName: string) {
	return [
		`This permanently deletes "${packageName}".`,
		'It removes the package from the account, stops its jobs, clears package storage and package-scoped secrets, unlists a public catalog entry if one exists, and best-effort deletes Artifacts repos.',
		'Existing forks keep their copies.',
		'This cannot be undone.',
		'Hiding or making the package private is not deletion.',
		`Do not call this unless the owner explicitly asked to delete this package and typed its name.`,
		`Then pass confirm_name: "${packageName}" (the package name).`,
	].join(' ')
}

export const deletePackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageDelete',
		contextRuns: 'deny',
		orgPermission: 'package:delete',
		description:
			'Permanently delete a saved package the signed-in user owns. This cannot be undone. It removes the package from the account and from /community if it was public, stops its jobs, clears package storage and package-scoped secrets, and best-effort deletes Artifacts repos. Existing forks keep their copies. Hiding (`packageUpdate` hidden) or making a package private is not deletion. Do not call this because a package is unused, failing, or over quota unless the owner explicitly asked to delete that specific package. Load it with packageGet or packageList, show the owner the package name and what will be destroyed, wait for them to type that name, then pass package_id and confirm_name matching the package name exactly.',
		keywords: [
			'package',
			'delete',
			'remove',
			'destroy',
			'uninstall',
			'quota',
			'limit',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			package_id: z.string().min(1).describe('Saved package id to delete.'),
			confirm_name: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Required. Must equal the package name (`package.json` name, for example @you/my-package). Ask the owner to type that name first. The capability refuses the delete and names the expected value when this is missing or wrong.',
				),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			package_id: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const existing = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!existing) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			await authorizePackageWrite(
				{ env: ctx.env, request: ctx.callerContext.request },
				{
					id: existing.id,
					userId: existing.userId,
					label: existing.name,
				},
				'package:delete',
			)
			if (args.confirm_name?.trim() !== existing.name) {
				throw new McpCallerError(
					createPackageDeleteConfirmNameError(existing.name),
				)
			}
			try {
				await deleteSavedPackageProjection({
					env: ctx.env,
					userId: owner.ownerUserId,
					actorUserId: owner.actorUserId,
					packageId: args.package_id,
					audit: optionalOrgAuditWriter(
						ctx.env,
						ctx.callerContext.request ?? null,
						orgAuditCauseFromCaller(ctx.callerContext),
					),
				})
			} catch (error) {
				if (error instanceof PackageStorageCleanupError) {
					throw new McpCallerError(error.message, { cause: error })
				}
				throw error
			}
			return {
				ok: true as const,
				package_id: args.package_id,
			}
		},
	},
)
