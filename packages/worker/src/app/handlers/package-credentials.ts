import { type loadPackageMappingScopeForViewer } from '#app/package-credentials-access.ts'
import {
	MappingWriteRefused,
	resolveMappingChanges,
	writeMappingChanges,
} from '#worker/credentials/package-credential-mapping-changes.ts'
import {
	buildPackageCredentialsView,
	loadPackageMappingScope,
} from '#worker/credentials/package-credential-mappings.ts'
import { getEnablementById } from '#worker/enablements/repo.ts'
import {
	disableEnablementForCaller,
	enableTriggerForCaller,
	planTriggerEnablementForCaller,
	runNewEnablementPlans,
	TriggerEnablementError,
} from '#worker/enablements/service.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import { operationResult } from '../operation-result.ts'
import { packageCredentialChangesSchema } from '#universal/credential-mutations.ts'
import {
	isInboundEmailApprovalTopic,
	type CredentialMappingChange,
	type PackageCredentialsEnablementAction,
	type PackageCredentialsWriteFailure,
} from '#universal/credential-contracts.ts'

async function requirePackageTriggerEnablement(input: {
	env: Env
	scope: NonNullable<
		Awaited<ReturnType<typeof loadPackageMappingScopeForViewer>>
	>
	enablementId: string
	trigger: PackageCredentialsEnablementAction['trigger']
}) {
	const actorId = input.scope.request.actor?.userId
	if (!actorId) {
		throw new TriggerEnablementError(
			'trigger_unknown',
			'Only a signed-in person can change trigger enablements.',
		)
	}
	const enablement = await getEnablementById({
		db: input.env.APP_DB,
		orgId: input.scope.savedPackage.userId,
		id: input.enablementId,
	})
	const notFound = new TriggerEnablementError(
		'trigger_unknown',
		`Enablement "${input.enablementId}" was not found for this package trigger.`,
	)
	if (!enablement) throw notFound
	if (enablement.packageId !== input.scope.savedPackage.id) throw notFound
	if (enablement.triggerKind !== input.trigger.kind) throw notFound
	if (enablement.triggerName !== input.trigger.name) throw notFound
	if (String(enablement.enablerUserId) !== String(actorId)) throw notFound
	return enablement
}

/** Reject malformed enablement actions before any mapping write runs. */
async function validateEnablementActions(input: {
	env: Env
	scope: NonNullable<
		Awaited<ReturnType<typeof loadPackageMappingScopeForViewer>>
	>
	actions: ReadonlyArray<PackageCredentialsEnablementAction>
}) {
	const actorId = input.scope.request.actor?.userId
	if (!actorId)
		throw new TriggerEnablementError(
			'trigger_unknown',
			'Only a signed-in person can change trigger enablements.',
		)
	for (const action of input.actions) {
		if (action.state === 'on') {
			const trigger = input.scope.triggers.find(
				(declared) =>
					declared.kind === action.trigger.kind &&
					declared.name === action.trigger.name &&
					(declared.kind !== 'webhook' ||
						!action.enablementId ||
						declared.enablements.some((row) => row.id === action.enablementId)),
			)
			if (!trigger)
				throw new TriggerEnablementError(
					'trigger_unknown',
					'This package does not declare that trigger.',
				)
			if (
				trigger.kind === 'subscription' &&
				isInboundEmailApprovalTopic(trigger.name)
			) {
				throw new TriggerEnablementError(
					'email_approval_required',
					'Inbound email requires sender-scoped approval from the package approval page.',
				)
			}
			if (action.createInstance && action.enablementId) {
				throw new TriggerEnablementError(
					'trigger_unknown',
					'A new instance cannot target an existing enablement id.',
				)
			}
			if (trigger.kind === 'webhook') {
				if (action.createInstance)
					throw new TriggerEnablementError(
						'webhook_other_enabler',
						'Each webhook URL runs as one enablement. Mint another URL for another instance.',
					)
				if (!trigger.instanceId)
					throw new TriggerEnablementError(
						'webhook_not_minted',
						'This webhook has no URL yet. Mint and approve it first.',
					)
				if (
					trigger.enablements.some(
						(row) => String(row.enablerUserId) !== String(actorId),
					)
				) {
					throw new TriggerEnablementError(
						'webhook_other_enabler',
						'This webhook is already on for another person.',
					)
				}
				if (
					!trigger.enablements.some(
						(row) => String(row.enablerUserId) === String(actorId),
					)
				) {
					throw new TriggerEnablementError(
						'webhook_approval_required',
						'A webhook requires approval before its first turn-on.',
					)
				}
			}
		}
		if (action.state === 'off') {
			if (!action.enablementId) {
				throw new TriggerEnablementError(
					'trigger_unknown',
					'Turning a trigger off needs its enablement id.',
				)
			}
			await requirePackageTriggerEnablement({
				env: input.env,
				scope: input.scope,
				enablementId: action.enablementId,
				trigger: action.trigger,
			})
			continue
		}
		if (action.enablementId && !action.createInstance) {
			const named = await requirePackageTriggerEnablement({
				env: input.env,
				scope: input.scope,
				enablementId: action.enablementId,
				trigger: action.trigger,
			})
			if (named.state === 'off') {
				throw new TriggerEnablementError(
					'trigger_unknown',
					`Enablement "${action.enablementId}" is off. Turn the trigger on without an enablement id to create another instance.`,
				)
			}
		}
	}
}

