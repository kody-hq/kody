import {
	checkPermission,
	checkProfileChain,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { implicitUserSecretReadAccessKind } from '#mcp/secrets/package-access.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import type { ApiInvocationContext } from '#worker/open-api/context.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { maxAuditDetailChars } from './audit-detail.ts'
import { ExecutionContextError } from './errors.ts'
import {
	type MachineCapabilityRow,
	machineCapabilityUsePermission,
	shellCapabilityName,
	networkCapabilityName,
	ensureNetworkCapability,
} from './machine-capabilities.ts'
import { hasMachineAccessGrant } from './machine-access.ts'
import { packagesNotDeclaring, undeclaredNeedMessage } from './machine-needs.ts'
import type { ExecutionContextRunPackages } from './run-packages.ts'
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

export function machineCapabilityOffError(
	contextName: string,
	name: string,
	kind: 'command' | 'lan' | 'fs' = 'command',
) {
	return new ExecutionContextError({
		status: 403,
		code: 'machine_capability_off',
		message:
			kind === 'fs'
				? `${contextName} allows no host folder named "${name}". The machine's owner allows one on that machine with \`kody context policy allow <folder>\`; \`kody context policy show\` lists what it allows.`
				: kind === 'lan'
					? `${contextName} defines no local network destination named "${name}". The machine's owner defines one on that machine with \`kody context capability add lan <file.json>\`; \`kody context capability list\` shows what it defines.`
					: `${contextName} defines no command named "${name}". The machine's owner defines one on that machine with \`kody context capability add command <file.json>\`; \`kody context capability list\` shows what it defines.`,
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
	/** A command the machine defines by name. Absent for the shell. */
	capability?: unknown
	args?: unknown
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
	const capability = args.capability
	if (
		capability !== undefined &&
		(typeof capability !== 'string' || capability.length === 0)
	) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message:
				'kody.command.authorize capability must be the name of a command the machine defines.',
		})
	}
	const assertAccess = async () =>
		capability === undefined
			? { ...(await assertCommandAccess(ctx, principal)), capabilityId: null }
			: await assertNamedCapabilityAccess(ctx, principal, 'command', capability)
	if (lifecycle) {
		const { row } = await assertAccess()
		// Listing, reading and killing shell jobs follows the shell's own list.
		if (capability === undefined)
			await shellPackagesWouldBlock(ctx, principal, row)
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
	const { env, row, user, orgId, capabilityId } = await assertAccess()
	const wouldBlock =
		capability === undefined
			? await shellPackagesWouldBlock(ctx, principal, row)
			: []
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
			...(capabilityId ? { capability, capabilityId } : {}),
			...runPackagesAuditDetail(principal.packages),
			...(wouldBlock.length > 0
				? {
						wouldBlockPackageIds: wouldBlock.slice(0, maxAuditedEntryPackages),
					}
				: {}),
			...(cut ? { truncated: true as const } : {}),
		}),
	})
	return { ok: true as const, commandId: args.commandId }
}

/**
 * The shell's package rule. A list the operator set is enforced; the default
 * rule is only logged until existing machines are migrated.
 */
async function shellPackagesWouldBlock(
	ctx: ApiInvocationContext,
	principal: ContextRunPrincipal,
	row: { id: string; name: string },
) {
	const shell = await ctx.env.APP_DB.prepare(
		`SELECT * FROM machine_capabilities
		 WHERE context_id = ? AND kind = 'shell' AND name = ? AND removed_at IS NULL`,
	)
		.bind(row.id, shellCapabilityName)
		.first<MachineCapabilityRow>()
	const allowedPackages = shell ? parseAllowedPackages(shell) : []
	const entries = principal.packages?.entries ?? []
	const refused = principal.packages?.truncated
		? entries
		: await packagesNotAllowed(ctx, principal.packages, allowedPackages)
	if (allowedPackages.length === 0) return refused
	if (
		principal.packages?.truncated ||
		refused.length > 0 ||
		entries.length === 0
	) {
		const label = `the shell on ${row.name}`
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_package_not_allowed',
			message: principal.packages?.truncated
				? `This run loaded too many packages for Kody to check them against ${label}, so it is refused. Run it with fewer packages.`
				: entries.length === 0
					? `Code that is not a saved package may not use ${label}: it is limited to listed packages.${packagesSetHint}`
					: `This run loaded ${refused.length === 1 ? 'a package that is' : 'packages that are'} not allowed to use ${label}: ${refused.slice(0, maxAuditedEntryPackages).join(', ')}.${packagesSetHint}`,
			details: { capability: shellCapabilityName, packageIds: refused },
		})
	}
	return []
}

