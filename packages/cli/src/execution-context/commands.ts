import { readdirSync, readFileSync } from 'node:fs'
import { cpus, platform, totalmem } from 'node:os'
import { ed25519JwkThumbprint } from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	apiJson,
	fetchServerKeys,
	generateContextKey,
	importContextKey,
	registerContext,
} from './client.js'
import { runDaemon } from './daemon.js'
import {
	contextWorkersDir,
	contextsDir,
	loadContext,
	resolveWrappingKey,
	saveContext,
} from './keystore.js'
import {
	createLocalWorkerTracker,
	reapLeftoverWorkers,
} from './worker-tracker.js'

export type ExecutionContextCommandInput = {
	command: 'context' | 'chain' | 'daemon'
	positionals: Array<string>
	values: { name?: string; context?: string; json?: boolean }
	apiUrl: string
	org?: string
	token: () => Promise<string>
	clientVersion: string
	write: (text: string) => void
	fetchFn?: typeof fetch
}

export function localCapabilities() {
	return {
		runtime: 'workerd',
		node: process.versions.node,
		os: platform(),
		cpuCount: cpus().length,
		memoryMb: Math.round(totalmem() / (1024 * 1024)),
		maxConcurrent: 1,
		features: [],
	}
}

function storedContextIds(apiUrl: string) {
	try {
		return readdirSync(contextsDir(apiUrl)).filter((entry) =>
			entry.startsWith('ec_'),
		)
	} catch {
		return []
	}
}

