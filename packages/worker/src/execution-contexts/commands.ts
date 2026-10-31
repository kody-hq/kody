import {
	checkPermission,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { type ApiInvocationContext } from '#worker/open-api/context.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { maxAuditDetailChars } from './audit-detail.ts'
import { ExecutionContextError } from './errors.ts'
import {
	executionContextCommandPermission,
	getExecutionContext,
	loadContextAccess,
	parseGrant,
	sessionStub,
} from './store.ts'

/**
 * Host commands (`kody.command.*`, ADR 0093). The daemon runs the process;
 * before it spawns one it asks Kody through the run-scoped capability proxy
 * (`kody.command.authorize`), so the grant and the machine opt-in are checked
 * server-side for the run's requester and every command lands in the
 * context's audit log. The daemon reports the end with a signed
 * `command.finished` frame because background jobs outlive the run lease.
 */
export const commandRuntimeName = 'command'
export const maxAuditedCommandChars = 1000

export function commandRequiresContextError() {
	return new ExecutionContextError({
		status: 400,
		code: 'execution_context_command_requires_context',
		message:
			'kody.command.* runs shell commands on an execution context (a machine running `kody daemon` or the Kody desktop app). This run is not on one: it ran in Kody cloud or with `kody execute --local`, which cannot run host commands. Route the run to a context (executionContext) whose machine has commands turned on.',
	})
}

export function commandsOffError(contextName: string) {
	return new ExecutionContextError({
		status: 403,
		code: 'execution_context_commands_off',
		message: `Host commands are off on ${contextName}: the machine has not opted in. Its owner turns them on from that machine with \`kody context commands on\` or the Kody desktop app (Machine > Allow commands).`,
	})
}

export function commandNotGrantedError(contextName: string) {
	return new ExecutionContextError({
		status: 403,
		code: 'execution_context_command_not_granted',
		message: `You are not granted host commands on ${contextName} (execution_context:command). The machine allows commands, but only its operator and people it is explicitly shared with "commands" may run them.`,
	})
}

const lifecycleCalls = new Set(['status', 'output', 'kill', 'list'])

type AuthorizeArgs = {
	lifecycle?: unknown
	commandId?: unknown
	command?: unknown
	cwd?: unknown
	envKeys?: unknown
	background?: unknown
}

export async function authorizeContextCommand(
	ctx: ApiInvocationContext,
	rawArgs: unknown,
) {
	const principal = ctx.principal
	if (principal.kind !== 'execution-context-run') {
		throw commandRequiresContextError()
	}
	const args = (rawArgs ?? {}) as AuthorizeArgs
	const lifecycle =
		typeof args.lifecycle === 'string' && lifecycleCalls.has(args.lifecycle)
			? args.lifecycle
			: null
	if (args.lifecycle !== undefined && !lifecycle) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message:
				'kody.command.authorize lifecycle must be status, output, kill or list.',
		})
	}
	if (lifecycle) {
		await assertCommandAccess(ctx, principal)
		return { ok: true as const }
	}
	if (
		typeof args.commandId !== 'string' ||
		!/^cmd_[\w-]{6,64}$/.test(args.commandId)
	) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: 'kody.command.authorize needs a commandId (cmd_…).',
		})
	}
	if (typeof args.command !== 'string' || args.command.length === 0) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: 'kody.command.authorize needs the command text.',
		})
	}
	const { env, row, user, orgId } = await assertCommandAccess(ctx, principal)
	const rawEnvKeys = Array.isArray(args.envKeys)
		? args.envKeys.filter((key): key is string => typeof key === 'string')
		: []
	const envKeys = rawEnvKeys.slice(0, 64).map((key) => key.slice(0, 128))
	const rawCwd = typeof args.cwd === 'string' ? args.cwd : null
	const cut =
		args.command.length > maxAuditedCommandChars ||
		(rawCwd?.length ?? 0) > 512 ||
		rawEnvKeys.length > 64 ||
		rawEnvKeys.some((key) => key.length > 128)
	await sessionStub(env, row.id).recordAudit({
		event: 'command_started',
		actor: { userId: user.userId, handle: user.username ?? null },
		orgId,
		detail: fitAuditDetail({
			commandId: args.commandId,
			runId: principal.runId,
			command: args.command.slice(0, maxAuditedCommandChars),
			cwd: rawCwd ? rawCwd.slice(0, 512) : null,
			envKeys,
			background: args.background === true,
			...(cut ? { truncated: true as const } : {}),
		}),
	})
	return { ok: true as const, commandId: args.commandId }
}

