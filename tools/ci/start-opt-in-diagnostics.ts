import { spawn } from 'node:child_process'
import { resolveLocalBinary } from '../node-runtime.ts'
const exceptionNames = new Set([
	'Error',
	'TypeError',
	'ReferenceError',
	'SyntaxError',
	'RangeError',
	'URIError',
	'EvalError',
	'AggregateError',
])
const envKeys = [
	'COOKIE_SECRET',
	'SECRET_STORE_KEY',
	'APP_DB',
	'BUNDLE_ARTIFACTS_KV',
	'AUTH_RATE_LIMITER',
	'STORAGE_RUNNER',
	'PACKAGE_REALTIME_SESSION',
	'MCP_CLIENT_HUB',
	'APP_BASE_URL',
	'SENTRY_DSN',
	'TURNSTILE_SITE_KEY',
	'TURNSTILE_SECRET_KEY',
]
const functionNames = new Set([
	'getEnv',
	'validateEnv',
	'handleRequest',
	'renderNativeDocument',
	'workerHandler',
	'fetch',
	'config',
	'createHealthHandler',
])
export function safeTailDiagnostic(event: unknown) {
	const value = event as {
		exceptions?: Array<{ name?: unknown; message?: unknown; stack?: unknown }>
		logs?: Array<{ message?: unknown }>
	}
	const exceptions = Array.isArray(value?.exceptions)
		? [...value.exceptions]
		: []
	const texts = [
		...exceptions.flatMap((error) =>
			typeof error.message === 'string' ? [error.message] : [],
		),
		...(Array.isArray(value?.logs)
			? value.logs.flatMap((log) =>
					Array.isArray(log.message)
						? log.message.filter(
								(message): message is string => typeof message === 'string',
							)
						: [],
				)
			: []),
	]
	for (const text of texts) {
		const name =
			/^(Error|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError):/.exec(
				text,
			)?.[1]
		if (name) exceptions.push({ name, stack: text })
	}
	const keys = envKeys.filter((key) =>
		texts.some(
			(text) =>
				(text.includes('Invalid environment variables:') ||
					text.startsWith('Missing AUTH_RATE_LIMITER binding:')) &&
				new RegExp(`\\b${key}(?::| binding:)`).test(text),
		),
	)
	const errors = exceptions.slice(0, 8).map((error) => ({
		name:
			typeof error.name === 'string' && exceptionNames.has(error.name)
				? error.name
				: 'OtherError',
		frames:
			typeof error.stack === 'string'
				? error.stack
						.split('\n')
						.flatMap((line) => {
							const match =
								/^\s*at (?:(\w+) \()?((?:index|http-entry|env|server)(?:-[A-Za-z0-9_-]{1,80})?\.[jt]s):(\d{1,7}):(\d{1,7})\)?$/.exec(
									line,
								)
							return match
								? [
										{
											function:
												match[1] && functionNames.has(match[1])
													? match[1]
													: 'other',
											file: match[2],
											line: Number(match[3]),
											column: Number(match[4]),
										},
									]
								: []
						})
						.slice(0, 8)
				: [],
	}))
	return { errors, environmentKeys: keys }
}
export function startPrivateCandidateTail(
	release: string,
	candidateName: string,
) {
	if (
		!/^[a-f0-9]{40}$/.test(release) ||
		candidateName !== `kody-start-${release}`
	)
		throw new Error('Tail must select exact inactive candidate')
	const env = Object.fromEntries(
		[
			'PATH',
			'HOME',
			'CI',
			'CLOUDFLARE_API_TOKEN',
			'CLOUDFLARE_ACCOUNT_ID',
		].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
	)
	const child = spawn(
		resolveLocalBinary('wrangler'),
		['tail', candidateName, '--format', 'json'],
		{ env, stdio: ['ignore', 'pipe', 'pipe'] },
	)
	let buffer = ''
	let emitted = 0
	child.stdout?.on('data', (chunk: Buffer) => {
		buffer += chunk.toString('utf8')
		if (buffer.length > 262144) {
			buffer = ''
			return
		}
		// Wrangler prints one complete JSON event per logger call, which may span chunks.
		const first = buffer.indexOf('{')
		if (first < 0) {
			buffer = ''
			return
		}
		buffer = buffer.slice(first)
		let depth = 0,
			quoted = false,
			escaped = false
		for (let i = 0; i < buffer.length; i++) {
			const character = buffer[i]
			if (quoted) {
				if (escaped) escaped = false
				else if (character === '\\') escaped = true
				else if (character === '"') quoted = false
				continue
			}
			if (character === '"') quoted = true
			else if (character === '{') depth++
			else if (character === '}' && --depth === 0) {
				try {
					const diagnostic = safeTailDiagnostic(
						JSON.parse(buffer.slice(0, i + 1)),
					)
					if (
						emitted < 20 &&
						(diagnostic.errors.length || diagnostic.environmentKeys.length)
					) {
						emitted++
						console.log(
							'Private candidate diagnostic:',
							JSON.stringify(diagnostic),
						)
					}
				} catch {
					/* Never print raw tail data. */
				}
				buffer = buffer.slice(i + 1)
				i = -1
			}
		}
	})
	child.stderr?.resume()
	child.on('error', () => console.log('Private candidate tail unavailable'))
	child.on('close', (code) => {
		if (code !== null && code !== 0)
			console.log('Private candidate tail unavailable')
	})
	return () => {
		buffer = ''
		child.kill('SIGTERM')
		setTimeout(() => child.kill('SIGKILL'), 1000).unref()
	}
}
