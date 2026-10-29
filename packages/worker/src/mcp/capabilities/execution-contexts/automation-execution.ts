import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	automationExecutionSchema,
	automationQueueDefaultMinutes,
	automationQueueMaxMinutes,
	parseAutomationExecution,
} from '#worker/execution-contexts/automation-execution-schema.ts'
import {
	automationExecutionKinds,
	automationTargetId,
	getAutomationExecutionOverride,
	setAutomationExecutionOverride,
} from '#worker/execution-contexts/automation-settings.ts'
import { ExecutionContextError } from '#worker/execution-contexts/errors.ts'
import { requireExecutionContextsCaller } from '#worker/execution-contexts/service.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { loadDeclaredAutomation } from '#worker/package-invocations/automation-routing.ts'
import { resolveSavedPackageRef } from '#worker/package-registry/repo.ts'

const domain = capabilityDomainNames.executionContexts

const targetSchema = z.object({
	kind: z
		.enum(automationExecutionKinds)
		.describe('Which automation: a job, a package webhook, or a subscription.'),
	jobId: z.string().min(1).optional().describe('Job id, for kind "job".'),
	packageId: z
		.string()
		.min(1)
		.optional()
		.describe('Package id or kody id, for kind "webhook" or "subscription".'),
	name: z
		.string()
		.min(1)
		.optional()
		.describe('Webhook name or subscription topic.'),
})
type Target = z.infer<typeof targetSchema>

function notFound(message: string): never {
	throw new ExecutionContextError({ status: 404, code: 'not_found', message })
}

/** The automation in the caller's org, as declared in its package. */
async function loadTarget(ctx: CapabilityContext, target: Target) {
	const caller = await requireExecutionContextsCaller(ctx)
	const orgId = caller.orgId
	if (target.kind === 'job') {
		if (!target.jobId) notFound('Pass jobId for kind "job".')
		const row = await jobsData(caller.env).getJobById({
			userId: ownerIdFromStored(orgId),
			jobId: target.jobId,
		})
		if (!row) notFound(`Job "${target.jobId}" was not found in this org.`)
		const declared = await loadDeclaredAutomation({
			env: caller.env,
			orgId,
			sourceId: row.record.sourceId,
			target: {
				kind: 'job',
				name: row.record.name,
				jobId: row.record.id,
			},
		})
		return {
			caller,
			targetId: automationTargetId({ kind: 'job', jobId: row.record.id }),
			declared,
		}
	}
	if (!target.packageId || !target.name) {
		notFound(`Pass packageId and name for kind "${target.kind}".`)
	}
	const savedPackage = await resolveSavedPackageRef(caller.env.APP_DB, {
		userId: orgId,
		ref: target.packageId,
	})
	if (!savedPackage) {
		notFound(`Package "${target.packageId}" was not found in this org.`)
	}
	const declared = await loadDeclaredAutomation({
		env: caller.env,
		orgId,
		sourceId: savedPackage.sourceId,
		target: { kind: target.kind, name: target.name },
	})
	if (!declared.found) {
		notFound(
			`Package "${savedPackage.kodyId}" does not declare ${target.kind} "${target.name}".`,
		)
	}
	return {
		caller,
		targetId: automationTargetId({
			kind: target.kind,
			packageId: savedPackage.id,
			name: target.name,
		}),
		declared,
	}
}

async function describe(ctx: CapabilityContext, target: Target) {
	const loaded = await loadTarget(ctx, target)
	const override = await getAutomationExecutionOverride(
		loaded.caller.env.APP_DB,
		{
			orgId: loaded.caller.orgId,
			kind: target.kind,
			targetId: loaded.targetId,
		},
	)
	const declared = parseAutomationExecution(loaded.declared.declared)
	return {
		kind: target.kind,
		targetId: loaded.targetId,
		declared,
		override: override?.execution ?? null,
		overrideUpdatedAt: override?.updatedAt ?? null,
		effective: override?.execution ?? declared,
		contextRunnable: loaded.declared.exportKey !== null,
		queueDefaults: {
			defaultMinutes: automationQueueDefaultMinutes,
			maxMinutes: automationQueueMaxMinutes,
		},
	}
}

export const automationExecutionGetCapability = defineDomainCapability(domain, {
	name: 'automationExecutionGet',
	contextRuns: 'allow',
	orgPermission: 'job:read',
	description:
		'Where a job, package webhook, or subscription runs: the `execution` its package declares, any override set here, and the effective setting (override wins). effective null runs on Kody cloud. contextRunnable false means its handler is not a package export, so it cannot run on an execution context.',
	keywords: [
		'execution context',
		'automation',
		'job',
		'webhook',
		'subscription',
	],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: targetSchema,
	async handler(args, ctx) {
		return await describe(ctx, args)
	},
})

export const automationExecutionSetCapability = defineDomainCapability(domain, {
	name: 'automationExecutionSet',
	contextRuns: 'deny',
	orgPermission: 'job:write',
	description: `Choose where a job, package webhook, or subscription runs, overriding its manifest \`execution\`. Same rules as execute: \`context\` names one context (no fallback unless \`fallback: "chain"\`), or \`chain\` lists up to 3 contexts with "cloud" only last; \`requires\` skips entries without "fs"/"lan". Runs use the access of the person the automation runs as. \`whenOffline\`: "fail" (default) fails the run when nothing qualifies; "queue" waits for the context to reconnect for \`queueMinutes\` (default ${automationQueueDefaultMinutes}, max ${automationQueueMaxMinutes}). Pass execution null to clear the override.`,
	keywords: [
		'execution context',
		'automation',
		'job',
		'webhook',
		'subscription',
		'queue',
		'offline',
	],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: targetSchema.extend({
		execution: automationExecutionSchema.nullable(),
	}),
	async handler(args, ctx) {
		const { execution, ...target } = args
		const loaded = await loadTarget(ctx, target)
		if (execution && loaded.declared.exportKey === null) {
			throw new ExecutionContextError({
				status: 400,
				code: 'invalid_request',
				message: `This ${target.kind}'s handler is not a package export, so an execution context cannot import it. Export it from the package first.`,
			})
		}
		await setAutomationExecutionOverride(loaded.caller.env.APP_DB, {
			orgId: loaded.caller.orgId,
			kind: target.kind,
			targetId: loaded.targetId,
			execution,
			userId: loaded.caller.userId,
		})
		return await describe(ctx, target)
	},
})
