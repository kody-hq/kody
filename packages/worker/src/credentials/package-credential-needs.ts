/**
 * A package's credential needs as an agent reads them in `packageGet`
 * (ADR 0068): the published closure, each need with how it resolves for the
 * caller. A stored default mapping (the caller's own, then the org's) wins
 * over auto-resolve, the same order a run uses. Options are filtered by the
 * caller's Use and never carry values.
 */
import * as Sentry from '@sentry/cloudflare'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	listUsableCredentials,
	resolveNeedCandidates,
	type UsableCredential,
} from './credential-candidates.ts'
import {
	loadCredentialMappings,
	resolveStoredMapping,
	type CredentialMappingRow,
} from './credential-mappings.ts'
import { mappedCredentialFitsNeed } from './credential-need-fit.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
import {
	savedCredentialNeeds,
	type SavedCredentialNeed,
} from './credential-needs.ts'

type NeedStatus = 'ready' | 'ambiguous' | 'unbound' | 'expired'

/**
 * How one need resolves with no call map entry: a stored default mapping
 * first, then auto-resolve. Trigger overrides are per run and not shown here.
 */
function resolveNeedForCaller(
	need: SavedCredentialNeed,
	usable: ReadonlyArray<UsableCredential>,
	rows: ReadonlyArray<CredentialMappingRow>,
): {
	status: NeedStatus
	autoPick: string | null
	source: 'mine' | 'org' | 'auto'
} {
	const layer = (target: 'mine' | 'org') =>
		rows.find((row) => row.needKey === need.key && row.target.target === target)
			?.credentialIds ?? null
	const stored = resolveStoredMapping({
		trigger: null,
		mine: layer('mine'),
		org: layer('org'),
		usable,
		accepts: (credential) => mappedCredentialFitsNeed(credential, need),
	})
	if (stored?.status === 'ready') {
		const [first] = stored.credentials
		return {
			status: stored.credentials.some((credential) => credential.expired)
				? 'expired'
				: 'ready',
			autoPick: first?.name ?? null,
			source: stored.source === 'mine' ? 'mine' : 'org',
		}
	}
	if (stored?.status === 'none') {
		return {
			status: 'unbound',
			autoPick: null,
			source: stored.source === 'mine' ? 'mine' : 'org',
		}
	}
	const resolution = resolveNeedCandidates(
		need,
		need.supplier === 'publisher'
			? usable.filter((credential) => credential.scope === 'org')
			: usable,
	)
	return {
		status: resolution.status,
		autoPick: resolution.autoPick?.name ?? null,
		source: 'auto',
	}
}

export async function describePackageCredentialNeeds(input: {
	env: Env
	request: RequestContext
	ownerUserId: string
	sourceId: string
	/** Saved package id so Keys bound to this package can fill its needs. */
	packageId: string
}) {
	try {
		const needs = savedCredentialNeeds(
			await loadPublishedCredentialNeeds({
				env: input.env,
				userId: input.ownerUserId,
				sourceId: input.sourceId,
				request: input.request,
			}),
		)
		if (needs.length === 0) return []
		const [usable, rows] = await Promise.all([
			listUsableCredentials({
				env: input.env,
				request: input.request,
				packageId: input.packageId,
			}),
			loadCredentialMappings({
				db: input.env.APP_DB,
				// Same scope a run reads (credential-client resolveMappedNeed).
				orgId: input.request.org.id,
				packageId: input.packageId,
				personId: input.request.actor?.userId ?? null,
			}),
		])
		return needs.map((need) => {
			const resolution = resolveNeedCandidates(need, usable)
			return {
				...need,
				...resolveNeedForCaller(need, usable, rows),
				yourOptions: resolution.options
					.filter(
						(option) => need.supplier !== 'publisher' || option.scope === 'org',
					)
					.map((option) => ({
						name: option.name,
						scope: option.scope,
						...(option.scope === 'org' && input.request.org.slug
							? { org: input.request.org.slug }
							: {}),
						hosts: option.hosts,
					})),
			}
		})
	} catch (error) {
		// packageGet keeps working when needs cannot be read.
		Sentry.captureException(error, {
			tags: { scope: 'packages.get.credential-needs' },
			extra: { sourceId: input.sourceId },
		})
		return []
	}
}
