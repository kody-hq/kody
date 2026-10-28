import { type AutomationRouting } from '#worker/execution-contexts/automation-execution.ts'
import {
	type AutomationExecutionTarget,
	automationTargetId,
	exportKeyForPath,
	resolveAutomationRouting,
} from '#worker/execution-contexts/automation-settings.ts'
import { normalizePackageExportKey } from '#worker/package-registry/manifest.ts'
import { loadInvokeManifestBySourceId } from './module-artifacts.ts'

/**
 * Execution setting for a declared package automation: the API/UI override,
 * else the manifest's `execution`. Null runs on Kody cloud as before.
 */
export async function resolvePackageAutomationRouting(input: {
	env: Env
	orgId: string
	packageId: string
	sourceId: string
	target: AutomationExecutionTarget
}): Promise<AutomationRouting | null> {
	const { manifest } = await loadInvokeManifestBySourceId({
		env: input.env,
		userId: input.orgId,
		sourceId: input.sourceId,
	})
	const exports = manifest.exports ?? {}
	let declared: unknown = null
	let exportKey: string | null = null
	switch (input.target.kind) {
		case 'webhook': {
			const name = input.target.name
			const webhook = manifest.kody.webhooks?.find((w) => w.name === name)
			declared = webhook?.execution ?? null
			exportKey = webhook ? normalizePackageExportKey(webhook.export) : null
			break
		}
		case 'subscription': {
			const subscription = manifest.kody.subscriptions?.[input.target.name]
			declared = subscription?.execution ?? null
			exportKey = subscription
				? exportKeyForPath(exports, subscription.handler)
				: null
			break
		}
		case 'job': {
			const job = manifest.kody.jobs?.[input.target.name]
			declared = job?.execution ?? null
			exportKey = job ? exportKeyForPath(exports, job.entry) : null
			break
		}
	}
	return await resolveAutomationRouting({
		db: input.env.APP_DB,
		orgId: input.orgId,
		kind: input.target.kind,
		targetId: automationTargetId({
			kind: input.target.kind,
			packageId: input.packageId,
			name: input.target.name,
			...(input.target.kind === 'job' ? { jobId: input.target.jobId } : {}),
		}),
		declared,
		packageName: manifest.name,
		exportKey,
	})
}
