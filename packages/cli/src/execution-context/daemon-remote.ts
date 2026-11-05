import { apiJson } from './client.js'
import { localContextId } from './service-commands.js'

/** Remote daemon management through the Open API (server-side pause, live control). */
export type RemoteDaemonInput = {
	sub: string
	args: Array<string>
	apiUrl: string
	org?: string
	fetchFn?: typeof fetch
	token: () => Promise<string>
	context?: string
	reason?: string
	cancelRuns?: boolean
	lines?: string
	json?: boolean
	write: (text: string) => void
}

const remoteOnly = new Set(['pause', 'resume', 'config'])
const remoteCapable = new Set(['status', 'restart', 'update', 'logs'])

/**
 * Pause, resume and config always go to Kody. Status, restart, update and
 * logs go to Kody with --remote, or when --context names a context that is
 * not registered on this machine.
 */
export function isRemoteDaemonCommand(input: {
	sub: string | undefined
	apiUrl: string
	context?: string
	remote?: boolean
}) {
	if (!input.sub) return false
	if (remoteOnly.has(input.sub)) return true
	if (!remoteCapable.has(input.sub)) return false
	if (input.remote) return true
	return Boolean(input.context && !localContextId(input.apiUrl, input.context))
}

export async function runRemoteDaemonCommand(input: RemoteDaemonInput) {
	const ref = input.context ?? localContextId(input.apiUrl)
	if (!ref) {
		throw new Error(
			'This machine has no registered execution context. Pass --context <name> to manage one on another machine.',
		)
	}
	const id = encodeURIComponent(ref)
	const call = async (method: string, path: string, body?: unknown) =>
		(await apiJson({
			apiUrl: input.apiUrl,
			token: await input.token(),
			...(input.org ? { org: input.org } : {}),
			...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
			method,
			path: `/v1/execution-contexts/${id}${path}`,
			...(body === undefined ? {} : { body }),
		})) as Record<string, unknown>
	const print = (result: Record<string, unknown>, text: string) => {
		input.write(
			input.json ? `${JSON.stringify(result, null, 2)}\n` : `${text}\n`,
		)
		return 0
	}
	const name = (result: Record<string, unknown>) =>
		typeof result.name === 'string' ? result.name : ref
	switch (input.sub) {
		case 'pause': {
			const result = await call('POST', '/pause', {
				...(input.reason ? { reason: input.reason } : {}),
				...(input.cancelRuns ? { cancel_runs: true } : {}),
			})
			return print(
				result,
				`${result.alreadyPaused ? 'Already paused' : 'Paused'}: ${name(result)}. ${String(result.note ?? '')}`.trim(),
			)
		}
		case 'resume': {
			const result = await call('POST', '/resume')
			return print(
				result,
				result.wasPaused
					? `Resumed ${name(result)}. Chains route runs to it again.`
					: `${name(result)} was not paused.`,
			)
		}
		case 'status': {
			const result = await call('GET', '/daemon')
			return print(result, formatRemoteStatus(result))
		}
		case 'restart': {
			const result = await call('POST', '/daemon/restart')
			return print(
				result,
				`Restarting the daemon on ${name(result)} after runs in flight finish. It reconnects in a few seconds.`,
			)
		}
		case 'update': {
			const result = await call('POST', '/daemon/update')
			return print(
				result,
				typeof result.message === 'string'
					? `${name(result)}: ${result.message}`
					: `Sent an update check to ${name(result)}.`,
			)
		}
		case 'logs': {
			const lines = input.lines ? Number(input.lines) : 100
			if (!Number.isInteger(lines) || lines < 1 || lines > 500)
				throw new Error('--lines must be a whole number from 1 to 500.')
			const result = await call('GET', `/daemon/logs?lines=${lines}`)
			const logLines = Array.isArray(result.lines) ? result.lines : []
			return print(result, logLines.join('\n'))
		}
		case 'config': {
			const [action, key, value] = input.args
			if (action === undefined || action === 'show') {
				const result = await call('PATCH', '/daemon/config', {})
				return print(
					result,
					`${name(result)}: max-concurrent ${String(result.maxConcurrent ?? 'unknown')}`,
				)
			}
			if (action === 'set' && key === 'max-concurrent') {
				const n = Number(value)
				if (!Number.isInteger(n) || n < 1 || n > 8)
					throw new Error('max-concurrent must be a whole number from 1 to 8.')
				const result = await call('PATCH', '/daemon/config', {
					max_concurrent: n,
				})
				return print(
					result,
					`${name(result)} now takes at most ${String(result.maxConcurrent)} run(s) at once (the daemon uses the lower of this and its own --max-concurrent).`,
				)
			}
			if (action === 'set' && key === 'auto-update') {
				if (value !== 'on' && value !== 'off')
					throw new Error('auto-update must be on or off.')
				const result = await call('PATCH', '/daemon/config', {
					auto_update: value,
				})
				return print(
					result,
					`Auto-update is ${value} on ${name(result)}'s machine.`,
				)
			}
			throw new Error(
				'Usage: kody daemon config [show | set max-concurrent <n> | set auto-update on|off] [--context <name>]',
			)
		}
		default:
			throw new Error(`Unknown remote daemon command ${input.sub}.`)
	}
}

export function formatRemoteStatus(result: Record<string, unknown>) {
	const paused = result.paused as {
		at?: string
		by?: string | null
		reason?: string | null
	} | null
	const daemon = result.daemon as Record<string, unknown> | null | undefined
	const lines = [`${String(result.name ?? result.id)}: ${String(result.state)}`]
	if (paused?.at) {
		lines.push(
			`  Paused ${paused.at}${paused.by ? ` by @${paused.by}` : ''}${paused.reason ? `: ${paused.reason}` : ''}. Resume with: kody daemon resume --context ${String(result.name ?? result.id)}`,
		)
	}
	if (!result.online && typeof result.lastSeenAt === 'string') {
		lines.push(`  Last seen ${result.lastSeenAt}`)
	}
	if (daemon) {
		lines.push(
			`  kody ${String(daemon.version)}, ${daemon.service ? `${String(daemon.service)} service` : 'terminal'}, auto-update ${String(daemon.autoUpdate)}, ${String(daemon.runs)}/${String(daemon.maxConcurrent)} run(s)${daemon.draining ? ', draining' : ''}`,
		)
	}
	return lines.join('\n')
}
