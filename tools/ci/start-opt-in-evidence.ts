import { reviewedRouterName } from './start-rollout-config.ts'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { isExecutedDirectly } from '../node-runtime.ts'
type RecordValue = {
	id?: number
	name?: string
	head_sha?: string
	status?: string
	conclusion?: string
	event?: string
	path?: string
	head_branch?: string
	state?: string
	head?: { sha: string; ref: string; repo: { full_name: string } }
	jobs?: RecordValue[]
	steps?: RecordValue[]
	workflow_runs?: RecordValue[]
	manifest?: {
		release: string
		candidateName: string
		legacyName: string
		routerName?: string
		activated: boolean
	}
	release?: string
	candidateName?: string
	routerName?: string
	activated?: boolean
}
export function recognizedProofLayout(jobs: RecordValue) {
	const matches = (jobs.jobs ?? []).filter(
		(job) =>
			job.conclusion === 'success' &&
			[
				'Verify existing inactive Start release',
				'Prepare inactive Start opt-in release',
			].includes(job.name ?? ''),
	)
	if (matches.length !== 1)
		throw new Error('Exactly one recognized successful proof job required')
	return matches[0]!.name === 'Verify existing inactive Start release'
		? 'flat'
		: 'nested'
}
export function assertDeploymentEvidence(
	run: RecordValue,
	jobs: RecordValue,
	release: string,
) {
	if (
		run.head_sha !== release ||
		run.status !== 'completed' ||
		run.event !== 'workflow_dispatch' ||
		run.path !== '.github/workflows/deploy.yml' ||
		run.head_branch !== 'taren/tanstack-start-migration' ||
		!jobs.jobs?.some(
			(job: RecordValue) =>
				job.name === 'Prepare inactive Start opt-in release' &&
				job.steps?.some(
					(step: RecordValue) =>
						step.name ===
							'Deploy inactive isolated workers with trusted production secrets' &&
						step.conclusion === 'success',
				),
		)
	)
		throw new Error('Exact target deployment step must have succeeded')
}
export function assertDeployedReceipt(
	review: RecordValue,
	receipt: RecordValue,
	release: string,
) {
	if (
		review.manifest?.release !== release ||
		review.manifest?.candidateName !== `kody-start-${release}` ||
		review.manifest?.legacyName !== 'kody-production' ||
		review.manifest?.activated !== false ||
		receipt.release !== release ||
		receipt.candidateName !== `kody-start-${release}` ||
		receipt.routerName !==
			reviewedRouterName(release, review.manifest?.routerName) ||
		receipt.activated !== false
	)
		throw new Error('Exact inactive target deployment receipt required')
}
if (isExecutedDirectly(import.meta.url)) {
	const release = process.env.KODY_START_RELEASE ?? ''
	const controller = process.env.GITHUB_SHA ?? ''
	const evidenceId = process.env.EVIDENCE_RUN ?? ''
	if (
		!/^[a-f0-9]{40}$/.test(release) ||
		!/^[a-f0-9]{40}$/.test(controller) ||
		!/^\d+$/.test(evidenceId)
	)
		throw new Error('Pinned controller, target and evidence required')
	const api = async (endpoint: string): Promise<RecordValue> => {
		const response = await fetch(
			`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`,
			{
				headers: {
					Authorization: `Bearer ${process.env.GH_TOKEN}`,
					Accept: 'application/vnd.github+json',
				},
			},
		)
		if (!response.ok)
			throw new Error(`GitHub evidence verification failed: ${response.status}`)
		return response.json()
	}
	const validate = async (sha: string) => {
		const runs = await api(`actions/runs?head_sha=${sha}&per_page=100`)
		const latest = (runs.workflow_runs ?? [])
			.filter(
				(run: RecordValue) =>
					run.name === '✅ Validate' && run.head_sha === sha,
			)
			.sort((a: RecordValue, b: RecordValue) => b.id! - a.id!)[0]
		if (latest?.status !== 'completed' || latest.conclusion !== 'success')
			throw new Error(
				'Controller and target must have successful latest Validate',
			)
	}
	const pr = await api('pulls/3561')
	if (
		pr.state !== 'open' ||
		pr.head!.sha !== controller ||
		pr.head!.ref !== 'taren/tanstack-start-migration' ||
		pr.head!.repo.full_name !== process.env.GITHUB_REPOSITORY
	)
		throw new Error('Controller must be current open PR head')
	await validate(controller)
	await validate(release)
	const evidence = await api(`actions/runs/${evidenceId}`)
	const mode = process.argv[2]
	if (mode === 'deployment') {
		assertDeploymentEvidence(
			evidence,
			await api(`actions/runs/${evidenceId}/jobs?per_page=100`),
			release,
		)
	} else if (mode === 'receipt') {
		assertDeployedReceipt(
			JSON.parse(await readFile('.tmp/start-opt-in/review.json', 'utf8')),
			JSON.parse(await readFile('.tmp/start-opt-in/deployed.json', 'utf8')),
			release,
		)
		await writeFile(
			'.tmp/start-opt-in/controller.json',
			JSON.stringify({
				controller,
				release,
				deploymentRun: evidenceId,
				verificationRun: process.env.GITHUB_RUN_ID,
			}),
		)
	} else if (mode === 'verification') {
		if (
			evidence.status !== 'completed' ||
			evidence.conclusion !== 'success' ||
			evidence.event !== 'workflow_dispatch' ||
			evidence.path !== '.github/workflows/deploy.yml' ||
			evidence.head_branch !== 'taren/tanstack-start-migration'
		)
			throw new Error('Successful trusted verification workflow required')
		await validate(evidence.head_sha!)
		const jobs = await api(`actions/runs/${evidenceId}/jobs?per_page=100`)
		const layout = recognizedProofLayout(jobs)
		if (process.env.GITHUB_OUTPUT)
			await appendFile(process.env.GITHUB_OUTPUT, `layout=${layout}\n`)
	} else if (mode === 'proof') {
		const provenance = JSON.parse(
			await readFile('.tmp/start-opt-in/controller.json', 'utf8'),
		)
		if (
			provenance.controller !== evidence.head_sha ||
			provenance.release !== release ||
			provenance.verificationRun !== evidenceId ||
			!/^\d+$/.test(provenance.deploymentRun)
		)
			throw new Error('Verification controller provenance mismatch')
		assertDeploymentEvidence(
			await api(`actions/runs/${provenance.deploymentRun}`),
			await api(`actions/runs/${provenance.deploymentRun}/jobs?per_page=100`),
			release,
		)
		assertDeployedReceipt(
			JSON.parse(await readFile('.tmp/start-opt-in/review.json', 'utf8')),
			JSON.parse(await readFile('.tmp/start-opt-in/deployed.json', 'utf8')),
			release,
		)
	} else throw new Error('Choose deployment, receipt, verification or proof')
}
