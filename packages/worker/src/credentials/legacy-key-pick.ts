import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { enablementIdOf } from '#worker/request-context/request-context.ts'
import type { SecretScope } from '#mcp/secrets/types.ts'
import type { CredentialCallMapJson } from './credential-call-map.ts'
import {
	listUsableCredentials,
	liveUsableCredentials,
} from './credential-candidates.ts'
import { loadCredentialMappings } from './credential-mappings.ts'
import {
	loadPackageNeeds,
	mappedCredentialFitsNeed,
} from './credential-need-fit.ts'
import type { SavedCredentialNeed } from './credential-needs.ts'
import { CredentialRequestRefusedError } from './credential-request.ts'

export async function pickLegacyMappedKey(input: {
	env: Env
	request: RequestContext | null
	legacyCredentialPicks?: CredentialCallMapJson | null
	packageApp?: boolean
	packageId: string | null
	reference: { name: string; scope?: SecretScope | null }
	declaredNeed?: SavedCredentialNeed
}) {
	const { env, request, packageId, reference } = input
	if (!request?.actor || (reference.scope && reference.scope !== 'user')) {
		return null
	}
	const callPicks = Object.hasOwn(
		input.legacyCredentialPicks ?? {},
		reference.name,
	)
		? input.legacyCredentialPicks?.[reference.name]
		: undefined
	const enablementId = enablementIdOf(request)
	const rows = packageId
		? await loadCredentialMappings({
				db: env.APP_DB,
				orgId: request.org.id,
				packageId,
				request,
				personId:
					input.declaredNeed?.supplier === 'publisher'
						? null
						: request.actor.userId,
				enablementIds: enablementId ? [enablementId] : [],
				needKey: reference.name,
				includeInvalid: true,
			})
		: []
	if (!input.declaredNeed && callPicks === undefined && rows.length === 0)
		return null
	const need =
		input.declaredNeed ??
		(packageId
			? (
					await loadPackageNeeds({
						env,
						packageId,
						orgId: request.org.id,
						request,
					})
				).find((need) => need.key === reference.name)
			: undefined)
	if (packageId && !need) return null
	if (need?.supplier === 'executor' && input.packageApp) {
		throw new CredentialRequestRefusedError(
			'invalid_request',
			'Use credential.visitor(key) for this app credential need.',
		)
	}
	const picks = need?.supplier === 'publisher' ? undefined : callPicks
	const layer = (target: 'enablement' | 'mine' | 'org') =>
		rows.find((row) => row.target.target === target)?.credentialIds
	const ids = picks
		? picks.map((pick) => ('id' in pick ? pick.id : null))
		: (layer('enablement') ??
			(need?.supplier === 'publisher' ? undefined : layer('mine')) ??
			(need?.supplier === 'executor' ? undefined : layer('org')))
	if (!ids) return null
	const id = ids.length === 1 ? ids[0] : null
	const selected =
		id &&
		liveUsableCredentials(
			await listUsableCredentials({
				env,
				request,
				packageId,
			}),
		).find(
			(credential) =>
				credential.id === id &&
				credential.kind === 'secret' &&
				(need?.supplier !== 'publisher' || credential.scope === 'org'),
		)
	if (!selected || (need && !mappedCredentialFitsNeed(selected, need))) {
		throw new CredentialRequestRefusedError(
			'invalid_request',
			'This credential need requires one available Key mapping. Review the mapping or use credential(key).',
		)
	}
	return selected.id
}
