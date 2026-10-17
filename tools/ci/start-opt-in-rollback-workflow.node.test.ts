import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'

const workflow = await readFile('.github/workflows/deploy.yml', 'utf8')
function inlineScript(step: string) {
	const section = workflow.split(`- name: ${step}`)[1]!
	return section.split("<<'JS'\n")[1]!.split('\n          JS')[0]!
}
const provenance = inlineScript('Verify activation receipt provenance')
const target = inlineScript(
	'Select and verify the captured route receipt',
).replace("import { readFile } from 'node:fs/promises'", '')
const release = 'a'.repeat(40)
const controller = 'b'.repeat(40)
const repository = 'kentcdodds/kody'
const run = {
	head_sha: controller,
	status: 'completed',
	event: 'workflow_dispatch',
	path: '.github/workflows/deploy.yml',
	head_branch: 'taren/tanstack-start-migration',
	repository: { full_name: repository },
}
const job = {
	name: 'Activate reviewed two-account Start opt-in route',
	steps: [
		{
			name: 'Activate only the reviewed zone route overlay',
			conclusion: 'success',
		},
	],
}
function check(evidence = run, jobs: unknown[] = [job]) {
	return runInNewContext(`(async () => {${provenance}\n})()`, {
		process: {
			env: {
				KODY_START_RELEASE: release,
				EVIDENCE_RUN: '123',
				REPOSITORY: repository,
				GH_TOKEN: 'synthetic',
			},
		},
		fetch: async (url: string) => ({
			ok: true,
			json: async () => (url.includes('/jobs?') ? { jobs } : evidence),
		}),
	}) as Promise<void>
}
test('rollback authenticates activation controller independently of the older target, without green CI', async () => {
	await expect(check()).resolves.toBeUndefined()
	await expect(
		check({ ...run, conclusion: 'failure' } as typeof run, [
			{ ...job, steps: [{ ...job.steps[0], conclusion: 'failure' }] },
		]),
	).resolves.toBeUndefined()
})
test('rollback refuses unrelated runs and skipped or unknown activation jobs', async () => {
	for (const change of [
		{ head_sha: 'invalid' },
		{ status: 'in_progress' },
		{ event: 'pull_request' },
		{ path: '.github/workflows/other.yml' },
		{ head_branch: 'main' },
		{ repository: { full_name: 'other/repository' } },
	])
		await expect(check({ ...run, ...change })).rejects.toThrow(
			'trusted completed activation',
		)
	for (const jobs of [
		[],
		[{ ...job, name: 'Other job' }],
		[job, job],
		[{ ...job, steps: [{ ...job.steps[0], conclusion: 'skipped' }] }],
	]) {
		await expect(check(run, jobs)).rejects.toThrow('executed activation')
	}
})
test('the exact downloaded receipt must still pin the requested target release', async () => {
	const execute = (receiptRelease: string) =>
		runInNewContext(`(async () => {${target}\n})()`, {
			process: { env: { KODY_START_RELEASE: release } },
			readFile: async () => JSON.stringify({ release: receiptRelease }),
		}) as Promise<void>
	await expect(execute(release)).resolves.toBeUndefined()
	await expect(execute(controller)).rejects.toThrow('Receipt target release')
})
