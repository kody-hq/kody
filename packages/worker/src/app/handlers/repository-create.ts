import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	callCapabilityAsWebsite,
	websiteCapabilityContext,
} from '#app/website-capability.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { repoCreateCapability } from '#mcp/capabilities/repo/repo-create.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	AuthorizationError,
	checkPermission,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import {
	listOrganizationsForPerson,
	loadOrgBindingForSlug,
	type OrgBinding,
} from '#worker/orgs/repo.ts'
import {
	buildRepositoryStartPrompt,
	repositoryCloneUrl,
	repositoryNameError,
	type RepositoryCreateOptions,
	type RepositoryCreateResult,
	type RepositoryOwnerOption,
} from '#universal/repository-create.ts'

type User = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

type RepositoryCreateInput = {
	env: Env
	request: Request
	user: User
}

function callerContextFor(input: RepositoryCreateInput, binding: OrgBinding) {
	return websiteCapabilityContext({ ...input, orgBinding: binding })
		.callerContext
}

async function canCreateIn(input: RepositoryCreateInput, binding: OrgBinding) {
	const callerContext = callerContextFor(input, binding)
	if (!callerContext.request) return false
	const access = await computeEffectivePermissions({
		env: input.env,
		request: callerContext.request,
	})
	return checkPermission(access, 'package:create').allowed
}

/**
 * Owners the viewer may create a repository in: their personal account first,
 * then every org where `repoCreate` would pass its `package:create` check.
 */
export async function loadRepositoryCreateOptions(
	input: RepositoryCreateInput,
): Promise<RepositoryCreateOptions> {
	const organizations = await listOrganizationsForPerson(
		input.env.APP_DB,
		input.user.mcpUser.userId,
	)
	const checked = await Promise.all(
		organizations.map(async (organization) => {
			const binding = await loadOrgBindingForSlug(
				input.env.APP_DB,
				input.user.mcpUser.userId,
				organization.slug,
			)
			if (!binding || !(await canCreateIn(input, binding))) return null
			const owner: RepositoryOwnerOption = {
				slug: organization.slug,
				displayName: organization.displayName,
				personal: organization.personal,
			}
			return owner
		}),
	)
	const owners = checked
		.filter((owner): owner is RepositoryOwnerOption => owner !== null)
		.sort((a, b) =>
			a.personal === b.personal
				? a.slug.localeCompare(b.slug)
				: a.personal
					? -1
					: 1,
		)
	return { ok: true, owners }
}

/**
 * Website entry to `repoCreate`: binds the chosen owner org, then runs the
 * capability so naming, `package:create`, the repos plan limit, and the
 * duplicate check stay identical to MCP and `POST /v1/repos`.
 */
export async function createWebsiteRepository(
	input: RepositoryCreateInput & { ownerSlug: string; name: string },
): Promise<RepositoryCreateResult> {
	const nameError = repositoryNameError(input.name)
	if (nameError) return { ok: false, error: nameError, field: 'name' }
	const binding = await loadOrgBindingForSlug(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		input.ownerSlug,
	)
	const ownerRefused = {
		ok: false as const,
		error: "You can't create repositories in that account.",
		field: 'owner' as const,
	}
	if (!binding?.org.slug) return ownerRefused
	let created: Awaited<ReturnType<typeof repoCreateCapability.handler>>
	try {
		created = await callCapabilityAsWebsite(
			{ ...input, orgBinding: binding },
			repoCreateCapability,
			{ name: input.name },
		)
	} catch (error) {
		if (error instanceof AuthorizationError)
			return {
				...ownerRefused,
				error: `${ownerRefused.error} ${error.message}`,
			}
		if (isEntitlementLimitError(error) && error instanceof Error)
			return { ok: false, error: error.message, field: null }
		if (isMcpCallerError(error) && error instanceof Error)
			return { ok: false, error: error.message, field: 'name' }
		throw error
	}
	const owner = binding.org.slug
	const personal = await isPersonalOrg(input.env.APP_DB, binding.org.id)
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	return {
		ok: true,
		owner,
		name: created.name,
		personal,
		repositoryHref: `/@${owner}/${created.name}`,
		cloneUrl: repositoryCloneUrl({ origin, owner, name: created.name }),
		prompt: buildRepositoryStartPrompt({
			origin,
			owner,
			name: created.name,
			personal,
		}),
	}
}
