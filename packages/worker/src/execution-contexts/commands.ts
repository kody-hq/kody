import { type ApiInvocationContext } from '#worker/open-api/context.ts'
import { ExecutionContextError } from './errors.ts'
import {
	getExecutionContext,
	loadContextAccess,
	parseGrant,
	sessionStub,
} from './store.ts'

/**
 * Host commands (`kody.command.*`, ADR 0092). The daemon runs the process;
 * before it spawns one it asks Kody through the run-scoped capability proxy
 * (`kody.command.authorize`), so the grant and the machine opt-in are checked
 * server-side for the run's requester and every command lands in the
 * context's audit log. The daemon reports the end with a signed
 * `command.finished` frame because background jobs outlive the run lease.
 */
export const commandRuntimeName = 'command'
export const maxAuditedCommandChars = 2000

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

type AuthorizeArgs = {
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
	const envKeys = Array.isArray(args.envKeys)
		? args.envKeys
				.filter((key): key is string => typeof key === 'string')
				.slice(0, 64)
		: []
	await sessionStub(env, row.id).recordAudit({
		event: 'command_started',
		actor: { userId: user.userId, handle: user.username ?? null },
		orgId,
		detail: {
			commandId: args.commandId,
			runId: principal.runId,
			command: args.command.slice(0, maxAuditedCommandChars),
			cwd: typeof args.cwd === 'string' ? args.cwd.slice(0, 1024) : null,
			envKeys,
			background: args.background === true,
		},
	})
	return { ok: true as const, commandId: args.commandId }
}