const maxLanHostChars = 64

/**
 * The daemon's hop before a run reaches a local network destination the
 * machine defines by name. The machine matches the address and port against
 * its own definition; Kody checks who and which packages, and records it.
 */
export async function authorizeContextLan(
	ctx: ApiInvocationContext,
	rawArgs: unknown,
) {
	const principal = ctx.principal
	if (principal.kind !== 'execution-context-run') {
		throw commandRequiresContextError()
	}
	const args = (rawArgs ?? {}) as {
		capability?: unknown
		host?: unknown
		port?: unknown
	}
	if (
		typeof args.capability !== 'string' ||
		args.capability.length === 0 ||
		typeof args.host !== 'string' ||
		args.host.length === 0 ||
		args.host.length > maxLanHostChars ||
		typeof args.port !== 'number' ||
		!Number.isInteger(args.port) ||
		args.port < 1 ||
		args.port > 65535
	) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message:
				'kody.lan.authorize needs the name of a local network destination the machine defines ("*" for the whole local network), the address and the port.',
		})
	}
	if (args.capability === networkCapabilityName) {
		return await authorizeWholeNetwork(ctx, principal, {
			host: args.host,
			port: args.port,
		})
	}
	const { env, row, user, orgId, capabilityId } =
		await assertNamedCapabilityAccess(ctx, principal, 'lan', args.capability)
	await sessionStub(env, row.id).recordAudit({
		event: 'lan_used',
		actor: { userId: user.userId, handle: user.username ?? null },
		orgId,
		detail: {
			runId: principal.runId,
			capability: args.capability,
			capabilityId,
			host: args.host,
			port: args.port,
			...runPackagesAuditDetail(principal.packages),
		},
	})
	return { ok: true as const }
}

/**
 * A run's use of the machine wide local network switch (`grant.egress`
 * public-and-lan). The switch predates machine capabilities, so anyone who can
 * run on the context passes and the default package rule is only logged; a
 * list the operator set is enforced.
 */
async function authorizeWholeNetwork(
	ctx: ApiInvocationContext,
	principal: ContextRunPrincipal,
	target: { host: string; port: number },
) {
	const { env, row, user, orgId } = await loadCommandContext(ctx, principal)
	const label = `the whole local network on ${row.name}`
	if (parseGrant(row).egress.mode !== 'public-and-lan') {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_off',
			message: `The local network is off on ${row.name}. Its owner turns it on from that machine with \`kody context grant lan on\`, or defines one destination with \`kody context capability add lan <file.json>\`.`,
		})
	}
	const access = await loadContextAccess(env.APP_DB, row, {
		userId: user.userId,
		orgId,
	})
	if (!access.usable) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_not_granted',
			message: `You are not granted ${label}.`,
		})
	}
	const find = () =>
		env.APP_DB.prepare(
			`SELECT * FROM machine_capabilities
			 WHERE context_id = ? AND kind = 'lan' AND name = ? AND removed_at IS NULL`,
		)
			.bind(row.id, networkCapabilityName)
			.first<MachineCapabilityRow>()
	let capability = await find()
	if (!capability) {
		await ensureNetworkCapability(env.APP_DB, row)
		capability = await find()
	}
	const allowedPackages = capability ? parseAllowedPackages(capability) : []
	const entries = principal.packages?.entries ?? []
	const refused = principal.packages?.truncated
		? entries
		: await packagesNotAllowed(ctx, principal.packages, allowedPackages)
	if (
		allowedPackages.length > 0 &&
		(principal.packages?.truncated ||
			refused.length > 0 ||
			entries.length === 0)
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_package_not_allowed',
			message: principal.packages?.truncated
				? `This run loaded too many packages for Kody to check them against ${label}, so it is refused. Run it with fewer packages.`
				: entries.length === 0
					? `Code that is not a saved package may not use ${label}: it is limited to listed packages.${packagesSetHint}`
					: `This run loaded ${refused.length === 1 ? 'a package that is' : 'packages that are'} not allowed to use ${label}: ${refused.slice(0, maxAuditedEntryPackages).join(', ')}.${packagesSetHint}`,
			details: { capability: networkCapabilityName, packageIds: refused },
		})
	}
	await sessionStub(env, row.id).recordAudit({
		event: 'lan_used',
		actor: { userId: user.userId, handle: user.username ?? null },
		orgId,
		detail: {
			runId: principal.runId,
			capability: networkCapabilityName,
			capabilityId: capability?.id ?? null,
			wholeNetwork: true,
			...(access.isOperator ? {} : { notOperator: true }),
			host: target.host,
			port: target.port,
			...runPackagesAuditDetail(principal.packages),
			...(refused.length > 0
				? { wouldBlockPackageIds: refused.slice(0, maxAuditedEntryPackages) }
				: {}),
		},
	})
	return { ok: true as const }
}

