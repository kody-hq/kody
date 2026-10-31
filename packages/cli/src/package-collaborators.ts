/**
 * `kody package collaborators | grant | revoke`: thin wrappers for the
 * package-scoped Open API collaborator routes (`packageCollaboratorList`,
 * `packageCollaboratorSet`, `packageCollaboratorRemove`). They only add teams
 * and members of the org the request is bound to (`--org`).
 */

export const packageCollaboratorPresets = [
	'read',
	'use',
	'contribute',
	'manage',
] as const

export type PackageCollaboratorPreset =
	(typeof packageCollaboratorPresets)[number]

export type PackageCollaboratorAction = 'collaborators' | 'grant' | 'revoke'

export const packageCollaboratorActions: ReadonlyArray<PackageCollaboratorAction> =
	['collaborators', 'grant', 'revoke']

export function isPackageCollaboratorAction(
	value: string | undefined,
): value is PackageCollaboratorAction {
	return (
		packageCollaboratorActions as ReadonlyArray<string | undefined>
	).includes(value)
}

export const packageCollaboratorUsage = [
	'Usage: kody package collaborators <@owner/leaf|kody_id|package_id> [--org <slug>] [--json]',
	'       kody package grant <package> (--team <slug> | --user <username>) [--preset read|use|contribute|manage] [--org <slug>] [--json]',
	'       kody package revoke <package> (--team <slug> | --user <username> | --grant <grant_id>) [--org <slug>] [--json]',
].join('\n')

type Subject =
	| { kind: 'team'; slug: string }
	| { kind: 'user'; username: string }

export type PackageCollaboratorPlan =
	| { action: 'collaborators'; packageId: string }
	| {
			action: 'grant'
			packageId: string
			subject: Subject
			preset: PackageCollaboratorPreset
	  }
	| {
			action: 'revoke'
			packageId: string
			target: Subject | { kind: 'grant'; grantId: string }
	  }

type FlagValues = {
	team?: unknown
	user?: unknown
	preset?: unknown
	grant?: unknown
}

function readFlag(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`--${name} needs a value.\n${packageCollaboratorUsage}`)
	}
	return value.trim()
}

function readSubject(values: FlagValues, allowGrant: boolean) {
	const team = readFlag(values.team, 'team')
	const user = readFlag(values.user, 'user')
	const grant = allowGrant ? readFlag(values.grant, 'grant') : undefined
	const given = [team, user, grant].filter((value) => value !== undefined)
	if (given.length !== 1) {
		throw new Error(
			`Pass exactly one of ${allowGrant ? '--team, --user, or --grant' : '--team or --user'}.\n${packageCollaboratorUsage}`,
		)
	}
	if (team) return { kind: 'team' as const, slug: team.replace(/^@/, '') }
	if (user) return { kind: 'user' as const, username: user.replace(/^@/, '') }
	return { kind: 'grant' as const, grantId: grant! }
}

function readPreset(value: unknown): PackageCollaboratorPreset {
	const preset = readFlag(value, 'preset') ?? 'use'
	if (!(packageCollaboratorPresets as ReadonlyArray<string>).includes(preset)) {
		throw new Error(
			`--preset must be one of ${packageCollaboratorPresets.join(', ')}.`,
		)
	}
	return preset as PackageCollaboratorPreset
}

/** Parse `kody package <action> <package> [flags]` into one plan. */
export function parsePackageCollaboratorCommand(input: {
	action: PackageCollaboratorAction
	positionals: ReadonlyArray<string>
	values: FlagValues
}): PackageCollaboratorPlan {
	const packageId = input.positionals[0]?.trim()
	if (!packageId || input.positionals.length > 1) {
		throw new Error(packageCollaboratorUsage)
	}
	switch (input.action) {
		case 'collaborators':
			return { action: 'collaborators', packageId }
		case 'grant': {
			const subject = readSubject(input.values, false)
			if (subject.kind === 'grant') throw new Error(packageCollaboratorUsage)
			return {
				action: 'grant',
				packageId,
				subject,
				preset: readPreset(input.values.preset),
			}
		}
		case 'revoke':
			if (input.values.preset !== undefined) {
				throw new Error(
					`--preset is only for grant.\n${packageCollaboratorUsage}`,
				)
			}
			return {
				action: 'revoke',
				packageId,
				target: readSubject(input.values, true),
			}
		default: {
			const exhaustive: never = input.action
			throw new Error(`Unhandled package action: ${String(exhaustive)}`)
		}
	}
}

export type PackageCollaborator = {
	grant_id: string
	subject_type: 'user' | 'team'
	subject_id: string
	kind: 'team' | 'member' | 'outside'
	username: string | null
	display_name: string | null
	team_slug: string | null
	team_name: string | null
	preset: PackageCollaboratorPreset | null
	permissions: Array<string>
	created_at: string
}

