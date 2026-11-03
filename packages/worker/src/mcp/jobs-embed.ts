import type { JobView } from '#worker/jobs/types.ts'

const defaultJobEmbedMaxChars = 8_000

export function buildJobEmbedText(
	input: {
		name: string
		description?: string | null
		keywords?: Array<string>
		searchText?: string | null
		scheduleSummary: string
		sourceId?: string | null
		publishedCommit?: string | null
	},
	maxChars: number = defaultJobEmbedMaxChars,
) {
	const text = [
		input.name,
		input.description ?? '',
		...(input.keywords ?? []),
		input.searchText ?? '',
		'job',
		'scheduled task',
		input.scheduleSummary,
		input.sourceId ? `source ${input.sourceId}` : '',
		input.publishedCommit ? `commit ${input.publishedCommit}` : '',
	]
		.filter((value) => value.length > 0)
		.join('\n')
	return text.slice(0, maxChars)
}

export function buildJobUsage(job: Pick<JobView, 'id'>) {
	return `Inspect metadata with jobGet: ${JSON.stringify({ id: job.id })}. Include source code with jobGet: ${JSON.stringify({ id: job.id, includeCode: true })}. List jobs with jobList: {}. Update with jobUpdate: ${JSON.stringify({ id: job.id, enabled: false })}. Remove a job from its package.json#kody.jobs and publish the package. Trigger immediately with jobRunNow: ${JSON.stringify({ id: job.id })}.`
}