/**
 * The daemon's hop the first time a run touches a host folder the machine
 * allows. Folders predate machine capabilities, so this hop requires a live
 * `fs` row (otherwise `machine_capability_off`). The default package rule and
 * a missing `kody.machine` declaration are only logged
 * (`wouldBlockPackageIds`, `undeclaredPackageIds`); a non-empty list the
 * operator set is enforced. An empty list uses the default rule.
 */
export async function authorizeContextFolder(
	ctx: ApiInvocationContext,
	rawArgs: unknown,
) {
	const principal = ctx.principal
	if (principal.kind !== 'execution-context-run') {
		throw commandRequiresContextError()
	}
	const args = (rawArgs ?? {}) as { capability?: unknown }
	if (typeof args.capability !== 'string' || args.capability.length === 0) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message:
				'kody.fs.authorize needs the name of a host folder the machine allows.',
		})
	}
	const name = args.capability
	const { env, row, user, orgId } = await loadCommandContext(ctx, principal)
	const capability = await env.APP_DB.prepare(
		`SELECT * FROM machine_capabilities
		 WHERE context_id = ? AND kind = 'fs' AND name = ? AND removed_at IS NULL`,
	)
		.bind(row.id, name)
		.first<MachineCapabilityRow>()
	if (!capability) throw machineCapabilityOffError(row.name, name, 'fs')
	const label = `host folder "${name}" on ${row.name}`
	const access = await loadContextAccess(env.APP_DB, row, {
		userId: user.userId,
		orgId,
	})
	if (!access.isOperator) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_not_granted',
			message: `You are not granted ${label}. Host folders are only for the operator's own runs.`,
		})
	}
	const allowedPackages = parseAllowedPackages(capability)
	const entries = principal.packages?.entries ?? []
	const refused = principal.packages?.truncated
		? entries
		: await packagesNotAllowed(ctx, principal.packages, allowedPackages)
	if (
		allowedPackages.length > 0 &&
		(principal.packages?.truncated ||
			refused.length > 0 ||
			entries.length === 0)
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_package_not_allowed',
			message: principal.packages?.truncated
				? `This run loaded too many packages for Kody to check them against ${label}, so it is refused. Run it with fewer packages.`
				: entries.length === 0
					? `Code that is not a saved package may not use ${label}: it is limited to listed packages.${packagesSetHint}`
					: `This run loaded ${refused.length === 1 ? 'a package that is' : 'packages that are'} not allowed to use ${label}: ${refused.slice(0, maxAuditedEntryPackages).join(', ')}.${packagesSetHint}`,
			details: { capability: name, packageIds: refused },
		})
	}
	const undeclared = await packagesNotDeclaring({
		env,
		packageIds: entries,
		kind: 'fs',
		name,
	})
	await sessionStub(env, row.id).recordAudit({
		event: 'fs_used',
		actor: { userId: user.userId, handle: user.username ?? null },
		orgId,
		detail: {
			runId: principal.runId,
			capability: name,
			capabilityId: capability.id,
			...runPackagesAuditDetail(principal.packages),
			...(refused.length > 0
				? { wouldBlockPackageIds: refused.slice(0, maxAuditedEntryPackages) }
				: {}),
			...(undeclared.length > 0
				? {
						undeclaredPackageIds: undeclared
							.slice(0, maxAuditedEntryPackages)
							.map((entry) => entry.id),
					}
				: {}),
		},
	})
	return { ok: true as const }
}

