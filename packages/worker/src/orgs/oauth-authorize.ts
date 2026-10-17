import {
	normalizeOrgSlug,
	readOrgSlugFromUrl,
	stripOrgFromResourceUri,
} from '#universal/org-binding/url.ts'
import { type AuthRequest } from '@cloudflare/workers-oauth-provider'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { mcpOAuthResourceUri } from '#worker/oauth-provider-options.ts'
import { OrgAuthorizeError } from '#worker/orgs/authorize-error.ts'
import {
	getOrgBySlug,
	listOrgsForPerson,
	loadOrgBindingForOrg,
	type PersonOrg,
} from '#worker/orgs/repo.ts'

export type AuthorizeOrg = {
	orgId: string
	slug: string
}

export type AuthorizeConsentOrg = {
	slug: string
	displayName: string | null
	role: string | null
}

/**
 * Resolve `?org=` on the authorize URL and OAuth resource, then strip `org`
 * from the resource so profile resolution can still read `?profile=`.
 * Returns null when neither source names an org.
 */
export async function resolveAuthorizeOrg(input: {
	authorizeUrl?: URL
	env: Env
	request: Request
	authRequest: AuthRequest
	userId: string
}): Promise<AuthorizeOrg | null> {
	const fromAuthorizeUrl = readOrgSlugFromUrl(
		input.authorizeUrl?.href ?? input.request.url,
	)
	let fromResource: string | null = null
	if (typeof input.authRequest.resource === 'string') {
		const stripped = stripOrgFromResourceUri(input.authRequest.resource)
		fromResource = stripped.orgSlug
		input.authRequest.resource = stripped.canonicalResource
		const origin = getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		})
		const canonical = mcpOAuthResourceUri(origin)
		try {
			const resourceUrl = new URL(stripped.canonicalResource)
			const canonicalUrl = new URL(canonical)
			const onlyProfileQuery =
				[...resourceUrl.searchParams.keys()].every(
					(key) => key === 'profile',
				) &&
				resourceUrl.origin === canonicalUrl.origin &&
				resourceUrl.pathname.replace(/\/$/, '') ===
					canonicalUrl.pathname.replace(/\/$/, '')
			if (onlyProfileQuery && resourceUrl.searchParams.size === 0) {
				input.authRequest.resource = canonical
			}
		} catch {
			// Leave resource unchanged when it is not a URL we can normalize.
		}
	}

	if (fromAuthorizeUrl && fromResource && fromAuthorizeUrl !== fromResource) {
		throw new OrgAuthorizeError(
			'Organization on the authorize URL and OAuth resource do not match.',
		)
	}

	const candidate = fromAuthorizeUrl ?? fromResource
	if (!candidate) return null

	return await resolveAccessibleOrgBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: candidate,
	})
}

export async function resolveAccessibleOrgBySlug(input: {
	db: D1Database
	userId: string
	slug: string
}): Promise<AuthorizeOrg> {
	const slug = normalizeOrgSlug(input.slug)
	if (!slug) {
		throw new OrgAuthorizeError('Organization slug is required.')
	}
	const org = await getOrgBySlug(input.db, slug)
	if (!org) {
		throw new OrgAuthorizeError(`Organization @${slug} was not found.`)
	}
	const binding = await loadOrgBindingForOrg(input.db, input.userId, org.id)
	if (!binding) {
		throw new OrgAuthorizeError(
			`You do not have access to organization @${slug}.`,
		)
	}
	return { orgId: org.id, slug: org.slug }
}

/**
 * Consent / silent-OIDC org: form slug → `?org=` → sole accessible org.
 * When both form and `?org=`/resource name an org, they must agree.
 */
export async function selectConsentOrg(input: {
	db: D1Database
	userId: string
	formSlug: string | null
	urlOrg: AuthorizeOrg | null
}): Promise<AuthorizeOrg> {
	const formSlug = input.formSlug ? normalizeOrgSlug(input.formSlug) : null
	if (formSlug) {
		const fromForm = await resolveAccessibleOrgBySlug({
			db: input.db,
			userId: input.userId,
			slug: formSlug,
		})
		if (input.urlOrg && input.urlOrg.orgId !== fromForm.orgId) {
			throw new OrgAuthorizeError(
				'Organization on the form and authorize request do not match.',
			)
		}
		return fromForm
	}
	if (input.urlOrg) return input.urlOrg
	const orgs = await listOrgsForPerson(input.db, input.userId)
	if (orgs.length === 1) {
		const sole = orgs[0]
		if (!sole) {
			throw new OrgAuthorizeError(
				'This account has no organization to bind this connection to.',
			)
		}
		return { orgId: sole.id, slug: sole.slug }
	}
	if (orgs.length === 0) {
		throw new OrgAuthorizeError(
			'This account has no organization to bind this connection to.',
		)
	}
	throw new OrgAuthorizeError(
		'Choose an organization before approving this connection.',
	)
}

export function selectConsentOrgsForLoader(
	accessible: ReadonlyArray<PersonOrg>,
	requestedSlug: string | null,
): {
	orgs: Array<AuthorizeConsentOrg>
	selectedOrgSlug: string | null
} {
	const orgs = accessible.map((org) => ({
		slug: org.slug,
		displayName: org.display_name,
		role: org.role,
	}))
	const requested = requestedSlug ? normalizeOrgSlug(requestedSlug) : null
	if (requested && orgs.some((org) => org.slug === requested)) {
		return { orgs, selectedOrgSlug: requested }
	}
	if (orgs.length === 1) {
		return { orgs, selectedOrgSlug: orgs[0]?.slug ?? null }
	}
	return { orgs, selectedOrgSlug: null }
}

export function readOrgSlugFromForm(formData: FormData): string | null {
	const value = formData.get('org')
	if (typeof value !== 'string') return null
	const slug = normalizeOrgSlug(value)
	return slug.length > 0 ? slug : null
}

export { stripLoginFromAuthorizePrompt } from '#universal/safe-redirect.ts'
