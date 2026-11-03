/**
 * Events a running `kody dev` server reports: rebuilds, build and runtime
 * errors, and app logs. Humans get {@link formatDevEvent}; agents get the
 * same objects as NDJSON.
 */

import {
	formatBundleDiagnostic,
	type BundleDiagnostic,
} from '../local-bundle.js'
import { appLogMarker } from './dev-protocol.js'

export type DevRequestTag = { id: string; method: string; path: string }

type DevLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export type DevEvent =
	| { type: 'rebuild_start'; files: Array<string> }
	| { type: 'rebuild_ok'; ms: number; buildId: number; restarted: boolean }
	| {
			type: 'build_error'
			ms: number
			message: string
			file: string | null
			line: number | null
			col: number | null
			diagnostics: Array<BundleDiagnostic>
	  }
	| {
			type: 'runtime_error'
			message: string
			stack: string
			request: DevRequestTag | null
			/** Present when the error has a known, actionable cause. */
			fix?: string
	  }
	| {
			type: 'log'
			source: 'app' | 'workerd' | 'prebuild'
			level: DevLogLevel
			message: string
			request: DevRequestTag | null
	  }

const logLevels = new Set<DevLogLevel>([
	'log',
	'info',
	'warn',
	'error',
	'debug',
])

/** Parse one workerd stdout line; plain lines become untagged `log` events. */
export function parseWorkerdStdoutLine(
	line: string,
): Extract<DevEvent, { type: 'log' }> {
	if (line.startsWith(appLogMarker)) {
		try {
			const parsed = JSON.parse(line.slice(appLogMarker.length)) as {
				level?: unknown
				message?: unknown
				request?: unknown
			}
			const level =
				typeof parsed.level === 'string' &&
				logLevels.has(parsed.level as DevLogLevel)
					? (parsed.level as DevLogLevel)
					: 'log'
			return {
				type: 'log',
				source: 'app',
				level,
				message:
					typeof parsed.message === 'string'
						? parsed.message
						: String(parsed.message),
				request: readRequestTag(parsed.request),
			}
		} catch {}
	}
	return {
		type: 'log',
		source: 'app',
		level: 'log',
		message: line,
		request: null,
	}
}

function readRequestTag(value: unknown): DevRequestTag | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	if (typeof record.id !== 'string') return null
	return {
		id: record.id,
		method: typeof record.method === 'string' ? record.method : 'GET',
		path: typeof record.path === 'string' ? record.path : '/',
	}
}

/**
 * A fix line for runtime errors with a known cause, or undefined. esbuild's ESM
 * output turns a CommonJS `require()` of an external (a Node builtin) into a
 * shim that throws in Workers — hosted apps fail the same way.
 */
export function runtimeErrorFix(message: string): string | undefined {
	const dynamicRequire = /Dynamic require of "([^"]+)" is not supported/.exec(
		message,
	)
	if (dynamicRequire) {
		return (
			`A CommonJS dependency calls require("${dynamicRequire[1]}"), which an ESM Worker cannot run (hosted apps fail the same way). ` +
			'It likely resolved to its Node build: import the package’s Workers/edge entry (an exports subpath or condition like `edge`, `worker`, or `workerd`) or an ESM build instead.'
		)
	}
	return undefined
}

function formatRequestTag(request: DevRequestTag | null): string {
	return request
		? `[${request.method} ${request.path} #${request.id}]`
		: '[app]'
}

/** One human-readable block for terminals. */
export function formatDevEvent(event: DevEvent): {
	stream: 'stdout' | 'stderr'
	text: string
} {
	switch (event.type) {
		case 'rebuild_start':
			return {
				stream: 'stderr',
				text:
					event.files.length > 0
						? `Rebuilding (${event.files.join(', ')})…`
						: 'Building…',
			}
		case 'rebuild_ok':
			return {
				stream: 'stderr',
				text: event.restarted
					? `Ready in ${event.ms}ms (build ${event.buildId})`
					: `No bundle changes (${event.ms}ms)`,
			}
		case 'build_error':
			return {
				stream: 'stderr',
				text: `Build failed${event.diagnostics.length > 0 ? `:\n${event.diagnostics.map(formatBundleDiagnostic).join('\n')}` : `: ${event.message}`}\nThe last good build is paused until this is fixed; requests get the error page.`,
			}
		case 'runtime_error':
			return {
				stream: 'stderr',
				text: `${formatRequestTag(event.request)} Uncaught ${event.stack || event.message}${event.fix ? `\nfix: ${event.fix}` : ''}`,
			}
		case 'log': {
			const tag =
				event.source === 'app'
					? formatRequestTag(event.request)
					: `[${event.source}]`
			const level =
				event.level === 'log' || event.level === 'info'
					? ''
					: `${event.level}: `
			const stream =
				event.level === 'error' || event.level === 'warn' ? 'stderr' : 'stdout'
			return { stream, text: `${tag} ${level}${event.message}` }
		}
		default: {
			const exhaustive: never = event
			throw new Error(`Unhandled dev event: ${JSON.stringify(exhaustive)}`)
		}
	}
}
