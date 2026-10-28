/**
 * Gateway enforcement of a credential's fill placement (ADR 0068, amendment
 * 2026-10-27). Headers follow the stored placement. The query, URL path, and
 * body also need an owner opt-in, because the host may store the value there.
 * A legacy credential with no placement (null) narrows to headers plus the
 * parts it was seen filled into before enforcement (recorded as `observed`
 * opt-ins by migration 0195), so nobody migrates anything by hand.
 */
import { SecretPlacementError } from '#mcp/secrets/secret-placement.ts'
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

function refusalHint(site: CredentialFillSite) {
	return site.part === 'header'
		? 'Its owner can allow that header on the credential page.'
		: `Its owner can allow the ${site.part === 'path' ? 'URL path' : site.part} on the credential page, which warns that the host may store the value there.`
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
		})} ${refusalHint(refused)}`,
		input.slot,
	)
}
