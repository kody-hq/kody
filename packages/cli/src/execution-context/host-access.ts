import { apiJson } from './client.js'
import {
	type FsMode,
	canonicalHostPath,
	isAbsolute,
	isWithin,
	plainPath,
	readLocalPolicy,
	samePath,
} from './fs-access.js'
import { localContextId, storedContextIds } from './service-commands.js'

/**
 * Host access has two layers: this machine's local policy (`kody context
 * policy`, the machine owner's call) and the context's server grant (`kody
 * context grant`, changed through executionContextUpdate, which needs
 * Contribute or Manage on the context). A run gets only what both allow.
 */

type FsRule = { path: string; mode: FsMode }

export type HostAccessContext = {
	id: string
	name: string
	ownerOrg?: { slug?: string | null }
	grantSummary?: { fs: number; egress: { mode: string } }
	hostAccess?: {
		fs: Array<FsRule>
		egress: { mode: string; hosts?: Array<string> }
	}
}

type Api = {
	apiUrl: string
	org?: string
	fetchFn?: typeof fetch
	token: string
}

const grantUsage =
	'Usage: kody context grant [show] [--context <name>] | kody context grant allow <path> [--mode ro|rw] [--context <name>] | kody context grant remove <path> [--context <name>] | kody context grant lan on|off [--context <name>]'

function arg(value: string) {
	return /^[\w@%+=:,./\\-]+$/.test(value) ? value : JSON.stringify(value)
}

function overlaps(a: string, b: string) {
	return isWithin(a, b) || isWithin(b, a)
}

function contextPageUrl(apiUrl: string, context: HostAccessContext) {
	const slug = context.ownerOrg?.slug
	return slug
		? `${apiUrl.replace(/\/+$/, '')}/@${slug}/-/execution-contexts/${context.id}`
		: null
}

export function lanState(mode: string) {
	return mode === 'public-and-lan'
		? 'on'
		: mode === 'allowlist'
			? 'allowlist only'
			: 'off'
}

/** One line per mismatch between this machine's policy and a context's grant. */
export function hostAccessNotes(
	context: HostAccessContext,
	policyFs: ReadonlyArray<FsRule>,
): Array<string> {
	const name = arg(context.name)
	const grantFs = context.hostAccess?.fs
	if (!grantFs) {
		const count = context.grantSummary?.fs
		if (count === undefined) return []
		if (policyFs.length > 0 && count === 0) {
			return [
				`This machine's local policy allows host folders, but ${context.name}'s server grant lists none (grant.fs: 0), so runs cannot use them. Someone with Contribute or Manage on ${context.name} can turn it on with: kody context grant allow <folder> --mode ro|rw --context ${name}`,
			]
		}
		if (policyFs.length === 0 && count > 0) {
			return [
				`${context.name}'s server grant lists host folders, but this machine's local policy allows none, so runs cannot use them. The machine owner can allow one with: kody context policy allow <folder> --mode ro|rw`,
			]
		}
		return []
	}
	const notes: Array<string> = []
	for (const rule of policyFs) {
		if (grantFs.some((entry) => overlaps(entry.path, rule.path))) continue
		notes.push(
			`${rule.path} (local policy ${rule.mode}) is not in ${context.name}'s server grant, so runs cannot use it. Turn it on with: kody context grant allow ${arg(rule.path)} --mode ${rule.mode} --context ${name}`,
		)
	}
	for (const entry of grantFs) {
		if (policyFs.some((rule) => overlaps(entry.path, rule.path))) continue
		notes.push(
			`${entry.path} (server grant ${entry.mode}) is not allowed by this machine's local policy, so runs cannot use it. The machine owner can allow it with: kody context policy allow ${arg(entry.path)} --mode ${entry.mode}`,
		)
	}
	return notes
}

