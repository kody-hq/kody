/**
 * `kody secret get` and `kody run` (ADR 0097): read secrets whose local reads
 * a person turned on, then print them or hand them to one child process.
 * Values are never logged; an interactive terminal needs `--reveal`.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { openApiRequest, type OpenApiClientInput } from './open-api-client.js'

export const localReadOperationPath = 'v1/secrets/local-read'

export type LocalSecretFormat = 'raw' | 'env' | 'json'

export type LocalSecret = { name: string; value: string }

/** `databaseUrl` becomes `DATABASE_URL`; `secret/doppler:API_KEY` becomes `API_KEY`. */
export function envNameForSecret(name: string): string {
	const provider = /^secret\/[^:]+:(.+)$/.exec(name.trim())
	const base = provider ? ((provider[1] ?? '').split('/').pop() ?? '') : name
	const snake = base
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
		.replace(/[^A-Za-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toUpperCase()
	if (!snake) {
		throw new Error(
			`Cannot pick an environment variable name for "${name}". Use --secret ${name}=NAME.`,
		)
	}
	return /^[0-9]/.test(snake) ? `_${snake}` : snake
}

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `--secret databaseUrl` or `--secret databaseUrl=PG_URL`. */
export function parseRunSecretFlags(
	flags: ReadonlyArray<string>,
): Array<{ name: string; envName: string }> {
	const seen = new Set<string>()
	return flags.map((flag) => {
		const at = flag.lastIndexOf('=')
		const name = (at > 0 ? flag.slice(0, at) : flag).trim()
		const envName = at > 0 ? flag.slice(at + 1).trim() : envNameForSecret(name)
		if (!name) throw new Error('--secret needs a secret name.')
		if (!envNamePattern.test(envName)) {
			throw new Error(
				`"${envName}" is not a valid environment variable name. Use letters, digits, and underscores.`,
			)
		}
		if (seen.has(envName)) {
			throw new Error(`Two secrets would both set ${envName}.`)
		}
		seen.add(envName)
		return { name, envName }
	})
}

export function parseSecretFormat(value: unknown): LocalSecretFormat {
	if (value === undefined) return 'raw'
	if (value === 'raw' || value === 'env' || value === 'json') return value
	throw new Error('--format must be raw, env, or json.')
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`
}

export function formatLocalSecrets(
	secrets: ReadonlyArray<LocalSecret>,
	format: LocalSecretFormat,
): string {
	switch (format) {
		case 'raw': {
			if (secrets.length !== 1) {
				throw new Error(
					'Raw output prints one secret. Use --format env or --format json for more.',
				)
			}
			return secrets[0]?.value ?? ''
		}
		case 'env':
			return `${secrets
				.map(
					(secret) =>
						`${envNameForSecret(secret.name)}=${shellQuote(secret.value)}`,
				)
				.join('\n')}\n`
		case 'json':
			return `${JSON.stringify(
				Object.fromEntries(
					secrets.map((secret) => [secret.name, secret.value]),
				),
			)}\n`
	}
}

/** Reads every name or none; a refusal throws the server's plain message. */
export async function fetchLocalSecrets(
	input: OpenApiClientInput & {
		names: ReadonlyArray<string>
		command: 'run' | 'get'
	},
): Promise<Array<LocalSecret>> {
	const result = await openApiRequest({
		...input,
		method: 'POST',
		path: localReadOperationPath,
		body: { names: [...input.names], command: input.command },
	})
	const secrets =
		result && typeof result === 'object' && 'secrets' in result
			? (result as { secrets: unknown }).secrets
			: null
	if (
		!Array.isArray(secrets) ||
		!secrets.every(
			(entry) =>
				entry &&
				typeof entry === 'object' &&
				typeof (entry as LocalSecret).name === 'string' &&
				typeof (entry as LocalSecret).value === 'string',
		)
	) {
		throw new Error('Kody returned no secrets.')
	}
	return secrets as Array<LocalSecret>
}

export const revealRequiredMessage =
	'Refusing to print secret values to a terminal. Pipe the output, pass --reveal to show them here, or use kody run to hand them to a program.'

export type SpawnFn = (
	command: string,
	args: ReadonlyArray<string>,
	options: SpawnOptions,
) => ReturnType<typeof nodeSpawn>

/**
 * Runs `argv` with the secrets added to its environment. Returns its exit
 * code; a child killed by a signal returns 128 plus the signal number.
 */
export async function runWithSecrets(input: {
	argv: ReadonlyArray<string>
	env: Record<string, string>
	spawnFn?: SpawnFn
	baseEnv?: NodeJS.ProcessEnv
}): Promise<number> {
	const [command, ...args] = input.argv
	if (!command) throw new Error('kody run needs a command after --.')
	const spawnFn = input.spawnFn ?? nodeSpawn
	const child = spawnFn(command, args, {
		stdio: 'inherit',
		env: { ...(input.baseEnv ?? process.env), ...input.env },
	})
	const signals: Array<NodeJS.Signals> = ['SIGINT', 'SIGTERM', 'SIGHUP']
	const forward = (signal: NodeJS.Signals) => {
		child.kill(signal)
	}
	for (const signal of signals) process.on(signal, forward)
	try {
		return await new Promise<number>((resolve, reject) => {
			child.once('error', reject)
			child.once('exit', (code, signal) => {
				if (code !== null) return resolve(code)
				const numbers: Record<string, number> = {
					SIGHUP: 1,
					SIGINT: 2,
					SIGTERM: 15,
					SIGKILL: 9,
				}
				resolve(128 + (signal ? (numbers[signal] ?? 1) : 1))
			})
		})
	} finally {
		for (const signal of signals) process.off(signal, forward)
	}
}
