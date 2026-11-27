import { resolveHostedPackageAppLocation } from '@kody-internal/shared/public-urls.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { appVisitRequest } from '#worker/app-visit/authorize.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import {
	checkPermission,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { listOrgsForPerson, loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

export const appListCapabilityName = 'appList'

const appListDefaultLimit = 100
const appListMaxLimit = 200

const appListItemSchema = z.object({
	app: z.string().describe('The app address to pass to appFetch: @org/app.'),
	owner: z.string().describe('Handle of the org that owns the app.'),
	name: z.string().describe('Package name of the app.'),
	package_id: z.string(),
	description: z.string(),
	hosted_url: z
		.string()
		.describe(
			'Where a person opens the app in a browser. Call it with appFetch; the hosted URL does not accept tokens.',
		),
	visibility: z
		.enum(['public', 'private'])
		.describe(
			'public: anyone on the internet can open it. private: only people it is shared with.',
		),
	shared: z
		.boolean()
		.describe(
			'True when the app was shared with you from an org you are not a member of.',
		),
})

function parseCursor(cursor: string | undefined) {
	if (cursor === undefined) return 0
	const offset = Number(cursor)
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new McpCallerError(
			'cursor must be the next_cursor value from the previous appList page.',
		)
	}
	return offset
}

export const appListCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: appListCapabilityName,
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'List the hosted package apps you can run: apps in every org you belong to and apps other orgs shared with you. Each is one you hold app:execute on, the same check appFetch and a browser visit make; a profile token lists only the apps its profile chain was given Use on. Returns the @org/app address to pass to appFetch, the owning org, the hosted URL a person opens, and visibility. Pass owner to list one org only.',
		keywords: [
			'app',
			'apps',
			'list apps',
			'package app',
			'shared app',
			'apps I can run',
			'hosted app',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			owner: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Org handle (with or without @) to list one org only. Omit to list every app you can run.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(appListMaxLimit)
				.optional()
				.describe(`Apps per page. Defaults to ${appListDefaultLimit}.`),
			cursor: z
				.string()
				.optional()
				.describe('next_cursor from the previous page.'),
		}),
		outputSchema: z.object({
			apps: z.array(appListItemSchema),
			next_cursor: z
				.string()
				.nullable()
				.describe('Pass as cursor for the next page; null on the last page.'),
		}),
		async handler(args, ctx) {
			const callerRequest = requireMcpRequest(ctx.callerContext)
			const actor = callerRequest.actor
			if (!actor) {
				throw new McpCallerError(
					`${appListCapabilityName} needs a signed-in caller, whose apps it lists.`,
				)
			}
			const offset = parseCursor(args.cursor)
			const limit = args.limit ?? appListDefaultLimit
			const db = ctx.env.APP_DB
			const onlyOrg = args.owner?.trim().replace(/^@/, '').toLowerCase()
			const orgs = (await listOrgsForPerson(db, actor.userId)).filter(
				(org) => !onlyOrg || org.slug.toLowerCase() === onlyOrg,
			)
			const packageAppBaseUrl = getPackageAppBaseUrl({ env: ctx.env })
			const perOrg = await Promise.all(
				orgs.map(async (org) => {
					const binding = await loadOrgBindingForOrg(db, actor.userId, org.id)
					if (!binding) return []
					// The visit check, in the org that owns the apps: the person's
					// live access there, this token's scopes, and its profile chain.
					const access = await computeEffectivePermissions({
						env: ctx.env,
						request: appVisitRequest(callerRequest, binding),
					})
					const orgId = ownerIdFromStored(org.id)
					const packages = await listSavedPackagesByUserId(db, {
						userId: org.id,
					})
					return packages
						.filter(
							(saved) =>
								saved.hasApp &&
								checkPermission(access, 'app:execute', {
									type: 'app',
									id: saved.id,
									orgId,
								}).allowed,
						)
						.map((saved) => {
							const leaf = getPackageNameLeaf(saved.name)
							return {
								app: `@${org.slug}/${leaf}`,
								owner: org.slug,
								name: saved.name,
								package_id: saved.id,
								description: saved.description,
								hosted_url: resolveHostedPackageAppLocation({
									packageAppBaseUrl,
									appBaseUrl: ctx.callerContext.baseUrl,
									username: org.slug,
									kodyId: leaf,
									restPath: null,
								}).hostedUrl,
								visibility: saved.isInternetVisible
									? ('public' as const)
									: ('private' as const),
								shared: binding.role === null,
							}
						})
				}),
			)
			const apps = perOrg
				.flat()
				.sort((left, right) => left.app.localeCompare(right.app))
			const page = apps.slice(offset, offset + limit)
			return {
				apps: page,
				next_cursor:
					offset + limit < apps.length ? String(offset + limit) : null,
			}
		},
	},
)