type ContextRunPrincipal = Extract<
	ApiInvocationContext['principal'],
	{ kind: 'execution-context-run' }
>

/**
 * The run's entry packages that the package rule refuses (copies a
 * credential's `allowed_packages`): a non-empty list is enforced for every
 * entry package and for ad hoc code; an empty one passes ad hoc code and
 * packages the caller's org wrote or adopted. Checked against the packages
 * Kody served to the run, never against what the run says it is.
 */
async function packagesNotAllowed(
	ctx: ApiInvocationContext,
	packages: ExecutionContextRunPackages | undefined,
	allowedPackages: ReadonlyArray<string>,
) {
	const entries = packages?.entries ?? []
	if (allowedPackages.length > 0) {
		return entries.filter((id) => !allowedPackages.includes(id))
	}
	const userId = ownerIdFromCaller(ctx.callerContext)
	const kinds = await Promise.all(
		entries.map((packageId) =>
			implicitUserSecretReadAccessKind({ env: ctx.env, userId, packageId }),
		),
	)
	return entries.filter((_, index) => kinds[index] === null)
}

const packagesSetHint =
	" The machine's operator chooses the list with executionContextMachineAccessPackagesSet."

function parseAllowedPackages(row: MachineCapabilityRow) {
	try {
		const parsed: unknown = JSON.parse(row.allowed_packages_json)
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === 'string')
			: []
	} catch {
		return []
	}
}

/**
 * A named command (`machine_capability` of kind `command`): the machine
 * defines it, the operator may use it, and the run's packages pass the
 * package rule. It does not need the shell opt-in. Anyone else needs the
 * context shared with them and a grant on the capability.
 */
