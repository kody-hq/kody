import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	packageCheckUploadKey,
	packageRunResultKey,
	prepareStagedPackageCheckUpload,
	type PackageCheckPrepareRequest,
} from '#worker/repo/package-check-upload.ts'
import {
	runStagedPublishWorkStep,
	type PublishWorkRequest,
} from '#worker/repo/publish-work.ts'
import type { WorkflowProjectionProgress } from '#worker/run-records/workflow-projection.ts'

const mockModule = vi.hoisted(() => ({
	resolveOwnedPackageSource: vi.fn(),
	runPackageCheckArtifactBuild: vi.fn(),
}))

vi.mock('#mcp/capabilities/packages/resolve-package-source.ts', () => ({
	resolveOwnedPackageSource: (...args: Array<unknown>) =>
		mockModule.resolveOwnedPackageSource(...args),
}))

vi.mock('#worker/repo/package-check-artifact-build.ts', () => ({
	runPackageCheckArtifactBuild: (...args: Array<unknown>) =>
		mockModule.runPackageCheckArtifactBuild(...args),
}))

const { runPackageCheckWorkflow } = await import('./package-check-run.ts')

const userId = ownerIdFromStored('user-1')
const uploadId = `pcu_${'b'.repeat(32)}`
const workflowId = 'dynwf-check-1'
const params = {
	upload_id: uploadId,
	owner_scope: 'acme',
	owner_email: 'user-1@example.com',
	base_url: 'https://kody.test',
}

function packageFiles(): Record<string, string> {
	return {
		'package.json': JSON.stringify({
			name: '@acme/poll',
			type: 'module',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'poll',
				description: 'Polls an API.',
				credentials: {
					TOKEN: { kind: 'secret', description: 'API token for the poll.' },
				},
			},
		}),
		'README.md': '# poll\n\nPolls an API.\n',
		'AGENTS.md': '# Agents\n\nCall the default export.\n',
		'src/index.ts': [
			'export default async function poll() {',
			"\tconst response = await fetch('https://api.example.com/poll', {",
			"\t\theaders: { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' },",
			'\t})',
			'\treturn response.status',
			'}',
		].join('\n'),
	}
}

/** In-memory R2 and KV, and a REPO_SESSION whose stubs run the real RPC bodies. */
function createEnv(upload: unknown | null) {
	const objects = new Map<string, string>()
	if (upload !== null) {
		objects.set(packageCheckUploadKey(userId, uploadId), JSON.stringify(upload))
	}
	const kvStore = new Map<string, string | ArrayBuffer>()
	const isolateNames: Array<string> = []
	const env = {
		APP_DB: {},
		REPO_SESSION_BLOBS: {
			async get(key: string) {
				const value = objects.get(key)
				return value === undefined ? null : { text: async () => value }
			},
			async put(key: string, value: string) {
				objects.set(key, value)
			},
			async delete(key: string) {
				objects.delete(key)
			},
		},
		BUNDLE_ARTIFACTS_KV: {
			async put(key: string, value: string | ArrayBuffer) {
				kvStore.set(key, value)
			},
			async get(key: string, type?: string) {
				const value = kvStore.get(key)
				if (value === undefined) return null
				if (type === 'json') return JSON.parse(value as string)
				return value
			},
			async delete(key: string) {
				kvStore.delete(key)
			},
		},
		REPO_SESSION: {
			idFromName: (name: string) => {
				isolateNames.push(name)
				return { name }
			},
			get: () => ({
				runIsolatedPackageCheckPrepare: (request: PackageCheckPrepareRequest) =>
					prepareStagedPackageCheckUpload({ env, request }),
				// Inside the isolate, checks run in place (no nested isolates).
				runIsolatedPublishWork: (request: PublishWorkRequest) =>
					runStagedPublishWorkStep({
						env: { ...env, REPO_SESSION: undefined } as unknown as Env,
						request,
					}),
				takeLastCheckStep: async () => null,
			}),
		},
	} as unknown as Env
	return { env, objects, kvStore, isolateNames }
}

async function run(upload: unknown | null) {
	mockModule.resolveOwnedPackageSource.mockReset()
	mockModule.resolveOwnedPackageSource.mockRejectedValue(
		new Error('Package not found.'),
	)
	mockModule.runPackageCheckArtifactBuild.mockReset()
	mockModule.runPackageCheckArtifactBuild.mockImplementation(
		async (input: {
			onChunkDone?: (progress: { done: number; total: number }) => unknown
		}) => {
			await input.onChunkDone?.({ done: 1, total: 2 })
			await input.onChunkDone?.({ done: 2, total: 2 })
			return { kind: 'bundle', ok: true, message: 'Built 2 artifacts.' }
		},
	)
	const harness = createEnv(upload)
	const steps: Array<string> = []
	const progress: Array<WorkflowProjectionProgress> = []
	const summary = await runPackageCheckWorkflow({
		env: harness.env,
		userId,
		workflowId,
		params,
		request: null,
		step: async (name, callback) => {
			steps.push(name)
			return await callback()
		},
		reportProgress: async (value) => {
			progress.push(value)
		},
	})
	const stored = harness.objects.get(packageRunResultKey(userId, workflowId))
	return {
		...harness,
		summary,
		steps,
		progress,
		result: stored
			? (JSON.parse(stored) as {
					kind: string
					ok: boolean
					package_name: string | null
					checks: Array<{ kind: string; ok: boolean; message: string }>
					notices: Array<string>
				})
			: null,
	}
}