type ContextRunPrincipal = Extract<
	ApiInvocationContext['principal'],
	{ kind: 'execution-context-run' }
>

/** Grant on, caller has execution_context:command, and token scopes allow it. */
async function assertCommandAccess(
	ctx: ApiInvocationContext,
	principal: ContextRunPrincipal,
) {
	const env = ctx.env
	const row = await getExecutionContext(env.APP_DB, principal.ecid)
	if (!row || row.revoked_at) {
		throw new ExecutionContextError({
			status: 403,
			code: 'context_revoked',
			message: 'This execution context was revoked.',
		})
	}
	if (parseGrant(row).commands?.enabled !== true)
		throw commandsOffError(row.name)
	const user = ctx.callerContext.user
	const orgId = ctx.callerContext.orgBinding?.org.id ?? row.org_id
	const access = await loadContextAccess(env.APP_DB, row, {
		userId: user.userId,
		orgId,
	})
	if (!access.canRunCommands) throw commandNotGrantedError(row.name)
	const request = ctx.callerContext.request
	if (request?.credential.profileId) {
		const profileAccess = await computeEffectivePermissions({ env, request })
		const decision = checkPermission(
			profileAccess,
			executionContextCommandPermission,
			{ type: 'execution_context', id: row.id, orgId: row.org_id as OwnerId },
		)
		if (!decision.allowed) {
			throw new ExecutionContextError({
				status: 403,
				code: 'execution_context_command_not_granted',
				message: `The profile this run acts as, or a parent profile, was not granted ${executionContextCommandPermission} on ${row.name}. The person it acts for can grant it (accessGrant with subject_type "profile").`,
			})
		}
	}
	if (
		Array.isArray(principal.scopes) &&
		!principal.scopes.includes(executionContextCommandPermission)
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'execution_context_command_not_granted',
			message: `This run's credential (token scopes) does not include ${executionContextCommandPermission}, so it cannot run host commands on ${row.name}. Use a credential with that scope.`,
		})
	}
	return { env, row, user, orgId }
}

type CommandStartedDetail = {
	commandId: string
	runId: string | null | undefined
	command: string
	cwd: string | null
	envKeys: Array<string>
	background: boolean
	truncated?: true
}

/** Shrinks the detail so its JSON never hits the audit store's cut (which would leave invalid JSON). */
export function fitAuditDetail(detail: CommandStartedDetail) {
	let fitted = detail
	const size = () => JSON.stringify(fitted).length
	while (size() > maxAuditDetailChars && fitted.envKeys.length > 0) {
		fitted = {
			...fitted,
			envKeys: fitted.envKeys.slice(0, -1),
			truncated: true,
		}
	}
	while (size() > maxAuditDetailChars && fitted.cwd && fitted.cwd.length > 0) {
		const over = size() - maxAuditDetailChars
		fitted = {
			...fitted,
			cwd: fitted.cwd!.slice(0, Math.max(0, fitted.cwd!.length - over - 1)),
			truncated: true,
		}
	}
	while (size() > maxAuditDetailChars && fitted.command.length > 0) {
		const over = size() - maxAuditDetailChars
		fitted = {
			...fitted,
			command: fitted.command.slice(
				0,
				Math.max(0, fitted.command.length - Math.max(1, Math.ceil(over / 6))),
			),
			truncated: true,
		}
	}
	return fitted
}
