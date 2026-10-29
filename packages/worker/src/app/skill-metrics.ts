import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { listSavedPackagesWithCommunityProvenanceByUserId } from '#worker/package-registry/repo.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type CallerSkillsCatalog,
	loadCallerSkillsCatalog,
} from '#mcp/skills/skills-catalog.ts'
import { runLogRpc } from '#worker/run-records/service.ts'
import { type SkillMetrics } from '#universal/skill-metrics.ts'

export async function loadSkillMetrics(input: {
	env: Env
	callerContext: McpCallerContext
	catalog?: CallerSkillsCatalog
}): Promise<SkillMetrics> {
	const catalog =
		input.catalog ??
		(await loadCallerSkillsCatalog({ ...input, failOnError: true }))
	const request = input.callerContext.request
	if (!request) throw new Error('Skill metrics require an organization.')
	const [access, records] = await Promise.all([
		computeEffectivePermissions({ env: input.env, request }),
		listSavedPackagesWithCommunityProvenanceByUserId(input.env.APP_DB, {
			userId: request.org.id,
		}),
	])
	const packageIds = records
		.filter(
			(record) =>
				checkPermission(access, 'package:read', packageResource(record))
					.allowed,
		)
		.map((record) => record.id)
	const summary = await runLogRpc({
		env: input.env,
		userId: request.org.id,
	}).skillReadSummary({
		since: new Date(Date.now() - 30 * 86400000).toISOString(),
		packageIds,
	})
	return {
		...summary,
		skillCount: catalog.reduce((n, pkg) => n + pkg.index.skills.length, 0),
		packageCount: catalog.length,
	}
}