function describeServerGrant(apiUrl: string, context: HostAccessContext) {
	const fs = context.hostAccess?.fs
	const egress =
		context.hostAccess?.egress.mode ?? context.grantSummary?.egress.mode
	const page = contextPageUrl(apiUrl, context)
	return [
		`Server grant for ${context.name} (Kody's side; changing it needs Contribute or Manage on the context):`,
		fs
			? fs.length === 0
				? '  Host folders (grant.fs): none'
				: [
						'  Host folders (grant.fs):',
						...fs.map((entry) => `    ${entry.mode}  ${entry.path}`),
					].join('\n')
			: `  Host folders (grant.fs): ${context.grantSummary?.fs ?? 0}`,
		...(egress
			? [`  Local network (grant.egress ${egress}): ${lanState(egress)}`]
			: []),
		...(page ? [`  Page: ${page}`] : []),
	].join('\n')
}

async function getContext(api: Api, id: string) {
	const body = await apiJson({
		...api,
		method: 'GET',
		path: `/v1/execution-contexts/${encodeURIComponent(id)}`,
	})
	return body.context as HostAccessContext
}

async function resolveId(api: Api, ref: string) {
	if (ref.startsWith('ec_')) return ref
	const body = await apiJson({
		...api,
		method: 'GET',
		path: '/v1/execution-contexts',
	})
	const match = (
		(body.contexts ?? []) as Array<{ id: string; name: string }>
	).find((c) => c.name === ref)
	if (!match) throw new Error(`No execution context named ${ref} in this org.`)
	return match.id
}

/**
 * Cross-layer notes for the contexts stored on this machine. Never changes
 * the server grant: `policy allow` stays a local-only action.
 */
export async function machineGrantNotes(input: {
	apiUrl: string
	org?: string
	fetchFn?: typeof fetch
	token: () => Promise<string>
	policyFs: ReadonlyArray<FsRule>
}) {
	const ids = storedContextIds(input.apiUrl)
	if (ids.length === 0) return []
	let token: string
	try {
		token = await input.token()
	} catch (error) {
		return [
			{
				id: null,
				name: null,
				notes: [],
				error: `Could not check the server grant (grant.fs) for this machine's contexts: ${firstLine(error)}`,
			},
		]
	}
	return await Promise.all(
		ids.map(async (id) => {
			try {
				const context = await getContext({ ...input, token }, id)
				return {
					id,
					name: context.name,
					notes: hostAccessNotes(context, input.policyFs),
				}
			} catch (error) {
				return {
					id,
					name: null,
					notes: [],
					error: `Could not check the server grant for ${id}: ${firstLine(error)}`,
				}
			}
		}),
	)
}

export function describeMachineGrantNotes(
	results: Awaited<ReturnType<typeof machineGrantNotes>>,
) {
	if (results.length === 0) return ''
	const lines = results.flatMap((result) =>
		'error' in result && result.error
			? [`  ${result.error}`]
			: result.notes.length === 0
				? [`  ${result.name}: server grant and local policy agree.`]
				: result.notes.map((note) => `  ${note}`),
	)
	return `\nServer grant check (a run can use a folder only if both layers allow it):\n${lines.join('\n')}`
}

function firstLine(error: unknown) {
	return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}

/**
 * `kody context grant`: changes a context's server grant through the same
 * `PATCH /v1/execution-contexts/{id}` (executionContextUpdate) checks as the
 * API: Contribute or Manage on the context, nothing looser.
 */
