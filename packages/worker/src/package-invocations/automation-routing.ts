import { type AutomationRouting } from '#worker/execution-contexts/automation-execution.ts'
import {
	type AutomationExecutionTarget,
	automationTargetId,
	buildExecuteInvokePassthroughSource,
	exportKeyForPath,
	packageExportSpecifier,
	resolveAutomationRouting,
} from '#worker/execution-contexts/automation-settings.ts'
import { normalizePackageExportKey } from '#worker/package-registry/manifest.ts'
import { loadInvokeManifestBySourceId } from './module-artifacts.ts'

type DeclaredAutomation = {
	found: boolean
	declared: unknown
	exportKey: string | null
	packageName: string
}

/** The automation as its manifest declares it (cached invoke manifest). */
export async function loadDeclaredAutomation(input: {
	env: Env
	orgId: string
	sourceId: string
	target: Exclude<AutomationExecutionTarget, { kind: 'workflow' }>
}): Promise<DeclaredAutomation> {
	const { manifest } = await loadInvokeManifestBySourceId({
		env: input.env,
		userId: input.orgId,
		sourceId: input.sourceId,
	})
	const exports = manifest.exports ?? {}
	const packageName = manifest.name
	switch (input.target.kind) {
		case 'webhook': {
			const name = input.target.name
			const webhook = manifest.kody.webhooks?.find((w) => w.name === name)
			return {
				found: Boolean(webhook),
				declared: webhook?.execution ?? null,
				exportKey: webhook ? normalizePackageExportKey(webhook.export) : null,
				packageName,
			}
		}
		case 'subscription': {
			const subscription = manifest.kody.subscriptions?.[input.target.name]
			return {
				found: Boolean(subscription),
				declared: subscription?.execution ?? null,
				exportKey: subscription
					? exportKeyForPath(exports, subscription.handler)
					: null,
				packageName,
			}
		}
		case 'job': {
			const job = manifest.kody.jobs?.[input.target.name]
			return {
				found: Boolean(job),
				declared: job?.execution ?? null,
				exportKey: job ? exportKeyForPath(exports, job.entry) : null,
				packageName,
			}
		}
	}
}

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
	if (input.target.kind === 'workflow') {
		const { manifest } = await loadInvokeManifestBySourceId({
			env: input.env,
			userId: input.orgId,
			sourceId: input.sourceId,
		})
		return {
			setting: input.target.execution,
			needsResult: true,
			contextCode: buildExecuteInvokePassthroughSource(
				packageExportSpecifier(
					manifest.name,
					normalizePackageExportKey(input.target.exportName),
				),
			),
		}
	}
	const declared = await loadDeclaredAutomation({
		env: input.env,
		orgId: input.orgId,
		sourceId: input.sourceId,
		target: input.target,
	})
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
		declared: declared.declared,
		packageName: declared.packageName,
		exportKey: declared.exportKey,
	})
}
