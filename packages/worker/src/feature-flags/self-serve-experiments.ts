import {
	getFeatureFlagEvaluationsForUser,
	setFeatureFlagUserOverride,
} from '#worker/feature-flags/service.ts'
import {
	selfServeExperiments,
	type SelfServeExperimentId,
	type SelfServeExperimentState,
} from '#universal/feature-flags/experiments.ts'

export async function listSelfServeExperimentsForUser(
	db: D1Database,
	userId: number,
	orgId: string | null = null,
): Promise<Array<SelfServeExperimentState>> {
	const evaluations = await getFeatureFlagEvaluationsForUser(
		db,
		userId,
		orgId ? { orgId } : null,
	)
	return selfServeExperiments.map((experiment) => {
		const evaluation = evaluations[experiment.flagKey]
		return {
			id: experiment.id,
			title: experiment.title,
			summary: experiment.summary,
			stage: experiment.stage,
			docsPath: `/docs/${experiment.docsSlug}`,
			enabled: evaluation.enabled,
			choice: evaluation.source === 'override' ? 'you' : 'kody',
			orgSection: 'orgSection' in experiment ? experiment.orgSection : null,
		}
	})
}

/**
 * Turning an experiment off writes an explicit `false` override, so a later
 * audience or rollout change does not turn it back on for this person.
 */
export async function setSelfServeExperimentForUser(
	db: D1Database,
	input: { userId: number; id: SelfServeExperimentId; enabled: boolean },
) {
	const experiment = selfServeExperiments.find((entry) => entry.id === input.id)
	if (!experiment) throw new Error(`Unknown experiment: ${input.id}`)
	await setFeatureFlagUserOverride(db, {
		key: experiment.flagKey,
		userId: input.userId,
		enabled: input.enabled,
		updatedBy: input.userId,
	})
	return experiment
}

/** Numeric user id for a request actor (stable person id), or null. */
export async function readUserIdForPerson(db: D1Database, personId: string) {
	const row = await db
		.prepare(
			`SELECT id FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
		)
		.bind(personId)
		.first<{ id: number }>()
	return row?.id ?? null
}