export async function runGrantCommand(input: {
	positionals: Array<string>
	values: { context?: string; mode?: string; json?: boolean }
	apiUrl: string
	org?: string
	fetchFn?: typeof fetch
	token: () => Promise<string>
	write: (text: string) => void
}): Promise<number> {
	const [action = 'show', target, ...extra] = input.positionals
	const valid =
		(action === 'show' && target === undefined) ||
		((action === 'allow' || action === 'remove') && target !== undefined) ||
		(action === 'lan' && (target === 'on' || target === 'off'))
	if (!valid || extra.length > 0) throw new Error(grantUsage)
	const ref = input.values.context ?? localContextId(input.apiUrl)
	if (!ref) {
		throw new Error(
			`No execution context is registered on this machine; pass --context <name>.\n${grantUsage}`,
		)
	}
	const api: Api = {
		apiUrl: input.apiUrl,
		...(input.org ? { org: input.org } : {}),
		...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
		token: await input.token(),
	}
	const onThisMachine = localContextId(input.apiUrl, ref)
	const id = onThisMachine ?? (await resolveId(api, ref))
	let context = await getContext(api, id)
	const emit = async (summary: string | null) => {
		const policy = onThisMachine ? await readLocalPolicy() : null
		const notes = policy ? hostAccessNotes(context, policy.fs) : []
		const text = [
			...(summary ? [summary] : []),
			describeServerGrant(input.apiUrl, context),
			...(notes.length > 0
				? [
						'This machine (a run can use a folder only if both layers allow it):',
						...notes.map((note) => `  ${note}`),
					]
				: []),
		].join('\n')
		input.write(
			input.values.json
				? `${JSON.stringify({ context, ...(policy ? { localPolicy: policy.fs, notes } : {}) }, null, 2)}\n`
				: `${text}\n`,
		)
		return 0
	}
	if (action === 'show') return await emit(null)
	const access = context.hostAccess
	if (!access) {
		throw new Error(
			`Changing ${context.name}'s server grant needs Contribute or Manage on it (the same check as executionContextUpdate). Ask its operator or someone who manages it${contextPageUrl(input.apiUrl, context) ? `: ${contextPageUrl(input.apiUrl, context)}` : '.'}`,
		)
	}
	const patch = async (grant: Record<string, unknown>) => {
		const body = await apiJson({
			...api,
			method: 'PATCH',
			path: `/v1/execution-contexts/${encodeURIComponent(id)}`,
			body: { grant },
		})
		context = (body.context as HostAccessContext | undefined) ?? context
	}
	if (action === 'lan') {
		const mode = access.egress.mode
		if (target === 'on') {
			if (mode === 'public-and-lan') {
				return await emit(
					`The local network is already on for ${context.name}.`,
				)
			}
			if (mode !== 'public') {
				throw new Error(
					`${context.name}'s egress is ${mode}, not public. \`kody context grant lan on\` only switches public to public-and-lan; change a ${mode} egress with executionContextUpdate grant.egress or on the context page.`,
				)
			}
			await patch({ egress: { mode: 'public-and-lan' } })
			return await emit(
				`Turned the local network on in ${context.name}'s server grant (grant.egress public-and-lan).`,
			)
		}
		if (mode !== 'public-and-lan') {
			return await emit(`The local network is already off for ${context.name}.`)
		}
		await patch({ egress: { mode: 'public' } })
		return await emit(
			`Turned the local network off in ${context.name}'s server grant (grant.egress public).`,
		)
	}
	const raw = plainPath(target!)
	if (!isAbsolute(raw)) throw new Error(`${target} is not an absolute path.`)
	// On the machine itself, store the path the daemon compares against.
	const path = onThisMachine
		? await canonicalHostPath(raw).catch((error) => {
				if (action === 'remove') return raw
				throw error
			})
		: raw
	const rest = access.fs.filter((entry) => !samePath(entry.path, path))
	if (action === 'remove') {
		if (rest.length === access.fs.length) {
			return await emit(`${path} was not in ${context.name}'s server grant.`)
		}
		await patch({ fs: rest })
		return await emit(`Removed ${path} from ${context.name}'s server grant.`)
	}
	const mode = input.values.mode ?? 'ro'
	if (mode !== 'ro' && mode !== 'rw') {
		throw new Error('--mode must be ro (read-only) or rw (read-write).')
	}
	const fs = [...rest, { path, mode }].sort((a, b) =>
		a.path.localeCompare(b.path),
	)
	await patch({ fs })
	return await emit(
		`Added ${path} (${mode}) to ${context.name}'s server grant. Running daemons pick this up right away.`,
	)
}
