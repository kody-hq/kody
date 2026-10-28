import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireOrgPermission,
	resolvePersonId,
} from '#mcp/capabilities/access/shared.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	loadPackageAppRunsAs,
	setPackageAppRunsAsPerson,
} from '#worker/package-runtime/package-app-authority.ts'

const runsAsOutputSchema = z.object({
	package_id: z.string(),
	runs_as: z
		.object({
			username: z.string(),
			source: z.enum(['explicit', 'publisher', 'personal-org']),
		})
		.nullable(),
	message: z.string().nullable(),
})

export const packageAppRunsAsSetCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageAppRunsAsSet',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		requiresLivePerson: true,
		description:
			'Choose who a package app runs as in this org: whose credentials it uses and who pays for it. Defaults to the person who last published it. Owners only. The person must be a live member of the org. Pass username null to go back to the publisher.',
		keywords: ['package app', 'runs as', 'publisher', 'authority', 'app'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1).describe('Package id of the app.'),
			username: z
				.string()
				.min(1)
				.nullable()
				.describe('Member who runs the app, or null for the publisher.'),
		}),
		outputSchema: runsAsOutputSchema,
		async handler(args, ctx) {
			const { request, db } = await requireOrgPermission(ctx, 'package:write')
			const access = await computeEffectivePermissions({
				env: ctx.env,
				request,
			})
			if (!access.isOwner) {
				throw new McpCallerError(
					'Only an Owner can choose who a package app runs as.',
				)
			}
			const saved = await getSavedPackageById(db, {
				userId: request.org.id,
				packageId: args.package_id,
			})
			if (!saved?.hasApp) {
				throw new McpCallerError('No package app with that id in this org.')
			}
			let personId: string | null = null
			if (args.username !== null) {
				personId = await resolvePersonId(db, { username: args.username })
				const binding = await loadOrgBindingForOrg(db, personId, request.org.id)
				if (!binding?.role) {
					throw new McpCallerError(
						'That person is not a member of this organization.',
					)
				}
			}
			const scope = { orgId: request.org.id, packageId: saved.id }
			await setPackageAppRunsAsPerson({ db, scope, personId })
			return await packageAppRunsAsOutput(ctx.env, scope)
		},
	},
)

export const packageAppRunsAsGetCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageAppRunsAsGet',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Who a package app runs as in this org right now (whose credentials it uses and who pays), or why it cannot run as anyone.',
		keywords: ['package app', 'runs as', 'publisher', 'authority', 'app'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1).describe('Package id of the app.'),
		}),
		outputSchema: runsAsOutputSchema,
		async handler(args, ctx) {
			const { request, db } = await requireOrgPermission(ctx, 'package:read')
			const saved = await getSavedPackageById(db, {
				userId: request.org.id,
				packageId: args.package_id,
			})
			if (!saved?.hasApp) {
				throw new McpCallerError('No package app with that id in this org.')
			}
			return await packageAppRunsAsOutput(ctx.env, {
				orgId: request.org.id,
				packageId: saved.id,
			})
		},
	},
)

async function packageAppRunsAsOutput(
	env: Env,
	scope: Parameters<typeof loadPackageAppRunsAs>[0]['scope'],
): Promise<z.infer<typeof runsAsOutputSchema>> {
	const runsAs = await loadPackageAppRunsAs({ env, scope })
	switch (runsAs.status) {
		case 'ready':
			return {
				package_id: scope.packageId,
				runs_as: { username: runsAs.username, source: runsAs.source },
				message: null,
			}
		case 'unavailable':
			return {
				package_id: scope.packageId,
				runs_as: null,
				message: runsAs.message,
			}
		default: {
			const exhaustive: never = runsAs
			throw new Error(`Unhandled runs-as status: ${JSON.stringify(exhaustive)}`)
		}
	}
}
