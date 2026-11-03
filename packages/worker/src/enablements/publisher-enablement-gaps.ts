/**
 * Declared package triggers that are not on for a specific person (usually the
 * publisher). Used for publish test_hints and agent follow-ups.
 */

import type {
	OwnerId,
	PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import type { EnablementHintTrigger } from './enablement-agent-hints.ts'
import { listDeclaredTriggers } from './service.ts'

export async function listPublisherEnablementGaps(input: {
	env: Env
	baseUrl: string
	ownerUserId: OwnerId
	packageId: string
	publisherUserId: PersonId
}): Promise<Array<EnablementHintTrigger>> {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.ownerUserId,
		packageId: input.packageId,
	})
	if (!savedPackage) return []
	const triggers = await listDeclaredTriggers({
		env: input.env,
		baseUrl: input.baseUrl,
		savedPackage,
	})
	const gaps: Array<EnablementHintTrigger> = []
	for (const trigger of triggers) {
		const mine = trigger.enablements.filter(
			(enablement) =>
				String(enablement.enablerUserId) === String(input.publisherUserId),
		)
		if (mine.some((enablement) => enablement.state === 'on')) continue
		gaps.push({
			kind: trigger.kind,
			name: trigger.name,
			reason: mine.some((enablement) => enablement.state === 'paused')
				? 'paused'
				: 'missing',
		})
	}
	return gaps
}
