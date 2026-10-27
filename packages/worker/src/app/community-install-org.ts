import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	AuthorizationError,
	authorizePackageCreate,
} from '#worker/authorization/authorize.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

export type CommunityInstallOwner = {
	ownerId: OwnerId
	/** Null when the install targets the personal org (no `org` given). */
	orgSlug: string | null
}

export type CommunityInstallOwnerResult =
	| ({ ok: true } & CommunityInstallOwner)
	| { ok: false; status: 403 | 404; error: string }

export function normalizeInstallOrgSlug(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const slug = value.trim().replace(/^@/, '').toLowerCase()
	return slug || null
}

/**
 * The org a website community install writes to. Omitting `orgSlug` keeps the
 * personal org; a named org must exist for the viewer and pass the same
 * `package:create` check `repoCreate` uses.
 */
export async function resolveCommunityInstallOwner(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string | null | undefined
}): Promise<CommunityInstallOwnerResult> {
	const { env, request, user } = input
	const orgSlug = normalizeInstallOrgSlug(input.orgSlug)
	if (!orgSlug) {
		return {
			ok: true,
			ownerId: personalOrgIdForPerson(user.mcpUser),
			orgSlug: null,
		}
	}
	const notFound = {
		ok: false as const,
		status: 404 as const,
		error: `Organization @${orgSlug} was not found.`,
	}
	const binding = await loadOrgBindingForSlug(
		env.APP_DB,
		user.mcpUser.userId,
		orgSlug,
	)
	if (!binding) return notFound
	const callerContext = createMcpCallerContext({
		baseUrl: getAppBaseUrl({ env, requestUrl: request.url }),
		source: { kind: 'session' },
		executionOrigin: 'interactive',
		user: user.mcpUser,
		orgBinding: binding,
	})
	const forbidden = {
		ok: false as const,
		status: 403 as const,
		error: `You do not have permission to create packages in @${orgSlug}.`,
	}
	if (!callerContext.request) return forbidden
	try {
		await authorizePackageCreate({ env, request: callerContext.request })
	} catch (error) {
		if (error instanceof AuthorizationError) return forbidden
		throw error
	}
	return { ok: true, ownerId: binding.org.id as OwnerId, orgSlug }
}