async function assertNamedCapabilityAccess(
	ctx: ApiInvocationContext,
	principal: ContextRunPrincipal,
	kind: 'command' | 'lan',
	name: string,
) {
	const { env, row, user, orgId } = await loadCommandContext(ctx, principal)
	const capability = await env.APP_DB.prepare(
		`SELECT * FROM machine_capabilities
		 WHERE context_id = ? AND kind = ? AND name = ? AND removed_at IS NULL`,
	)
		.bind(row.id, kind, name)
		.first<MachineCapabilityRow>()
	if (!capability) throw machineCapabilityOffError(row.name, name, kind)
	const label =
		kind === 'lan'
			? `local network destination "${name}" on ${row.name}`
			: `command "${name}" on ${row.name}`
	const things = kind === 'lan' ? 'local network destinations' : 'commands'
	const access = await loadContextAccess(env.APP_DB, row, {
		userId: user.userId,
		orgId,
	})
	if (
		!access.isOperator &&
		!(
			access.usable &&
			(await hasMachineAccessGrant(env.APP_DB, {
				capabilityId: capability.id,
				userId: user.userId,
				orgId,
			}))
		)
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_not_granted',
			message: `You are not granted ${label} (${machineCapabilityUsePermission}). The machine's operator can share it with you, a team you are on, or everyone in the org (executionContextMachineAccessGrant).`,
		})
	}
	const request = ctx.callerContext.request
	if (request?.credential.profileId) {
		const decision = checkProfileChain(
			await computeEffectivePermissions({ env, request }),
			machineCapabilityUsePermission,
			{
				type: 'machine_capability',
				id: capability.id,
				orgId: row.org_id as OwnerId,
				label,
			},
		)
		if (!decision.allowed) {
			throw new ExecutionContextError({
				status: 403,
				code: 'machine_capability_not_granted',
				message: `The profile this run acts as, or a parent profile, was not granted ${label} (${machineCapabilityUsePermission}).`,
			})
		}
	}
	if (
		Array.isArray(principal.scopes) &&
		!principal.scopes.includes(machineCapabilityUsePermission)
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_not_granted',
			message: `This run's credential (token scopes) does not include ${machineCapabilityUsePermission}, so it cannot use ${label}. Use a credential with that scope.`,
		})
	}
	const allowedPackages = parseAllowedPackages(capability)
	const refused = principal.packages?.truncated
		? (principal.packages.entries ?? [])
		: await packagesNotAllowed(ctx, principal.packages, allowedPackages)
	const adHocRefused =
		allowedPackages.length > 0 &&
		(principal.packages?.entries.length ?? 0) === 0
	if (principal.packages?.truncated || refused.length > 0 || adHocRefused) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_capability_package_not_allowed',
			message: principal.packages?.truncated
				? `This run loaded too many packages for Kody to check them against ${label}, so it is refused. Run it with fewer packages.`
				: adHocRefused
					? `Code that is not a saved package may not use ${label}: it is limited to listed packages.${packagesSetHint}`
					: `This run loaded ${refused.length === 1 ? 'a package that is' : 'packages that are'} not allowed to use ${label}: ${refused.slice(0, maxAuditedEntryPackages).join(', ')}. ${allowedPackages.length > 0 ? `It is limited to listed packages.${packagesSetHint}` : `A package from someone else can use the machine's ${things} once the machine's operator adopts it or lists it (executionContextMachineAccessPackagesSet).`}`,
			details: { capability: name, packageIds: refused },
		})
	}
	const undeclared = await packagesNotDeclaring({
		env,
		packageIds: principal.packages?.entries ?? [],
		kind,
		name,
	})
	if (undeclared.length > 0) {
		throw new ExecutionContextError({
			status: 403,
			code: 'machine_need_undeclared',
			message: undeclaredNeedMessage({
				packages: undeclared.slice(0, maxAuditedEntryPackages),
				kind,
				name,
				contextName: row.name,
			}),
			details: {
				capability: name,
				packageIds: undeclared.map((entry) => entry.id),
			},
		})
	}
	return { env, row, user, orgId, capabilityId: capability.id }
}

/** The run's context, usable (not revoked or paused), with the caller. */
async function loadCommandContext(
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
	if (row.paused_at) {
		throw new ExecutionContextError({
			status: 409,
			code: 'context_paused',
			message: `${row.name} is paused, so it runs no host commands. Resume it with \`kody daemon resume --context ${row.name}\` or executionContextResume.`,
		})
	}
	const user = ctx.callerContext.user
	const orgId = ctx.callerContext.orgBinding?.org.id ?? row.org_id
	return { env, row, user, orgId }
}

/** Grant on, caller has execution_context:command, and token scopes allow it. */
async function assertCommandAccess(
	ctx: ApiInvocationContext,
	principal: ContextRunPrincipal,
) {
	const { env, row, user, orgId } = await loadCommandContext(ctx, principal)
	if (parseGrant(row).commands?.enabled !== true)
		throw commandsOffError(row.name)
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
				message: `The profile this run acts as, or a parent profile, was not granted ${executionContextCommandPermission} on ${row.name}. The person it acts for can grant it under Agent profiles (/account/profiles) or with accessGrant (resource_type "execution_context", subject_type "profile", subject_id the profile id).`,
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
	capability?: string
	capabilityId?: string
	entryPackageIds?: Array<string>
	packageCount?: number
	/** Entry packages a shell package rule would refuse. Logged only. */
	wouldBlockPackageIds?: Array<string>
	truncated?: true
}

const maxAuditedEntryPackages = 8

/**
 * Which saved packages Kody served to the run that started the command.
 * Nothing for ad hoc code. Any package in the run may have made the call.
 */
function runPackagesAuditDetail(
	packages: ExecutionContextRunPackages | undefined,
) {
	if (!packages || packages.all.length === 0) return {}
	return {
		entryPackageIds: packages.entries.slice(0, maxAuditedEntryPackages),
		packageCount: packages.all.length,
	}
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