async function applyEnablementActions(input: {
	env: Env
	scope: NonNullable<
		Awaited<ReturnType<typeof loadPackageMappingScopeForViewer>>
	>
	actions: ReadonlyArray<PackageCredentialsEnablementAction>
}) {
	await validateEnablementActions(input)
	for (const action of input.actions) {
		if (action.state === 'off') {
			await disableEnablementForCaller({
				env: input.env,
				request: input.scope.request,
				enablementId: action.enablementId!,
			})
			continue
		}
		if (action.createInstance) {
			const plan = await planTriggerEnablementForCaller({
				env: input.env,
				baseUrl: input.scope.baseUrl,
				request: input.scope.request,
				savedPackage: input.scope.savedPackage,
				kind: action.trigger.kind,
				name: action.trigger.name,
				createInstance: true,
			})
			if (plan.enablement) continue
			await runNewEnablementPlans({
				db: input.env.APP_DB,
				plans: [plan],
			})
			continue
		}
		if (action.enablementId) {
			// Validated above: named live enablement already exists for the viewer.
			continue
		}
		await enableTriggerForCaller({
			env: input.env,
			baseUrl: input.scope.baseUrl,
			request: input.scope.request,
			packageIdOrKodyId: input.scope.savedPackage.id,
			kind: action.trigger.kind,
			name: action.trigger.name,
		})
	}
}

/** Session-scoped mapping and enablement writes, shared by native Start mutations. */
export async function mutatePackageCredentialMappings({
	scope,
	body,
}: {
	scope: NonNullable<
		Awaited<ReturnType<typeof loadPackageMappingScopeForViewer>>
	>
	body: unknown
}) {
	const env = scope.env
	const parsed = packageCredentialChangesSchema.safeParse(body)
	if (!parsed.success) {
		return operationResult(
			{
				ok: false,
				error: `Invalid request body: ${parsed.error.issues[0]?.message ?? 'expected { changes } and/or { enablements }'}.`,
			},
			400,
		)
	}
	const changes: Array<CredentialMappingChange> = parsed.data.changes ?? []
	const enablements = parsed.data.enablements ?? []
	if (changes.length > 0) {
		const resolved = await resolveMappingChanges(scope, changes)
		const errors = resolved.flatMap((change) =>
			change.error
				? [
						{
							needKey: change.needKey,
							target: change.target,
							...change.error,
						},
					]
				: [],
		)
		if (errors.length > 0) {
			return operationResult(
				{ ok: false, errors } satisfies PackageCredentialsWriteFailure,
				400,
			)
		}
		try {
			// Validate enablements before any mapping write so a bad off
			// action cannot leave a willEnable mapping half-applied.
			if (enablements.length > 0) {
				await validateEnablementActions({
					env,
					scope,
					actions: enablements,
				})
			}
			// Mapping writes before enablement mutations so a failed
			// mapping does not leave enablements half-applied.
			await writeMappingChanges(scope, resolved)
			if (enablements.length > 0) {
				await applyEnablementActions({ env, scope, actions: enablements })
			}
		} catch (error) {
			if (
				error instanceof MappingWriteRefused &&
				error.code !== 'webhook_other_enabler' &&
				error.code !== 'email_sender_conflict' &&
				error.change
			) {
				return operationResult(
					{
						ok: false,
						errors: [
							{
								needKey: error.change.needKey,
								target: error.change.target,
								code: error.code,
								message: error.message,
							},
						],
					} satisfies PackageCredentialsWriteFailure,
					400,
				)
			}
			if (error instanceof TriggerEnablementError) {
				const conflict =
					error.code === 'webhook_other_enabler' ||
					error.code === 'email_sender_conflict'
				return operationResult(
					{ ok: false, error: error.message },
					conflict ? 409 : 400,
				)
			}
			// A webhook or email sender someone else turned on between resolve and write.
			if (
				!(error instanceof MappingWriteRefused) &&
				!(isMcpCallerError(error) && error instanceof Error)
			) {
				throw error
			}
			return operationResult({ ok: false, error: error.message }, 409)
		}
	} else {
		try {
			await applyEnablementActions({ env, scope, actions: enablements })
		} catch (error) {
			if (error instanceof TriggerEnablementError) {
				const conflict =
					error.code === 'webhook_other_enabler' ||
					error.code === 'email_sender_conflict'
				return operationResult(
					{ ok: false, error: error.message },
					conflict ? 409 : 400,
				)
			}
			if (isMcpCallerError(error) && error instanceof Error) {
				return operationResult({ ok: false, error: error.message }, 409)
			}
			throw error
		}
	}
	const fresh = await loadPackageMappingScope({
		env,
		baseUrl: scope.baseUrl,
		request: scope.request,
		savedPackage: scope.savedPackage,
		canManage: scope.canManage,
	})
	return operationResult(await buildPackageCredentialsView(fresh))
}
