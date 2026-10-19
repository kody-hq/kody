/**
 * Catch misspelled `steps.<id>.outputs.*` and `needs.<id>` references in
 * GitHub Actions workflows before they silently resolve to empty strings on
 * a production deploy. Also refuses deploy.yml ↔ deploy-workflow-contract
 * version drift.
 *
 * Usage:
 *   node tools/check-workflow-refs.ts
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { checkDeployWorkflowContractDrift } from './ci/deploy-workflow-contract.ts'
import { checkServerJsonVersionBump } from './ci/mcp-registry-publish.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultWorkflowDirectory = path.join('.github', 'workflows')

const jobIdPattern = /^ {2}([A-Za-z0-9_-]+):\s*$/
const stepIdPattern = /^ {8}id:\s*([A-Za-z0-9_-]+)\s*$/
const stepIdOnDashPattern = /^ {6}- id:\s*([A-Za-z0-9_-]+)\s*$/
const stepOutputRefPattern = /\bsteps\.([A-Za-z0-9_-]+)\.outputs\b/g
const needsRefPattern = /\bneeds\.([A-Za-z0-9_-]+)\b/g
const needsListItemPattern = /^ {6}-\s+([A-Za-z0-9_-]+)\s*$/
const needsInlinePattern = /^ {4}needs:\s+([A-Za-z0-9_-]+)\s*$/
const needsFlowListPattern = /^ {4}needs:\s*\[([^\]]*)\]\s*$/
const needsListHeaderPattern = /^ {4}needs:\s*$/

export type WorkflowRefIssue = {
	file: string
	line: number
	message: string
}

export type WorkflowRefCheckResult = {
	ok: boolean
	issues: Array<WorkflowRefIssue>
}

type JobBlock = {
	id: string
	startLine: number
	lines: Array<string>
}

function stripComment(line: string) {
	return line.replace(/#.*$/, '')
}

function collectJobBlocks(source: string): Array<JobBlock> {
	const lines = source.split('\n')
	const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line))
	if (jobsIndex === -1) return []

	const jobs: Array<{ id: string; startLine: number; startIndex: number }> = []
	let endIndex = lines.length
	for (let index = jobsIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? ''
		if (/^\S/.test(line) && line.trim() !== '') {
			endIndex = index
			break
		}
		const match = jobIdPattern.exec(line)
		if (match?.[1]) {
			jobs.push({
				id: match[1],
				startLine: index + 1,
				startIndex: index,
			})
		}
	}

	return jobs.map((job, jobIndex) => {
		const nextStart = jobs[jobIndex + 1]?.startIndex ?? endIndex
		return {
			id: job.id,
			startLine: job.startLine,
			lines: lines.slice(job.startIndex, nextStart),
		}
	})
}

function collectStepIds(job: JobBlock): Set<string> {
	const ids = new Set<string>()
	for (const line of job.lines) {
		const stripped = stripComment(line)
		const match =
			stepIdPattern.exec(stripped) ?? stepIdOnDashPattern.exec(stripped)
		if (match?.[1]) ids.add(match[1])
	}
	return ids
}

function parseNeedsFlowIds(list: string): Array<string> {
	return list
		.split(',')
		.map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
		.filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
}

function collectNeedsListIds(
	job: JobBlock,
): Array<{ id: string; line: number }> {
	const refs: Array<{ id: string; line: number }> = []
	let inNeedsList = false
	for (const [offset, rawLine] of job.lines.entries()) {
		const line = stripComment(rawLine)
		const flow = needsFlowListPattern.exec(line)
		if (flow?.[1] !== undefined) {
			for (const id of parseNeedsFlowIds(flow[1])) {
				refs.push({ id, line: job.startLine + offset })
			}
			inNeedsList = false
			continue
		}
		const inline = needsInlinePattern.exec(line)
		if (inline?.[1]) {
			refs.push({ id: inline[1], line: job.startLine + offset })
			inNeedsList = false
			continue
		}
		if (needsListHeaderPattern.test(line)) {
			inNeedsList = true
			continue
		}
		if (!inNeedsList) continue
		if (/^ {4}\S/.test(line)) {
			inNeedsList = false
			continue
		}
		const item = needsListItemPattern.exec(line)
		if (item?.[1]) {
			refs.push({ id: item[1], line: job.startLine + offset })
		}
	}
	return refs
}

export function checkWorkflowSource(
	file: string,
	source: string,
): Array<WorkflowRefIssue> {
	const jobs = collectJobBlocks(source)
	const jobIds = new Set(jobs.map((job) => job.id))
	const issues: Array<WorkflowRefIssue> = []

	for (const job of jobs) {
		const stepIds = collectStepIds(job)
		const declaredNeeds = collectNeedsListIds(job)
		const declaredNeedIds = new Set(declaredNeeds.map((needed) => needed.id))
		for (const [offset, rawLine] of job.lines.entries()) {
			const line = stripComment(rawLine)
			const lineNumber = job.startLine + offset

			for (const match of line.matchAll(stepOutputRefPattern)) {
				const stepId = match[1]
				if (!stepId || stepIds.has(stepId)) continue
				issues.push({
					file,
					line: lineNumber,
					message: `steps.${stepId}.outputs references a step id that does not exist in job "${job.id}".`,
				})
			}

			for (const match of line.matchAll(needsRefPattern)) {
				const neededJobId = match[1]
				if (!neededJobId) continue
				if (!jobIds.has(neededJobId)) {
					issues.push({
						file,
						line: lineNumber,
						message: `needs.${neededJobId} references a job id that does not exist in this workflow.`,
					})
					continue
				}
				if (!declaredNeedIds.has(neededJobId)) {
					issues.push({
						file,
						line: lineNumber,
						message: `needs.${neededJobId} is not declared in job "${job.id}" needs.`,
					})
				}
			}
		}

		for (const needed of declaredNeeds) {
			if (jobIds.has(needed.id)) continue
			issues.push({
				file,
				line: needed.line,
				message: `needs: ${needed.id} references a job id that does not exist in this workflow.`,
			})
		}
	}

	return issues
}

export async function checkWorkflowRefs(
	cwd: string = process.cwd(),
	workflowDirectory: string = defaultWorkflowDirectory,
): Promise<WorkflowRefCheckResult> {
	const directory = path.join(cwd, workflowDirectory)
	const filenames = (await readdir(directory))
		.filter(
			(filename) => filename.endsWith('.yml') || filename.endsWith('.yaml'),
		)
		.toSorted()
	const issues: Array<WorkflowRefIssue> = []
	for (const filename of filenames) {
		const file = path.join(workflowDirectory, filename)
		const source = await readFile(path.join(cwd, file), 'utf8')
		issues.push(...checkWorkflowSource(file, source))
	}
	return { ok: issues.length === 0, issues }
}

function formatIssue(issue: WorkflowRefIssue) {
	return `${issue.file}:${String(issue.line)}: ${issue.message}`
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const result = await checkWorkflowRefs(cwd)
	if (result.ok) {
		console.log(
			'Workflow refs ok: every steps.<id>.outputs and needs.<id> reference names an existing id.',
		)
	} else {
		console.error(
			[
				`Workflow ref check failed (${String(result.issues.length)} issue(s)).`,
				'GitHub resolves unknown step and job ids to empty strings instead of failing the workflow.',
				'',
				...result.issues.map(formatIssue),
			].join('\n'),
		)
		process.exitCode = 1
	}

	const contractDrift = await checkDeployWorkflowContractDrift(cwd)
	if (contractDrift.ok) {
		console.log(
			`Deploy workflow contract ok: EXPECTED_DEPLOY_WORKFLOW_CONTRACT=${String(contractDrift.version)}.`,
		)
	} else {
		console.error(contractDrift.message)
		process.exitCode = 1
	}

	const versionBump = await checkServerJsonVersionBump({ cwd })
	if (versionBump.ok) {
		console.log(versionBump.message)
		return
	}
	console.error(versionBump.message)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