type PackageSummary = { id: string; kody_id: string; name: string }

type CollaboratorList = {
	package: PackageSummary
	collaborators: Array<PackageCollaborator>
}

export type CallOperation = (
	operationId: string,
	params: Record<string, unknown>,
) => Promise<unknown>

function describeSubject(subject: Subject) {
	return subject.kind === 'team'
		? `team ${subject.slug}`
		: `@${subject.username}`
}

export function collaboratorLabel(collaborator: PackageCollaborator) {
	if (collaborator.subject_type === 'team') {
		return collaborator.team_slug
			? `${collaborator.team_slug}${collaborator.team_name ? ` (${collaborator.team_name})` : ''}`
			: collaborator.subject_id
	}
	if (!collaborator.username)
		return collaborator.display_name ?? collaborator.subject_id
	return collaborator.display_name
		? `@${collaborator.username} (${collaborator.display_name})`
		: `@${collaborator.username}`
}

function presetLabel(collaborator: PackageCollaborator) {
	return (
		collaborator.preset ??
		`custom (${collaborator.permissions.length} permissions)`
	)
}

/** Plain-text table for `kody package collaborators`. */
export function formatCollaboratorList(list: CollaboratorList): string {
	const header = `${list.package.name} (${list.package.id})`
	if (list.collaborators.length === 0) {
		return `${header}\nNo collaborators. Org owners always have full access.\n`
	}
	const rows = list.collaborators.map((collaborator) => [
		collaborator.kind,
		collaboratorLabel(collaborator),
		presetLabel(collaborator),
		collaborator.grant_id,
	])
	const widths = [0, 1, 2].map((column) =>
		Math.max(...rows.map((row) => row[column]!.length)),
	)
	const lines = rows.map((row) =>
		row
			.map((cell, column) => (column < 3 ? cell.padEnd(widths[column]!) : cell))
			.join('  '),
	)
	return `${header}\n${lines.join('\n')}\n`
}

function findCollaborator(list: CollaboratorList, subject: Subject) {
	const match = list.collaborators.find((collaborator) =>
		subject.kind === 'team'
			? collaborator.subject_type === 'team' &&
				collaborator.team_slug === subject.slug
			: collaborator.subject_type === 'user' &&
				collaborator.username?.toLowerCase() === subject.username.toLowerCase(),
	)
	if (!match) {
		throw new Error(
			`${describeSubject(subject)} is not a collaborator on ${list.package.name}.`,
		)
	}
	return match
}

/**
 * Run one plan through `call` (an Open API operation caller). Returns the
 * text to print: JSON when `json`, otherwise a short human summary.
 */
export async function runPackageCollaboratorPlan(input: {
	plan: PackageCollaboratorPlan
	call: CallOperation
	json: boolean
}): Promise<string> {
	const { plan, call, json } = input
	const print = (value: unknown, text: string) =>
		json ? `${JSON.stringify(value, null, 2)}\n` : text
	switch (plan.action) {
		case 'collaborators': {
			const list = (await call('packageCollaboratorList', {
				package_id: plan.packageId,
			})) as CollaboratorList
			return print(list, formatCollaboratorList(list))
		}
		case 'grant': {
			const result = (await call('packageCollaboratorSet', {
				package_id: plan.packageId,
				...(plan.subject.kind === 'team'
					? { team_slug: plan.subject.slug }
					: { username: plan.subject.username }),
				preset: plan.preset,
			})) as { package: PackageSummary; collaborator: PackageCollaborator }
			return print(
				result,
				`${collaboratorLabel(result.collaborator)} now has ${presetLabel(result.collaborator)} on ${result.package.name} (grant ${result.collaborator.grant_id}).\n`,
			)
		}
		case 'revoke': {
			const target = plan.target
			let grantId: string
			let label: string
			let packageName = plan.packageId
			if (target.kind === 'grant') {
				grantId = target.grantId
				label = `grant ${grantId}`
			} else {
				const list = (await call('packageCollaboratorList', {
					package_id: plan.packageId,
				})) as CollaboratorList
				const collaborator = findCollaborator(list, target)
				grantId = collaborator.grant_id
				label = collaboratorLabel(collaborator)
				packageName = list.package.name
			}
			const result = await call('packageCollaboratorRemove', {
				package_id: plan.packageId,
				grant_id: grantId,
			})
			return print(result, `Removed ${label} from ${packageName}.\n`)
		}
		default: {
			const exhaustive: never = plan
			throw new Error(`Unhandled package plan: ${JSON.stringify(exhaustive)}`)
		}
	}
}
