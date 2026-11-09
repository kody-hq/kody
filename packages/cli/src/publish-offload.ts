import { createInterface } from 'node:readline/promises'
import {
	publishBuildUploadUrl,
	pushHeadForPublish,
	runLocalPublishBuild,
	type PublishBuilder,
} from './local-publish-build.js'
import { executionContextPublishDocsUrl } from './publish-limit-advice.js'

/** Same page the worker links from resource-limit errors. */
export const publishLargePackagesDocsUrl =
	'https://kody.codes/docs/publish-large-packages'

type Call = (
	operationId: string,
	params: Record<string, unknown>,
) => Promise<unknown>

export function isResourceLimitRefusal(result: unknown) {
	const text = JSON.stringify(result ?? null)
	return (
		text.includes(publishLargePackagesDocsUrl) ||
		text.includes(executionContextPublishDocsUrl)
	)
}

export function offloadCommandsText(ref: string) {
	return [
		"This package is near Kody cloud's build CPU or memory limit. Build it outside Kody cloud instead:",
		`  kody package publish ${ref} --build local          # on this machine (clean checkout; pushes HEAD first)`,
		`  kody package publish ${ref} --context <name>       # on an execution context you operate`,
		`Docs: ${executionContextPublishDocsUrl}`,
		`More: ${publishLargePackagesDocsUrl}`,
	].join('\n')
}

async function askBuildHere(writeErr: (text: string) => void) {
	const rl = createInterface({ input: process.stdin, output: process.stderr })
	try {
		writeErr('Kody cloud ran out of room building this package.\n')
		const answer = await rl.question('Build it here now and publish? [y/N] ')
		return /^y(es)?$/i.test(answer.trim())
	} finally {
		rl.close()
	}
}

async function buildThenPublish(input: {
	origin: 'cli' | 'context'
	target: Record<string, unknown>
	call: Call
	apiUrl: string
	cwd: string
	writeErr: (text: string) => void
	fetchFn?: typeof fetch
	loadBuilder?: () => Promise<PublishBuilder>
}) {
	const log = (line: string) => input.writeErr(`${line}\n`)
	// 8B: never build a commit Kody cannot see.
	const pushed =
		input.origin === 'cli' ? await pushHeadForPublish(input.cwd, log) : null
	const created = (await input.call('packagePublishBuildCreate', {
		...input.target,
		origin: input.origin,
		...(pushed ? { expected_commit: pushed.head } : {}),
	})) as {
		build_id: string
		package_id: string
		commit: string
		upload_path: string
		source_root?: string
		manifest_path?: string
		upload_ticket?: string
		context_name?: string
	}
	if (pushed) {
		if (created.commit !== pushed.head) {
			throw new Error(
				`Kody sees ${String(created.commit).slice(0, 12)} for this package, not your HEAD ${pushed.head.slice(0, 12)}. Nothing was built or uploaded. Push HEAD to the package's Kody remote and try again.`,
			)
		}
		if (!created.upload_ticket) {
			throw new Error('Kody did not return an upload ticket for this build.')
		}
		const built = await runLocalPublishBuild({
			dir: input.cwd,
			apiUrl: input.apiUrl,
			ticket: {
				buildId: created.build_id,
				packageId: created.package_id,
				commit: created.commit,
				...(created.source_root ? { sourceRoot: created.source_root } : {}),
				...(created.manifest_path
					? { manifestPath: created.manifest_path }
					: {}),
				userId: '',
				uploadUrl: publishBuildUploadUrl(input.apiUrl, created.upload_path),
				ticket: created.upload_ticket,
			},
			log,
			...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
			...(input.loadBuilder ? { loadBuilder: input.loadBuilder } : {}),
		})
		input.writeErr(
			`Built ${built.targets} targets locally in ${built.buildMs} ms (${built.uploadedChunks} chunks uploaded, ${built.reusedChunks} reused).\n`,
		)
	} else {
		input.writeErr(
			`Built on execution context ${created.context_name ?? ''}.\n`,
		)
	}
	const { context: _context, ...publishTarget } = input.target
	return await input.call('packagePublishExternalPush', {
		...publishTarget,
		publish_build_id: created.build_id,
	})
}

/**
 * `kody package publish [--build local|context] [--context <name|cloud>]`.
 * Without either, Kody picks where it builds: the package's
 * `kody.publish.execution.context` binding, else your execution context
 * chain (Kody cloud last). When a cloud build hits a resource limit, a TTY is
 * asked whether to build here now (2B) and agents/CI get the commands and docs.
 */
export async function runPublishWithBuild(input: {
	build: string | null
	/** `--context`: build on this execution context (or `cloud`), no fallback. */
	context?: string | null
	target: Record<string, unknown>
	call: Call
	apiUrl: string
	cwd: string
	interactive: boolean
	writeErr: (text: string) => void
	fetchFn?: typeof fetch
	loadBuilder?: () => Promise<PublishBuilder>
}) {
	if (
		input.build !== null &&
		input.build !== 'local' &&
		input.build !== 'context'
	) {
		throw new Error('--build must be local or context.')
	}
	const context = input.context?.trim() || null
	if (context && input.build === 'local') {
		throw new Error(
			'--context names an execution context, so it cannot be combined with --build local.',
		)
	}
	if (input.build) {
		return await buildThenPublish({
			...input,
			target:
				context && input.build === 'context'
					? { ...input.target, context }
					: input.target,
			origin: input.build === 'local' ? 'cli' : 'context',
		})
	}
	if (context) {
		// Kody builds on that context (or cloud) and never falls back.
		return await input.call('packagePublishExternalPush', {
			...input.target,
			context,
		})
	}
	const ref = String(input.target.package_id ?? input.target.kody_id ?? '')
	const offerOffload = async () => {
		if (input.interactive && (await askBuildHere(input.writeErr))) {
			return { built: await buildThenPublish({ ...input, origin: 'cli' }) }
		}
		input.writeErr(`${offloadCommandsText(ref)}\n`)
		return null
	}
	let result: unknown
	try {
		result = await input.call('packagePublishExternalPush', input.target)
	} catch (error) {
		// A resource-limit failure can also come back as an HTTP error.
		if (
			!isResourceLimitRefusal(error instanceof Error ? error.message : error)
		) {
			throw error
		}
		const offloaded = await offerOffload()
		if (offloaded) return offloaded.built
		throw error
	}
	if (!isResourceLimitRefusal(result)) return result
	const offloaded = await offerOffload()
	return offloaded ? offloaded.built : result
}
