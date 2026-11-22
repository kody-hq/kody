/**
 * Splits the publish check's request-placement hits by whether the publishing
 * org's named credential already fills that part. The answer is the same
 * effective fill placement the fetch gateway enforces, so a legacy Key with no
 * stored placement and an observed opt-in counts as allowed. Each hit the
 * credential does not allow carries the owner's approval link.
 * Remove when: every secret credential row has a stored placement (null placements backfilled).
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readStoredCredentialPlacement } from '#worker/credentials/credential-fields.ts'
import type { CredentialFillPlacement } from '#worker/credentials/fill-placement.ts'
import { resolveEffectiveFillPlacement } from '#worker/credentials/fill-placement-enforcement.ts'
import {
	buildCredentialPlacementApprovalUrl,
	buildCredentialPlacementSettingUrl,
} from '#worker/credentials/placement-approval-links.ts'
import type { SecretPlaceholderRequestPlacementHit } from '#worker/credentials/secret-placeholder-request-placement.ts'
import {
	getIntegrationCredentialId,
	getIntegrationFillPlacement,
} from '#worker/integrations/repo.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

type CredentialAllowance = {
	credentialId: string | null
	effective: CredentialFillPlacement | null
}

export async function partitionSecretPlaceholderRequestPlacementHits(input: {
	db: D1Database
	/** The org that is publishing. */
	ownerId: string
	baseUrl: string
	hits: ReadonlyArray<SecretPlaceholderRequestPlacementHit>
}): Promise<{
	blocked: Array<SecretPlaceholderRequestPlacementHit>
	allowed: Array<SecretPlaceholderRequestPlacementHit>
}> {
	const blocked: Array<SecretPlaceholderRequestPlacementHit> = []
	const allowed: Array<SecretPlaceholderRequestPlacementHit> = []
	if (input.hits.length === 0) return { blocked, allowed }
	const orgSlug = (await getOrgById(input.db, input.ownerId))?.slug ?? null
	const allowances = new Map<string, Promise<CredentialAllowance>>()
	const allowanceOf = (hit: SecretPlaceholderRequestPlacementHit) => {
		const key = `${hit.nameKind}:${hit.name}`
		let allowance = allowances.get(key)
		if (!allowance) {
			allowance = readCredentialAllowance({
				db: input.db,
				ownerId: input.ownerId,
				hit,
			})
			allowances.set(key, allowance)
		}
		return allowance
	}
	for (const hit of input.hits) {
		// The gateway never fills a whole URL (that would pick the host).
		if (hit.part === 'url') {
			blocked.push(hit)
			continue
		}
		const { credentialId, effective } = await allowanceOf(hit)
		if (effective?.[hit.part] === true) {
			allowed.push(hit)
			continue
		}
		const approvalUrl =
			hit.nameKind === 'secret'
				? buildCredentialPlacementApprovalUrl({
						baseUrl: input.baseUrl,
						names: [hit.name],
						parts: [hit.part],
						orgSlug,
						credentialId,
					})
				: credentialId && orgSlug
					? buildCredentialPlacementSettingUrl({
							baseUrl: input.baseUrl,
							orgSlug,
							credentialId,
						})
					: null
		blocked.push(approvalUrl ? { ...hit, approvalUrl } : hit)
	}
	return { blocked, allowed }
}

async function readCredentialAllowance(input: {
	db: D1Database
	ownerId: string
	hit: SecretPlaceholderRequestPlacementHit
}): Promise<CredentialAllowance> {
	if (input.hit.nameKind === 'secret') {
		const stored = await readStoredCredentialPlacement({
			db: input.db,
			orgId: ownerIdFromStored(input.ownerId),
			name: input.hit.name,
		})
		if (!stored) return { credentialId: null, effective: null }
		return {
			credentialId: stored.id,
			effective: await resolveEffectiveFillPlacement({
				db: input.db,
				credentialId: stored.id,
				stored: stored.placement,
			}),
		}
	}
	const credentialId = await getIntegrationCredentialId({
		db: input.db,
		userId: input.ownerId,
		name: input.hit.name,
	})
	if (!credentialId) return { credentialId: null, effective: null }
	return {
		credentialId,
		effective: await resolveEffectiveFillPlacement({
			db: input.db,
			credentialId,
			stored: await getIntegrationFillPlacement({
				db: input.db,
				userId: input.ownerId,
				name: input.hit.name,
			}),
		}),
	}
}