test('a check run stores the full result in R2 under the run id and keeps only a summary', async () => {
	const outcome = await run({ files: packageFiles() })

	// The stamped `|scope=package` placeholder is what publish refuses.
	expect(outcome.summary).toEqual({
		ok: false,
		package_name: '@acme/poll',
		failed_checks: 1,
	})
	expect(JSON.stringify(outcome.summary)).not.toMatch(/Credential stamp/)
	expect(outcome.result).toMatchObject({
		kind: 'packageCheck',
		ok: false,
		package_name: '@acme/poll',
	})
	const credentials = outcome.result?.checks.find(
		(entry) => entry.kind === 'credentials',
	)
	expect(credentials?.ok).toBe(false)
	expect(credentials?.message).toMatch(/Credential stamp publish gate/)
	// The gate stops the run, as publish does.
	expect(outcome.result?.checks.some((entry) => entry.kind === 'bundle')).toBe(
		false,
	)
	expect(mockModule.runPackageCheckArtifactBuild).not.toHaveBeenCalled()

	expect(outcome.steps).toEqual([
		'prepare uploaded tree',
		'resolve existing package',
		'run publish checks',
		'job floor and notices',
		'store check result',
	])
	expect(outcome.progress.map((entry) => entry.phase)).toEqual([
		'prepare',
		'checks',
		'finish',
	])
	// Every heavy phase ran in its own throwaway isolate.
	expect(outcome.isolateNames.length).toBeGreaterThanOrEqual(2)
	expect(new Set(outcome.isolateNames).size).toBe(outcome.isolateNames.length)
	// The upload and the staged tree are gone once the run finishes.
	expect(outcome.objects.has(packageCheckUploadKey(userId, uploadId))).toBe(
		false,
	)
	expect(outcome.kvStore.size).toBe(0)
})

test('a check run refuses a package scope publish would refuse', async () => {
	const files = packageFiles()
	files['package.json'] = files['package.json']!.replace('@acme/', '@other/')
	const outcome = await run({ files })
	expect(outcome.result?.ok).toBe(false)
	expect(outcome.result?.checks[0]).toMatchObject({
		kind: 'manifest',
		ok: false,
	})
})

test('a check run reports a job schedule the plan refuses, as publish would', async () => {
	consoleWarn.mockImplementation(() => {})
	const files = packageFiles()
	const manifest = JSON.parse(files['package.json']!)
	delete manifest.kody.credentials
	manifest.kody.jobs = {
		poll: {
			entry: './src/index.ts',
			schedule: { type: 'cron', expression: '*/10 * * * *' },
		},
	}
	files['package.json'] = JSON.stringify(manifest)
	files['src/index.ts'] = 'export default async function poll() {}\n'
	const outcome = await run({ files })
	expect(outcome.result?.ok).toBe(false)
	const denial = outcome.result?.checks.find(
		(entry) => entry.kind === 'manifest' && entry.ok === false,
	)
	expect(denial?.message).toMatch(/^kody\.jobs\.poll\.schedule:/)
	expect(denial?.message).toMatch(/15 minutes/)
	// The checks passed, so the artifacts were built in the rebuild isolates
	// with chunk progress, before the job floor refused the schedule.
	expect(outcome.steps).toContain('build runtime artifacts')
	expect(outcome.result?.checks).toContainEqual({
		kind: 'bundle',
		ok: true,
		message: 'Built 2 artifacts.',
	})
	expect(outcome.progress).toContainEqual({
		phase: 'artifact_build',
		message: 'Built 2 of 2 artifact chunks.',
		done: 2,
		total: 2,
	})
})

test('a check run reports an unusable upload as a failed check without running any', async () => {
	const outside = await run({
		files: { ...packageFiles(), '../secrets.txt': 'nope' },
	})
	expect(outside.result?.ok).toBe(false)
	expect(outside.result?.checks).toEqual([
		{
			kind: 'manifest',
			ok: false,
			message: expect.stringMatching(/relative to the package root/),
		},
	])
	expect(outside.steps).toEqual(['prepare uploaded tree', 'store check result'])

	const both = await run({
		files: packageFiles(),
		binary_contents: { 'README.md': btoa('x') },
	})
	expect(both.result?.checks[0]?.message).toMatch(
		/in both files and binary_contents/,
	)

	const missing = await run(null)
	expect(missing.result?.checks[0]?.message).toMatch(/expired or is missing/)
})
