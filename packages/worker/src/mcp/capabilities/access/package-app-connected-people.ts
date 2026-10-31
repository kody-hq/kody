import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	listPackageAppConnectedPeople,
	loadConnectedPeopleTarget,
	revokePackageAppConnectedPerson,
} from '#worker/package-app-connected-people.ts'
import { packageAppConnectedPeopleMaxPageSize } from '#universal/package-app-connected-people.ts'
import { rethrowAccessError } from './shared.ts'

const packageIdSchema = z.string().min(1).describe('Package id or kody id.')

const packageSchema = z.object({
	id: z.string(),
	kody_id: z.string(),
	name: z.string(),
})

const connectedPersonSchema = z.object({
	grant_id: z.string(),
	username: z.string().nullable(),
	display_name: z.string().nullable(),
	profile_path: z
		.string()
		.nullable()
		.describe('Their public profile path, or null when it is private.'),
	connected_at: z.string(),
	last_used_at: z
		.string()
		.nullable()
		.describe('Last call to the app, to the minute. Null if never used.'),
	allows: z
		.array(z.string())
		.describe('What they approved, in the consent screen wording.'),
})

async function loadTarget(ctx: CapabilityContext, packageId: string) {
	const loaded = await loadConnectedPeopleTarget({
		env: ctx.env,
		request: requireMcpRequest(ctx.callerContext),
		packageIdOrKodyId: packageId,
	})
	switch (loaded.kind) {
		case 'ok':
			return loaded.target
		case 'not_found':
			throw new McpCallerError('Package was not found in this organization.')
		case 'forbidden':
			throw new McpCallerError(
				'You need Manage on this package to see who signed in to its app.',
			)
		case 'no_app':
			throw new McpCallerError(
				'This package has no app, so nobody can sign in to it with Kody.',
			)
	}
}

export const packageAppConnectedPeopleListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'packageAppConnectedPeopleList',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			"List the people signed in to one package app with Sign in with Kody, in the organization this request is bound to: username, display name, when they connected, when they last used the app, and what they approved (in the consent screen's words). Most recently used first, paginated with page and page_size; total counts everyone. Deleted accounts are left out. package_id takes the package id or its kody id. You need Manage on the package. End one person's access with packageAppConnectedPersonRevoke.",
		keywords: [
			'package app',
			'sign in with kody',
			'oauth',
			'connected people',
			'visitors',
			'who signed in',
			'users of my app',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: packageIdSchema,
			page: z.number().int().min(1).optional().describe('1-based. Default 1.'),
			page_size: z
				.number()
				.int()
				.min(1)
				.max(packageAppConnectedPeopleMaxPageSize)
				.optional()
				.describe('Default 25.'),
		}),
		outputSchema: z.object({
			package: packageSchema,
			people: z.array(connectedPersonSchema),
			total: z.number().int(),
			page: z.number().int(),
			page_size: z.number().int(),
		}),
		async handler(args, ctx) {
			try {
				const target = await loadTarget(ctx, args.package_id)
				const view = await listPackageAppConnectedPeople({
					env: ctx.env,
					target,
					page: args.page,
					pageSize: args.page_size,
				})
				return {
					package: {
						id: view.package.id,
						kody_id: view.package.kodyId,
						name: view.package.name,
					},
					people: view.people.map((person) => ({
						grant_id: person.grantId,
						username: person.username,
						display_name: person.displayName,
						profile_path: person.profileHref,
						connected_at: person.connectedAt,
						last_used_at: person.lastUsedAt,
						allows: person.allows,
					})),
					total: view.total,
					page: view.page,
					page_size: view.pageSize,
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const packageAppConnectedPersonRevokeCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'packageAppConnectedPersonRevoke',
		contextRuns: 'deny',
		orgPermission: 'none',
		description:
			"End one person's Sign in with Kody access to a package app in the organization this request is bound to, by the grant_id from packageAppConnectedPeopleList. Same effect as the person revoking it from Account > Connected apps: their next call to the app is signed out and they must approve again. Their own credentials stay in their account. You need Manage on the package. Audited.",
		keywords: [
			'package app',
			'sign in with kody',
			'oauth',
			'revoke',
			'disconnect',
			'remove visitor',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			package_id: packageIdSchema,
			grant_id: z.string().min(1),
		}),
		outputSchema: z.object({
			grant_id: z.string(),
			revoked: z.literal(true),
		}),
		async handler(args, ctx) {
			try {
				const target = await loadTarget(ctx, args.package_id)
				const revoked = await revokePackageAppConnectedPerson({
					env: ctx.env,
					target,
					grantId: args.grant_id,
					audit: { email: ctx.callerContext.user?.email },
				})
				if (!revoked) {
					throw new McpCallerError(
						'That person is no longer signed in to this app.',
					)
				}
				return { grant_id: args.grant_id.trim(), revoked: true as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)
