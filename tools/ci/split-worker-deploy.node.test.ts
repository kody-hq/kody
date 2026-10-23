import { expect, test } from 'vitest'
import {
	deploymentServesVersionFully,
	findVersionIdByTag,
	isMissingWorkerUploadError,
	isPendingDurableObjectMigrationUploadError,
	parseUploadedVersionId,
	runSplitWorkerDeploy,
	shouldUseSplitDeploy,
	splitDeployArgs,
} from './split-worker-deploy.ts'
import { type WranglerDeployRunResult } from './retry-classifiers.ts'

const versionId = '3a6da96b-6da8-4393-b906-8ede58c99374'
const tag = 'gh-123-1'
const deployArgs = [
	'deploy',
	'--config',
	'dist/server/wrangler.json',
	'--var',
	'APP_COMMIT_SHA:abc',
	'--outdir',
	'.wrangler/sentry-bundle',
	'--upload-source-maps',
	'--name',
	'kody-production',
]
const unknownError10013 =
	'✘ [ERROR] A request to the Cloudflare API (/accounts/a/workers/scripts/kody-production/deployments) failed.\n  An unknown error has occurred. [code: 10013]'

function ok(output = ''): WranglerDeployRunResult {
	return { status: 0, output, errorMessage: '' }
}
function failed(output: string): WranglerDeployRunResult {
	return { status: 1, output, errorMessage: '' }
}

function harness(responses: {
	upload?: Array<WranglerDeployRunResult>
	deploy?: Array<WranglerDeployRunResult>
	triggers?: Array<WranglerDeployRunResult>
	classic?: Array<WranglerDeployRunResult>
	list?: Array<string>
	status?: Array<string>
}) {
	const calls: Array<Array<string>> = []
	const take = (queue: Array<WranglerDeployRunResult> | undefined) =>
		queue?.shift() ?? ok()
	const run = (_command: string, args: ReadonlyArray<string>) => {
		calls.push([...args])
		if (args[0] === 'versions' && args[1] === 'upload')
			return take(responses.upload)
		if (args[0] === 'versions' && args[1] === 'deploy')
			return take(responses.deploy)
		if (args[0] === 'triggers') return take(responses.triggers)
		if (args[0] === 'deploy') return take(responses.classic)
		throw new Error(`unexpected ${args.join(' ')}`)
	}
	const readRun = (_command: string, args: ReadonlyArray<string>) => {
		calls.push([...args])
		if (args[0] === 'versions' && args[1] === 'list') {
			return ok(responses.list?.shift() ?? '[]')
		}
		return ok(responses.status?.shift() ?? '{"versions":[]}')
	}
	return { calls, run, readRun }
}

const baseInput = {
	command: 'wrangler',
	args: deployArgs,
	env: {},
	tag,
	message: 'f5effa8dc3',
	sleep: async () => {},
	log: () => {},
	readOutputFile: async () => '',
}

test('splitDeployArgs keeps every flag for upload and only target flags for deploy', () => {
	const split = splitDeployArgs([...deployArgs, '--env', 'production'])
	expect(split.uploadArgs.slice(0, 2)).toEqual(['versions', 'upload'])
	expect(split.uploadArgs).toContain('--upload-source-maps')
	expect(split.targetArgs).toEqual([
		'--config',
		'dist/server/wrangler.json',
		'--name',
		'kody-production',
		'--env',
		'production',
	])
	expect(splitDeployArgs(['deploy', '--config=a.json']).targetArgs).toEqual([
		'--config=a.json',
	])
})

test('shouldUseSplitDeploy needs the tag env, a deploy command, and no dry run', () => {
	expect(shouldUseSplitDeploy(deployArgs, { KODY_SPLIT_DEPLOY_TAG: tag })).toBe(
		true,
	)
	expect(shouldUseSplitDeploy(deployArgs, {})).toBe(false)
	expect(
		shouldUseSplitDeploy([...deployArgs, '--dry-run'], {
			KODY_SPLIT_DEPLOY_TAG: tag,
		}),
	).toBe(false)
	expect(
		shouldUseSplitDeploy(['versions', 'upload'], {
			KODY_SPLIT_DEPLOY_TAG: tag,
		}),
	).toBe(false)
})

test('parseUploadedVersionId prefers the wrangler output file, then the console line', () => {
	const file = `${JSON.stringify({ type: 'wrangler-session' })}\n${JSON.stringify({ type: 'version-upload', version_id: versionId })}\n`
	expect(parseUploadedVersionId(file, '')).toBe(versionId)
	expect(
		parseUploadedVersionId(
			'',
			`Uploaded kody-production\nWorker Version ID: ${versionId}\n`,
		),
	).toBe(versionId)
	expect(parseUploadedVersionId('', 'nothing')).toBeNull()
})

