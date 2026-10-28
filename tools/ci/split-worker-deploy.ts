import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	isRetryableWranglerDeployFailure,
	runWranglerDeployWithRetry,
	spawnWranglerDeploy,
	type WranglerDeployRun,
	type WranglerDeployRunResult,
} from './retry-classifiers.ts'

/**
 * Production Worker deploys split `wrangler deploy` into its three halves:
 *
 * 1. `wrangler versions upload --tag <tag> --message <sha>` (captures the id)
 * 2. `wrangler versions deploy <id>@100%` (retried for the SAME id)
 * 3. `wrangler triggers deploy` (routes, custom domains, crons, queues,
 *    workflows: the part `wrangler deploy` runs after the deployment)
 *
 * Wrangler 4 `deploy` already does upload + POST /deployments internally, so
 * a transient failure on the deployments call (Cloudflare 10013) left an
 * uploaded-but-undeployed latest version, and a retried `wrangler deploy`
 * uploaded yet another version. Every later classic `secret bulk` then failed
 * with 10215. Splitting lets a retry redeploy the version that already exists.
 *
 * Secrets: `versions upload` uses the same POST /versions upload form as
 * `wrangler deploy` with `keepSecrets: true`, so secrets synced earlier in the
 * job (classic bulk or the `versions secret bulk` fallback) carry over to the
 * uploaded and then deployed version exactly as before.
 *
 * Opt in with `KODY_SPLIT_DEPLOY_TAG` (and optionally
 * `KODY_SPLIT_DEPLOY_MESSAGE`); without it callers keep the classic path.
 */
const splitDeployTagEnvName = 'KODY_SPLIT_DEPLOY_TAG'
const splitDeployMessageEnvName = 'KODY_SPLIT_DEPLOY_MESSAGE'

const ansiEscapePattern = new RegExp(`${'\u001b'}\\[[0-9;]*m`, 'g')
const versionIdPattern =
	/Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

const uploadAttempts = 3
const deployAttempts = 4
const defaultBaseDelayMs = 10_000

/** Flags that select the target Worker for read and deploy subcommands. */
const targetFlagNames = new Set(['--config', '-c', '--name', '--env', '-e'])

export function isPendingDurableObjectMigrationUploadError(output: string) {
	return /pending Durable Object migration, which cannot be applied by `?wrangler versions upload`?/i.test(
		output.replace(ansiEscapePattern, ''),
	)
}

/** First deploy of a brand-new Worker: there is nothing to add a version to. */
export function isMissingWorkerUploadError(output: string) {
	const text = output.replace(ansiEscapePattern, '')
	return /\[code:\s*10007\]/.test(text) && /does not exist/i.test(text)
}

/**
 * Prefer Wrangler's machine-readable output file (`WRANGLER_OUTPUT_FILE_PATH`,
 * ND-JSON with a `version-upload` entry), then the `Worker Version ID:` line.
 */
export function parseUploadedVersionId(
	outputFileText: string,
	consoleOutput: string,
) {
	for (const line of outputFileText.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const entry = JSON.parse(trimmed) as {
				type?: unknown
				version_id?: unknown
			}
			if (
				entry.type === 'version-upload' &&
				typeof entry.version_id === 'string' &&
				entry.version_id.length > 0
			) {
				return entry.version_id
			}
		} catch {
			// Not JSON; ignore.
		}
	}
	const match = versionIdPattern.exec(
		consoleOutput.replace(ansiEscapePattern, ''),
	)
	return match?.[1] ?? null
}

export function shouldUseSplitDeploy(
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv,
) {
	const tag = env[splitDeployTagEnvName]?.trim()
	return (
		args[0] === 'deploy' &&
		Boolean(tag) &&
		!args.includes('--dry-run') &&
		!args.some((arg) => arg.startsWith('--dry-run='))
	)
}

/**
 * `['deploy', ...rest]` becomes `['versions', 'upload', ...rest]` for the
 * upload, plus the target flags (`--config`, `--name`, `--env`) that the
 * deploy, triggers, and read-only list/status commands need.
 */
export function splitDeployArgs(args: ReadonlyArray<string>) {
	if (args[0] !== 'deploy') {
		throw new Error('splitDeployArgs expects wrangler deploy arguments')
	}
	const rest = args.slice(1)
	const targetArgs: Array<string> = []
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index] ?? ''
		const [flag] = arg.split('=', 1)
		if (!flag || !targetFlagNames.has(flag)) continue
		if (arg.includes('=')) {
			targetArgs.push(arg)
			continue
		}
		const value = rest[index + 1]
		if (value === undefined) continue
		targetArgs.push(arg, value)
		index += 1
	}
	return {
		uploadArgs: ['versions', 'upload', ...rest],
		targetArgs,
	}
}

