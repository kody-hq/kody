import { toServingSourceView } from '#worker/repo/serving-commit.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import {
	loadPublishedEntitySource,
	type PublishedEntitySource,
} from '#worker/repo/published-source.ts'
import { formatJobError } from './schedule.ts'
import type { JobRecord, JobSourceInspection, JobView } from './types.ts'

export type PublishedJobSourceResolution = {
	source: NonNullable<PublishedEntitySource['source']>
	files: Record<string, string>
	snapshotCreatedAt: PublishedEntitySource['snapshotCreatedAt']
	artifactName: string
	entryPoint: string
	emittedEventTopics: Array<string>
	packageContext: {
		packageId: string
		kodyId: string
		sourceId: string
	}
}

export async function resolvePublishedJobSource(input: {
	env: Env
	userId: string
	job: Pick<JobRecord, 'id' | 'name' | 'sourceId'>
}): Promise<PublishedJobSourceResolution> {
	if (!input.job.sourceId) {
		throw new Error('Repo-backed job source is missing.')
	}
	const row = await getEntitySourceById(input.env.APP_DB, input.job.sourceId)
	const published = await loadPublishedEntitySource({
		env: input.env,
		userId: input.userId,
		sourceId: input.job.sourceId,
		...(row ? { source: toServingSourceView(row) } : {}),
	})
	const publishedSource = published.source
	if (!publishedSource) {
		throw new Error(`Published source "${input.job.sourceId}" was not found.`)
	}
	if (publishedSource.entity_kind !== 'package') {
		throw new Error(
			`Job "${input.job.id}" source "${input.job.sourceId}" is not a package source (ADR 0032).`,
		)
	}
	const manifestPath = publishedSource.manifest_path.replace(/^\/+/, '')
	const manifestContent = published.files[manifestPath]
	if (!manifestContent) {
		throw new Error(`Job manifest "${manifestPath}" was not found.`)
	}

	const manifest = parseAuthoredPackageJson({
		content: manifestContent,
		manifestPath,
		mode: 'published',
	})
	const jobDefinition = manifest.kody.jobs?.[input.job.name]
	if (!jobDefinition) {
		throw new Error(
			`Package "${manifest.kody.id}" does not define job "${input.job.name}".`,
		)
	}
	return {
		source: publishedSource,
		files: published.files,
		snapshotCreatedAt: published.snapshotCreatedAt,
		artifactName: input.job.name,
		entryPoint: normalizePackageWorkspacePath(jobDefinition.entry),
		emittedEventTopics: Object.keys(manifest.kody.emits ?? {}),
		packageContext: {
			packageId: publishedSource.entity_id,
			kodyId: manifest.kody.id,
			sourceId: input.job.sourceId,
		},
	}
}

function buildJobSourceInspectionError(error: unknown): JobSourceInspection {
	return {
		entrypoint: null,
		code: null,
		error: formatJobError(error),
	}
}

export async function inspectPublishedJobSource(input: {
	env: Env
	userId: string
	job: JobView
}): Promise<JobSourceInspection> {
	try {
		const resolved = await resolvePublishedJobSource({
			env: input.env,
			userId: input.userId,
			job: input.job,
		})
		const code = resolved.files[resolved.entryPoint]
		if (typeof code !== 'string') {
			return {
				entrypoint: resolved.entryPoint,
				code: null,
				error: `Job entrypoint "${resolved.entryPoint}" was not found.`,
			}
		}
		return {
			entrypoint: resolved.entryPoint,
			code,
			error: null,
		}
	} catch (error) {
		return buildJobSourceInspectionError(error)
	}
}
