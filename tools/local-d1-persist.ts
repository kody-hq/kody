import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Repo-root Miniflare directory shared by Vite (`persistState.path`) and
 * local `wrangler d1` commands (`--persist-to`).
 *
 * Without `--persist-to`, Wrangler stores state under
 * `<dirname(config)>/.wrangler/state`. That puts APP_DB and AUDIT_DB beside
 * `packages/worker/wrangler.jsonc` and JOBS_DB beside
 * `packages/jobs-worker/wrangler.jsonc`, while Vite opens this directory.
 */
const defaultLocalD1PersistPath = '.wrangler/state'

export const workerEnvFileRelativePath = 'packages/worker/.env'

export function resolveLocalD1PersistPath(
	input: {
		explicit?: string | null
		env?: NodeJS.ProcessEnv
	} = {},
) {
	const explicit = input.explicit?.trim()
	if (explicit) return explicit
	const fromEnv = (input.env ?? process.env).WRANGLER_PERSIST_TO?.trim()
	if (fromEnv) return fromEnv
	return defaultLocalD1PersistPath
}

/**
 * `npm run dev` loads `packages/worker/.env` before Vite reads
 * `WRANGLER_PERSIST_TO`. Migrate and seed read the same assignment here.
 * A value already in `env` (the shell) wins over the file.
 */
function wranglerPersistToFromEnvFile(contents: string) {
	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const match = /^(?:export\s+)?WRANGLER_PERSIST_TO\s*=\s*(.*)$/.exec(trimmed)
		if (!match) continue
		const value = unquoteEnvValue(match[1] ?? '').trim()
		return value.length > 0 ? value : undefined
	}
	return undefined
}

function envWithWorkerPersistFile(
	env: NodeJS.ProcessEnv,
	contents: string | undefined,
) {
	if (env.WRANGLER_PERSIST_TO?.trim()) return env
	if (contents == null) return env
	const fromFile = wranglerPersistToFromEnvFile(contents)
	if (!fromFile) return env
	return { ...env, WRANGLER_PERSIST_TO: fromFile }
}

export function localPersistEnv(
	env: NodeJS.ProcessEnv = process.env,
	envFilePath = path.join(process.cwd(), workerEnvFileRelativePath),
) {
	if (env.WRANGLER_PERSIST_TO?.trim()) return env
	if (!existsSync(envFilePath)) return env
	return envWithWorkerPersistFile(env, readFileSync(envFilePath, 'utf8'))
}

function unquoteEnvValue(raw: string) {
	const trimmed = raw.trim()
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1)
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1)
	}
	const comment = trimmed.search(/\s+#/)
	return comment === -1 ? trimmed : trimmed.slice(0, comment)
}