function parseJsonFromWranglerStdout(output: string): unknown {
	const text = output.replace(ansiEscapePattern, '')
	// stdout and stderr are merged, so `▲ [WARNING]` lines can surround the
	// payload. Try each line-start `[`/`{` up to each line-end `]`/`}` until
	// one parses.
	const starts = [...text.matchAll(/^[[{]/gm)].map((match) => match.index)
	const ends = [...text.matchAll(/[\]}][ \t]*$/gm)].map((match) => match.index)
	for (const start of starts) {
		for (const end of ends) {
			if (end < start) continue
			try {
				return JSON.parse(text.slice(start, end + 1))
			} catch {
				// Not the JSON payload; try the next candidate.
			}
		}
	}
	return null
}

export function findVersionIdByTag(versions: unknown, tag: string) {
	if (!Array.isArray(versions)) return null
	const matches = versions
		.filter(
			(
				version,
			): version is {
				id: string
				annotations?: Record<string, unknown>
				metadata?: { created_on?: unknown }
			} =>
				typeof version === 'object' &&
				version !== null &&
				typeof (version as { id?: unknown }).id === 'string' &&
				(version as { annotations?: Record<string, unknown> }).annotations?.[
					'workers/tag'
				] === tag,
		)
		.sort((left, right) =>
			String(right.metadata?.created_on ?? '').localeCompare(
				String(left.metadata?.created_on ?? ''),
			),
		)
	return matches[0]?.id ?? null
}

export function deploymentServesVersionFully(
	deployment: unknown,
	versionId: string,
) {
	const versions = (deployment as { versions?: unknown } | null)?.versions
	if (!Array.isArray(versions)) return false
	return versions.some(
		(entry) =>
			typeof entry === 'object' &&
			entry !== null &&
			(entry as { version_id?: unknown }).version_id === versionId &&
			Number((entry as { percentage?: unknown }).percentage) === 100,
	)
}

/** Quiet read: capture output without echoing JSON into the deploy log. */
const quietRun: WranglerDeployRun = (command, args, env) =>
	spawnWranglerDeploy(command, args, env, {
		stdout: { write: () => true } as unknown as NodeJS.WritableStream,
		stderr: { write: () => true } as unknown as NodeJS.WritableStream,
	})

export type SplitWorkerDeployInput = {
	command: string
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
	tag: string
	message?: string
	run?: WranglerDeployRun
	readRun?: WranglerDeployRun
	sleep?: (ms: number) => Promise<void>
	log?: (line: string) => void
	baseDelayMs?: number
	readOutputFile?: (path: string) => Promise<string>
}

export type SplitWorkerDeployResult = WranglerDeployRunResult & {
	versionId: string | null
	mode: 'split' | 'classic-migration'
}

