/**
 * Gateway enforcement of a credential's fill placement (ADR 0068, amendment
 * 2026-10-27). Headers follow the stored placement. The query, URL path, and
 * body also need an owner opt-in, because the host may store the value there.
 * A legacy credential with no placement (null) narrows to headers plus the
 * parts it was seen filled into before enforcement (recorded as `observed`
 * opt-ins by migration 0195), so nobody migrates anything by hand.
 */
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	buildCredentialPlacementApprovalUrl,
	buildCredentialPlacementSettingUrl,
} from './placement-approval-links.ts'
import {
	type CredentialFillPlacement,
	type CredentialFillSite,
	type FillPlacementObserveSurface,
	type SecretResolutionFillMode,
	fillPlacementAllowsUnderResolution,
	fillPlacementRefusalMessage,
	observeFillPlacementWouldBlockSites,
} from './fill-placement.ts'
import {
	type FillPlacementOptIn,
	optInFillPlacementParts,
	noFillPlacementOptIn,
	placementNeedsOptIn,
	readFillPlacementOptIn,
} from './fill-placement-opt-ins.ts'

/**
 * The placement the gateway enforces: stored headers (any header for a legacy
 * null placement), plus each query, path, or body part that is both allowed
 * by the stored placement and opted in.
 */
export function effectiveFillPlacement(
	stored: CredentialFillPlacement | null,
	optIn: FillPlacementOptIn,
): CredentialFillPlacement | null {
	const headers = stored === null ? true : stored.headers
	const effective: CredentialFillPlacement =
		headers !== undefined ? { headers } : {}
	for (const part of optInFillPlacementParts) {
		if ((stored === null || stored[part] === true) && optIn[part]) {
			effective[part] = true
		}
	}
	const hasPart =
		effective.headers !== undefined ||
		optInFillPlacementParts.some((part) => effective[part] === true)
	// Nothing left (for example body-only, not opted in): `{}` allows no site.
	return hasPart ? effective : {}
}

export async function resolveEffectiveFillPlacement(input: {
	db: D1Database
	credentialId: string | null
	stored: CredentialFillPlacement | null
}): Promise<CredentialFillPlacement | null> {
	if (!placementNeedsOptIn(input.stored)) return input.stored
	const optIn = input.credentialId
		? await readFillPlacementOptIn(input.db, input.credentialId)
		: noFillPlacementOptIn
	return effectiveFillPlacement(input.stored, optIn)
}

/**
 * What a refusal can link to. Only the owner can approve a wider placement;
 * the links are for the agent to hand to them.
 */
export type FillPlacementRefusalLinks = {
	baseUrl: string
	/** The slug of the org that owns the credential, when known. */
	orgSlug: string | null
	/**
	 * Set for a user-scope secret the org owns: query, path, and body refusals
	 * carry its `/connect/secrets?placement=` owner-approval link.
	 */
	approvalSecretName?: string | null
	requestHost?: string | null
}

/** The run org's slug when the actor runs in `orgId`, for refusal links. */
export function refusalLinkOrgSlug(input: {
	actor: RequestContext | null
	orgId: string
}) {
	return input.actor?.org.id === input.orgId
		? (input.actor.org.slug ?? null)
		: null
}

function partPhrase(site: CredentialFillSite) {
	switch (site.part) {
		case 'header':
			return 'that header'
		case 'path':
			return 'the URL path'
		case 'query':
		case 'body':
			return `the ${site.part}`
		default: {
			const exhaustive: never = site
			throw new Error(`Unhandled fill site: ${String(exhaustive)}`)
		}
	}
}

function safeLink(build: () => string) {
	try {
		return build()
	} catch {
		return null
	}
}

function refusalHint(input: {
	site: CredentialFillSite
	credentialId: string | null
	links?: FillPlacementRefusalLinks | null
}) {
	const { site, links } = input
	const phrase = partPhrase(site)
	const storesWarning =
		site.part === 'header'
			? ''
			: ', which warns that the host may store the value there'
	// Both links name the owning org and the exact credential id, so neither
	// can open a same-named credential in the viewer's current org.
	const approvalUrl =
		site.part !== 'header' &&
		links?.approvalSecretName &&
		links.orgSlug &&
		input.credentialId
			? safeLink(() =>
					buildCredentialPlacementApprovalUrl({
						baseUrl: links.baseUrl,
						names: [links.approvalSecretName ?? ''],
						parts: [site.part],
						hosts: links.requestHost ? [links.requestHost] : [],
						orgSlug: links.orgSlug,
						credentialId: input.credentialId,
					}),
				)
			: null
	if (approvalUrl) {
		return `Ask its owner to open ${approvalUrl} to allow ${phrase}${storesWarning}. Only the owner can approve it; do not retry until they do.`
	}
	const settingUrl =
		links?.orgSlug && input.credentialId
			? safeLink(() =>
					buildCredentialPlacementSettingUrl({
						baseUrl: links.baseUrl,
						orgSlug: links.orgSlug ?? '',
						credentialId: input.credentialId ?? '',
					}),
				)
			: null
	if (settingUrl) {
		return `Its owner can allow ${phrase} in the credential's fill placement setting${storesWarning}: ${settingUrl}`
	}
	return `Its owner can allow ${phrase} on the credential page${storesWarning}.`
}

/**
 * Observes `sites` against the effective placement, then refuses the first
 * site it does not allow. Never reads or reports the value.
 */
export function enforceFillPlacement(input: {
	env: Pick<Env, 'APP_DB'>
	credentialName: string
	credentialId: string | null
	slot: string | null
	placement: CredentialFillPlacement | null
	sites: ReadonlyArray<CredentialFillSite>
	surface: FillPlacementObserveSurface
	resolutionMode?: SecretResolutionFillMode
	links?: FillPlacementRefusalLinks | null
}) {
	observeFillPlacementWouldBlockSites({
		credentialName: input.credentialName,
		placement: input.placement,
		sites: input.sites,
		surface: input.surface,
		resolutionMode: input.resolutionMode,
		env: input.env,
		credentialId: input.credentialId,
	})
	const mode = input.resolutionMode ?? 'on'
	const refused = input.sites.find(
		(site) => !fillPlacementAllowsUnderResolution(input.placement, site, mode),
	)
	if (!refused) return
	throw new SecretPlacementError(
		`${fillPlacementRefusalMessage({
			credentialName: input.credentialName,
			site: refused,
			placement: input.placement,
		})} ${refusalHint({
			site: refused,
			credentialId: input.credentialId,
			links: input.links,
		})}`,
		input.slot,
	)
}