function out(
	input: ExecutionContextCommandInput,
	value: unknown,
	text: string,
) {
	input.write(
		input.values.json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`,
	)
}

export async function runExecutionContextCommand(
	input: ExecutionContextCommandInput,
): Promise<number> {
	const [sub, ...rest] = input.positionals
	const base = {
		apiUrl: input.apiUrl,
		...(input.org ? { org: input.org } : {}),
		...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
	}
	if (input.command === 'context' && sub === 'register') {
		const name = input.values.name ?? rest[0]
		if (!name) throw new Error('Pass --name <name> for this machine.')
		const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
		const privateKey = await importContextKey(privateKeyJwk)
		const thumbprint = await ed25519JwkThumbprint(publicKeyJwk)
		const registered = await registerContext({
			...base,
			token: await input.token(),
			name,
			publicKeyJwk,
			privateKey,
			thumbprint,
			capabilities: localCapabilities(),
			client: { name: 'kody-cli', version: input.clientVersion },
		})
		saveContext({
			context: {
				version: 1,
				ecid: registered.ecid,
				name: registered.name,
				apiUrl: input.apiUrl,
				orgSlug: registered.owner.orgSlug,
				publicKeyJwk,
			},
			privateJwk: privateKeyJwk,
			wrapping: resolveWrappingKey({ ecid: registered.ecid, create: true }),
		})
		const steps = (registered.nextSteps ?? [])
			.map(
				(step) => `  ${step.text ?? ''}${step.cli ? `\n    ${step.cli}` : ''}`,
			)
			.join('\n')
		out(
			input,
			registered,
			[
				registered.notice ??
					`Registered ${registered.name} (${registered.ecid}).`,
				steps ? `Next steps:\n${steps}` : '',
				'Start it with: kody daemon',
			]
				.filter(Boolean)
				.join('\n'),
		)
		return 0
	}
	if (input.command === 'context' && (sub === 'list' || sub === undefined)) {
		const body = await apiJson({
			...base,
			token: await input.token(),
			method: 'GET',
			path: '/v1/execution-contexts',
		})
		const contexts = (body.contexts ?? []) as Array<{
			id: string
			name: string
			status: string
			usable: boolean
			unusableReason?: string
		}>
		out(
			input,
			body,
			contexts.length === 0
				? 'No execution contexts yet. Register this machine with `kody context register --name <name>`.'
				: contexts
						.map(
							(c) =>
								`${c.name} (${c.id}) ${c.status}${c.usable ? '' : `, not usable: ${c.unusableReason}`}`,
						)
						.join('\n'),
		)
		return 0
	}
	if (input.command === 'chain') {
		const token = await input.token()
		const read = await apiJson({
			...base,
			token,
			method: 'GET',
			path: '/v1/execution-chain',
		})
		const current = chainOf(read)
		const contexts = async () =>
			contextsById(
				await apiJson({
					...base,
					token,
					method: 'GET',
					path: '/v1/execution-contexts',
				}),
			)
		// Names and status are display-only; never fail the chain command on them.
		const contextMetadata = async () => {
			if (input.values.json) return new Map<string, ContextSummary>()
			try {
				return await contexts()
			} catch {
				return new Map<string, ContextSummary>()
			}
		}
		if (sub === 'show' || sub === undefined) {
			out(input, read, describeChain(current, await contextMetadata()))
			return 0
		}
		if (sub !== 'add' && sub !== 'remove') {
			throw new Error('Usage: kody chain show | add <name> | remove <name>')
		}
		const ref = rest[0]
		if (!ref) throw new Error(`Pass the context name: kody chain ${sub} <name>`)
		const id = await resolveContextId({
			...base,
			token,
			ref,
		})
		const entries = (
			(current.entries ?? []) as Array<{ kind: string; id?: string }>
		)
			.map((entry) =>
				entry.kind === 'cloud'
					? { kind: 'cloud' }
					: { kind: 'context', id: entry.id },
			)
			.filter((entry) => !(entry.kind === 'context' && entry.id === id))
		if (sub === 'add') {
			// Kody cloud is always last; an empty chain starts as [context, cloud].
			if (entries.length === 0) entries.push({ kind: 'cloud' })
			const cloudAt = entries.findIndex((entry) => entry.kind === 'cloud')
			entries.splice(cloudAt === -1 ? entries.length : cloudAt, 0, {
				kind: 'context',
				id,
			})
		}
		const updated = await apiJson({
			...base,
			token,
			method: 'PUT',
			path: '/v1/execution-chain',
			body: {
				entries,
				strict: !entries.some((entry) => entry.kind === 'cloud'),
				ifMatch: current.updatedAt ?? null,
			},
		})
		out(
			input,
			updated,
			describeChain(chainOf(updated), await contextMetadata()),
		)
		return 0
	}
	if (input.command === 'daemon') {
		const ids = input.values.context
			? [input.values.context]
			: storedContextIds(input.apiUrl)
		const ecid = ids[0]
		if (!ecid) {
			throw new Error(
				'This machine has no registered execution context. Run `kody context register --name <name>` first.',
			)
		}
		const { context, privateJwk } = loadContext({
			apiUrl: input.apiUrl,
			ecid,
			wrapping: resolveWrappingKey({ ecid, create: false }),
		})
		const privateKey = await importContextKey(privateJwk)
		const serverKeys = await fetchServerKeys({ apiUrl: input.apiUrl })
		const { runContextRun } = await import('./run-executor.js')
		const abort = new AbortController()
		process.once('SIGINT', () => abort.abort())
		process.once('SIGTERM', () => abort.abort())
		input.write(
			`Starting ${context.name} (${context.ecid}) against ${input.apiUrl}.\n`,
		)
		const workersDir = contextWorkersDir(input.apiUrl, context.ecid)
		const reaped = reapLeftoverWorkers(workersDir)
		if (reaped.length > 0) {
			input.write(
				`Stopped ${reaped.length} local worker(s) left running by an earlier daemon for this context.\n`,
			)
		}
		const workerTracker = createLocalWorkerTracker(workersDir)
		try {
			await runDaemon({
				apiUrl: input.apiUrl,
				ecid: context.ecid,
				privateKey,
				serverKeys,
				maxConcurrent: 1,
				client: { name: 'kody-cli', version: input.clientVersion },
				capabilities: localCapabilities(),
				execute: (run) =>
					runContextRun({ ...run, apiUrl: input.apiUrl, workerTracker }),
				log: (line) => input.write(`${line}\n`),
				signal: abort.signal,
			})
		} finally {
			workerTracker.killAll()
			workerTracker.dispose()
		}
		return 0
	}
	throw new Error(
		'Usage: kody context register --name <name> [--org <slug>] | kody context list | kody chain show | add <name> | remove <name> | kody daemon [--context <ec id>]',
	)
}

async function resolveContextId(input: {
	apiUrl: string
	org?: string
	token: string
	ref: string
	fetchFn?: typeof fetch
}) {
	if (input.ref.startsWith('ec_')) return input.ref
	const body = await apiJson({
		...input,
		method: 'GET',
		path: '/v1/execution-contexts',
	})
	const match = (
		(body.contexts ?? []) as Array<{ id: string; name: string }>
	).find((c) => c.name === input.ref)
	if (!match)
		throw new Error(`No execution context named ${input.ref} in this org.`)
	return match.id
}

function chainOf(body: Record<string, unknown>) {
	return (body.chain ?? {}) as Record<string, unknown>
}

type ContextSummary = { id: string; name?: string | null; status?: string }

function contextsById(body: Record<string, unknown>) {
	const contexts = (body.contexts ?? []) as Array<ContextSummary>
	return new Map(contexts.map((context) => [context.id, context]))
}

function describeChain(
	chain: Record<string, unknown>,
	contexts: ReadonlyMap<string, ContextSummary> = new Map(),
) {
	const entries = (chain.entries ?? []) as Array<{
		kind: string
		id?: string
		name?: string | null
		usable?: boolean
		unusableReason?: string
	}>
	const lines = entries.map((entry, index) => {
		if (entry.kind === 'cloud') return `${index + 1}. Kody cloud (always last)`
		const known = entry.id ? contexts.get(entry.id) : undefined
		const name = entry.name ?? known?.name
		const label = name ? `${name} (${entry.id})` : String(entry.id)
		const offline =
			known?.status && known.status !== 'online' ? ` [${known.status}]` : ''
		const skipped =
			entry.usable === false ? ` (skipped: ${entry.unusableReason})` : ''
		return `${index + 1}. ${label}${offline}${skipped}`
	})
	if (chain.strict) lines.push('Strict: Kody cloud is not in this chain.')
	return lines.join('\n') || 'Empty chain.'
}

export function readCodeFile(path: string) {
	return readFileSync(path, 'utf8')
}