export async function runSplitWorkerDeploy(
	input: SplitWorkerDeployInput,
): Promise<SplitWorkerDeployResult> {
	const run = input.run ?? spawnWranglerDeploy
	const readRun = input.readRun ?? quietRun
	const env = input.env ?? process.env
	const log = input.log ?? ((line: string) => console.error(line))
	const baseDelayMs = input.baseDelayMs ?? defaultBaseDelayMs
	const wait =
		input.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms)
			}))
	const readOutputFile =
		input.readOutputFile ?? ((path: string) => readFile(path, 'utf8'))
	const { uploadArgs, targetArgs } = splitDeployArgs(input.args)
	const tag = input.tag
	const message = input.message?.trim() || tag
	const outputs: Array<string> = []

	async function lookupTaggedVersion() {
		const listed = await readRun(
			input.command,
			['versions', 'list', '--json', ...targetArgs],
			env,
		)
		if (listed.status !== 0) return null
		return findVersionIdByTag(parseJsonFromWranglerStdout(listed.output), tag)
	}

	async function versionIsLive(versionId: string) {
		const status = await readRun(
			input.command,
			['deployments', 'status', '--json', ...targetArgs],
			env,
		)
		if (status.status !== 0) return false
		return deploymentServesVersionFully(
			parseJsonFromWranglerStdout(status.output),
			versionId,
		)
	}

	function finish(
		result: WranglerDeployRunResult,
		versionId: string | null,
	): SplitWorkerDeployResult {
		return {
			...result,
			output: [...outputs, result.output].join('\n'),
			versionId,
			mode: 'split',
		}
	}

	// An earlier attempt in this job (outer workflow retry) may have uploaded
	// already. Reuse that version instead of uploading another one.
	let versionId = await lookupTaggedVersion()
	if (versionId) {
		log(
			`Reusing Worker version ${versionId} already uploaded with tag ${tag}; skipping re-upload.`,
		)
	}

	for (let attempt = 1; !versionId && attempt <= uploadAttempts; attempt += 1) {
		const outputPath = join(
			tmpdir(),
			`wrangler-output-${Date.now()}-${randomBytes(6).toString('hex')}.ndjson`,
		)
		log(
			`Uploading Worker version (attempt ${attempt}/${uploadAttempts}, tag ${tag}).`,
		)
		const uploaded = await run(
			input.command,
			[...uploadArgs, '--tag', tag, '--message', message],
			{ ...env, WRANGLER_OUTPUT_FILE_PATH: outputPath },
		)
		const outputFileText = await readOutputFile(outputPath).catch(() => '')
		await rm(outputPath, { force: true }).catch(() => {})
		outputs.push(uploaded.output)
		const combined = `${uploaded.output} ${uploaded.errorMessage}`
		if (uploaded.status === 0) {
			versionId = parseUploadedVersionId(outputFileText, uploaded.output)
			if (!versionId) {
				log(
					'wrangler versions upload succeeded but no Worker Version ID was found in its output.',
				)
				return finish({ ...uploaded, status: 1 }, null)
			}
			break
		}
		if (
			isPendingDurableObjectMigrationUploadError(combined) ||
			isMissingWorkerUploadError(combined)
		) {
			// Pending DO migrations cannot ride a version upload, and a new
			// Worker has nothing to add a version to. Classic `wrangler deploy`
			// uses the atomic script PUT in both cases, which never leaves an
			// undeployed version behind.
			log(
				'Pending Durable Object migration or new Worker: falling back to wrangler deploy (atomic upload, no separate deployment call).',
			)
			const classic = await runWranglerDeployWithRetry({
				command: input.command,
				args: input.args,
				env,
				run,
				sleep: wait,
				log,
			})
			return {
				...classic,
				output: [...outputs, classic.output].join('\n'),
				versionId: null,
				mode: 'classic-migration',
			}
		}
		// The upload can land even when wrangler reports a failure (lost
		// response). The tag makes that visible without guessing.
		versionId = await lookupTaggedVersion()
		if (versionId) {
			log(
				`wrangler versions upload reported a failure, but version ${versionId} with tag ${tag} exists; deploying it.`,
			)
			break
		}
		if (
			attempt === uploadAttempts ||
			!isRetryableWranglerDeployFailure(combined)
		) {
			return finish(uploaded, null)
		}
		const delayMs = baseDelayMs * 2 ** (attempt - 1)
		log(
			`Retrying wrangler versions upload in ${String(delayMs)}ms after a transient Cloudflare failure.`,
		)
		await wait(delayMs)
	}

	if (!versionId) {
		return finish({ status: 1, output: '', errorMessage: 'no version' }, null)
	}

	log(`Uploaded Worker version ${versionId} (tag ${tag}).`)
	for (let attempt = 1; attempt <= deployAttempts; attempt += 1) {
		log(
			`Deploying Worker version ${versionId} at 100% (attempt ${attempt}/${deployAttempts}).`,
		)
		const deployed = await run(
			input.command,
			[
				'versions',
				'deploy',
				`${versionId}@100%`,
				...targetArgs,
				'--yes',
				'--message',
				`${tag} ${message}`.slice(0, 100),
			],
			env,
		)
		outputs.push(deployed.output)
		if (deployed.status === 0) break
		// The deployments POST may have succeeded with the response lost.
		if (await versionIsLive(versionId)) {
			log(
				`wrangler versions deploy reported a failure, but version ${versionId} is already serving 100% of traffic.`,
			)
			break
		}
		const combined = `${deployed.output} ${deployed.errorMessage}`
		if (
			attempt === deployAttempts ||
			!isRetryableWranglerDeployFailure(combined)
		) {
			log(
				`Worker version ${versionId} (tag ${tag}) was uploaded but is NOT deployed. Redeploy that version id instead of uploading a new one.`,
			)
			return finish(deployed, versionId)
		}
		const delayMs = baseDelayMs * 2 ** (attempt - 1)
		log(
			`Retrying wrangler versions deploy of the same version ${versionId} in ${String(delayMs)}ms after a transient Cloudflare failure (no re-upload).`,
		)
		await wait(delayMs)
	}

	const triggers = await runWranglerDeployWithRetry({
		command: input.command,
		args: ['triggers', 'deploy', ...targetArgs],
		env,
		run,
		sleep: wait,
		log,
	})
	if (triggers.status !== 0) {
		log(
			`Worker version ${versionId} is deployed, but wrangler triggers deploy failed. Re-run wrangler triggers deploy; do not re-upload.`,
		)
		return finish(triggers, versionId)
	}
	// Same line `wrangler deploy` prints, so rollback runbook greps still work.
	console.log(`Current Version ID: ${versionId}`)
	return finish(triggers, versionId)
}

/**
 * Entry point for deploy callers: the split path when the tag env is set,
 * otherwise the classic retried `wrangler deploy`.
 */
export async function runWorkerDeploy(input: {
	command: string
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
}): Promise<WranglerDeployRunResult> {
	const env = input.env ?? process.env
	if (!shouldUseSplitDeploy(input.args, env)) {
		return runWranglerDeployWithRetry(input)
	}
	return runSplitWorkerDeploy({
		command: input.command,
		args: input.args,
		env,
		tag: env[splitDeployTagEnvName]?.trim() ?? '',
		message: env[splitDeployMessageEnvName],
	})
}
