import { createInterface } from 'node:readline/promises'
import { runLocalPublishBuild } from './local-publish-build.js'

/** Same page the worker links from resource-limit errors. */
export const publishLargePackagesDocsUrl =
	'https://kody.codes/docs/publish-large-packages'

/**
 * Open product question 8 (does the CLI push HEAD for you?). `false`: the
 * CLI refuses unless HEAD is already pushed; flip to push first.
 */
const cliPushesHeadBeforeLocalBuild = false

type Call = (
	operationId: string,
	params: Record<string, unknown>,
) => Promise<unknown>

export function isResourceLimitRefusal(result: unknown) {
	return JSON.stringify(result ?? null).includes(publishLargePackagesDocsUrl)
}

export function offloadCommandsText(ref: string) {
	return [
		'This package is too big to build on Kody cloud. Build it outside the worker instead:',
		`  kody package publish ${ref} --build local     # on this machine (clean checkout at the pushed commit)`,
		`  kody package publish ${ref} --build context   # on an execution context you operate`,
		`Docs: ${publishLargePackagesDocsUrl}`,
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
}) {
	if (cliPushesHeadBeforeLocalBuild && input.origin === 'cli') {
		const { execFile } = await import('node:child_process')
		const { promisify } = await import('node:util')
		await promisify(execFile)('git', ['push'], { cwd: input.cwd })
	}
	const created = (await input.call('packagePublishBuildCreate', {
		...input.target,
		origin: input.origin,
	})) as {
		build_id: string
		package_id: string
		commit: string
		upload_url: string
		upload_ticket?: string
		context_name?: string
	}
	if (input.origin === 'cli') {
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
				userId: '',
				uploadUrl: created.upload_url,
				ticket: created.upload_ticket,
			},
			log: (line) => input.writeErr(`${line}\n`),
		})
		input.writeErr(
			`Built ${built.targets} targets locally in ${built.buildMs} ms (${built.uploadedChunks} chunks uploaded, ${built.reusedChunks} reused).\n`,
		)
	} else {
		input.writeErr(
			`Built on execution context ${created.context_name ?? ''}.\n`,
		)
	}
	return await input.call('packagePublishExternalPush', {
		...input.target,
		publish_build_id: created.build_id,
	})
}

/**
 * `kody package publish [--build local|context]`. Without `--build` it
 * publishes on Kody cloud; when that hits a resource limit, a TTY is asked
 * whether to build here now (2B) and agents/CI get the commands and docs.
 */
export async function runPublishWithBuild(input: {
	build: string | null
	target: Record<string, unknown>
	call: Call
	apiUrl: string
	cwd: string
	interactive: boolean
	writeErr: (text: string) => void
}) {
	if (
		input.build !== null &&
		input.build !== 'local' &&
		input.build !== 'context'
	) {
		throw new Error('--build must be local or context.')
	}
	if (input.build) {
		return await buildThenPublish({
			...input,
			origin: input.build === 'local' ? 'cli' : 'context',
		})
	}
	const result = await input.call('packagePublishExternalPush', input.target)
	if (!isResourceLimitRefusal(result)) return result
	const ref = String(input.target.package_id ?? input.target.kody_id ?? '')
	if (input.interactive && (await askBuildHere(input.writeErr))) {
		return await buildThenPublish({ ...input, origin: 'cli' })
	}
	input.writeErr(`${offloadCommandsText(ref)}\n`)
	return result
}