test('findVersionIdByTag and deploymentServesVersionFully read wrangler JSON', () => {
	const versions = [
		{
			id: 'old',
			annotations: { 'workers/tag': tag },
			metadata: { created_on: '2026-10-23T15:00:00Z' },
		},
		{
			id: versionId,
			annotations: { 'workers/tag': tag },
			metadata: { created_on: '2026-10-23T15:25:24Z' },
		},
		{
			id: 'other',
			annotations: { 'workers/tag': 'gh-1-1' },
			metadata: { created_on: '2026-10-23T16:00:00Z' },
		},
	]
	expect(findVersionIdByTag(versions, tag)).toBe(versionId)
	expect(findVersionIdByTag(versions, 'missing')).toBeNull()
	expect(
		deploymentServesVersionFully(
			{ versions: [{ version_id: versionId, percentage: 100 }] },
			versionId,
		),
	).toBe(true)
	expect(
		deploymentServesVersionFully(
			{ versions: [{ version_id: versionId, percentage: 10 }] },
			versionId,
		),
	).toBe(false)
})

test('a 10013 on versions deploy retries the same version without re-uploading', async () => {
	const h = harness({
		upload: [ok(`Worker Version ID: ${versionId}`)],
		deploy: [failed(unknownError10013), ok('Deployed')],
	})
	const result = await runSplitWorkerDeploy({
		...baseInput,
		run: h.run,
		readRun: h.readRun,
	})
	expect(result.status).toBe(0)
	expect(result.versionId).toBe(versionId)
	const uploads = h.calls.filter((args) => args[1] === 'upload')
	expect(uploads).toHaveLength(1)
	expect(uploads[0]).toEqual(
		expect.arrayContaining(['--tag', tag, '--message', 'f5effa8dc3']),
	)
	const deploys = h.calls.filter(
		(args) => args[0] === 'versions' && args[1] === 'deploy',
	)
	expect(deploys).toHaveLength(2)
	for (const args of deploys) {
		expect(args[2]).toBe(`${versionId}@100%`)
		expect(args).toContain('--yes')
	}
	expect(h.calls.at(-1)?.slice(0, 2)).toEqual(['triggers', 'deploy'])
})

test('a version already uploaded with this tag is reused instead of uploading again', async () => {
	const h = harness({
		list: [
			JSON.stringify([{ id: versionId, annotations: { 'workers/tag': tag } }]),
		],
	})
	const result = await runSplitWorkerDeploy({
		...baseInput,
		run: h.run,
		readRun: h.readRun,
	})
	expect(result.status).toBe(0)
	expect(h.calls.some((args) => args[1] === 'upload')).toBe(false)
	expect(h.calls.find((args) => args[1] === 'deploy')?.[2]).toBe(
		`${versionId}@100%`,
	)
})

test('a deploy error whose deployment actually landed is treated as success', async () => {
	const h = harness({
		upload: [ok(`Worker Version ID: ${versionId}`)],
		deploy: [failed('fetch failed')],
		status: [
			JSON.stringify({
				versions: [{ version_id: versionId, percentage: 100 }],
			}),
		],
	})
	const result = await runSplitWorkerDeploy({
		...baseInput,
		run: h.run,
		readRun: h.readRun,
	})
	expect(result.status).toBe(0)
	expect(
		h.calls.filter((args) => args[1] === 'deploy' && args[0] === 'versions'),
	).toHaveLength(1)
})

test('non-retryable deploy failures stop and report the undeployed version', async () => {
	const lines: Array<string> = []
	const h = harness({
		upload: [ok(`Worker Version ID: ${versionId}`)],
		deploy: [failed('Authentication error [code: 10000]')],
	})
	const result = await runSplitWorkerDeploy({
		...baseInput,
		run: h.run,
		readRun: h.readRun,
		log: (line) => lines.push(line),
	})
	expect(result.status).toBe(1)
	expect(result.versionId).toBe(versionId)
	expect(lines.join('\n')).toContain(
		`${versionId} (tag ${tag}) was uploaded but is NOT deployed`,
	)
	expect(h.calls.some((args) => args[0] === 'triggers')).toBe(false)
})

test('a failed upload that still created the tagged version deploys that version', async () => {
	const h = harness({
		upload: [failed('Received a malformed response from the API')],
		list: [
			'[]',
			JSON.stringify([{ id: versionId, annotations: { 'workers/tag': tag } }]),
		],
	})
	const result = await runSplitWorkerDeploy({
		...baseInput,
		run: h.run,
		readRun: h.readRun,
	})
	expect(result.status).toBe(0)
	expect(h.calls.filter((args) => args[1] === 'upload')).toHaveLength(1)
})

test('pending Durable Object migrations fall back to the atomic wrangler deploy', async () => {
	const h = harness({
		upload: [
			failed(
				'This Worker has a pending Durable Object migration, which cannot be applied by `wrangler versions upload`.',
			),
		],
		classic: [ok('Current Version ID: x')],
	})
	const result = await runSplitWorkerDeploy({
		...baseInput,
		run: h.run,
		readRun: h.readRun,
	})
	expect(result.status).toBe(0)
	expect(result.mode).toBe('classic-migration')
	expect(h.calls.at(-1)).toEqual(deployArgs)
	expect(isPendingDurableObjectMigrationUploadError('nope')).toBe(false)
	expect(
		isMissingWorkerUploadError(
			'This Worker does not exist on your account. [code: 10007]',
		),
	).toBe(true)
})
