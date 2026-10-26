import {
	pacedD1RetentionTierForDay,
	pacedD1SealedManifestKey,
	pacedD1StagingManifestKey,
} from '@kody-internal/shared/backup-d1-paced.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { isD1PacedBackupConfigured } from '#worker/dr/d1-paced-backup-schedule.ts'
import {
	parseD1PacedSources,
	resolvePacedD1Binding,
} from '#worker/dr/d1-paced-backup-sources.ts'

export const d1PacedStatusPath = '/__maintenance/dr-paced-status'

export type D1PacedSourceStatus = {
	binding: string
	name: string
	id: string
	bound: boolean
	stagingPresent: boolean
	sealedPresent: boolean
	stagingKey: string
	sealedKey: string
}

export type D1PacedStatusPayload = {
	ok: true
	configured: boolean
	day: string
	tier: 'daily' | 'weekly'
	sources: Array<D1PacedSourceStatus>
	stagingPresentCount: number
	sealedPresentCount: number
	boundCount: number
}

function formatUtcDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

function readBearerToken(request: Request) {
	const auth = request.headers.get('Authorization')?.trim()
	return auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
}

export async function collectD1PacedStatus(input: {
	env: Env
	now?: Date
	s3?: DrBackupS3Client
	day?: string
}): Promise<D1PacedStatusPayload> {
	const now = input.now ?? new Date()
	const day = input.day ?? formatUtcDay(now)
	const tier = pacedD1RetentionTierForDay(day)
	const configured = isD1PacedBackupConfigured(input.env)
	if (!configured) {
		return {
			ok: true,
			configured: false,
			day,
			tier,
			sources: [],
			stagingPresentCount: 0,
			sealedPresentCount: 0,
			boundCount: 0,
		}
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) {
		return {
			ok: true,
			configured: false,
			day,
			tier,
			sources: [],
			stagingPresentCount: 0,
			sealedPresentCount: 0,
			boundCount: 0,
		}
	}
	const sources = parseD1PacedSources(input.env.DR_D1_PACED_SOURCES)
	const s3 = input.s3 ?? createDrBackupS3Client(config)
	const statuses: Array<D1PacedSourceStatus> = []
	let stagingPresentCount = 0
	let sealedPresentCount = 0
	let boundCount = 0
	for (const source of sources) {
		const bound = resolvePacedD1Binding(input.env, source.binding) !== null
		if (bound) boundCount += 1
		const stagingKey = pacedD1StagingManifestKey(day, source.name)
		const sealedKey = pacedD1SealedManifestKey(tier, source.id, day)
		const [staging, sealed] = await Promise.all([
			s3.head(stagingKey),
			s3.head(sealedKey),
		])
		if (staging.exists) stagingPresentCount += 1
		if (sealed.exists) sealedPresentCount += 1
		statuses.push({
			binding: source.binding,
			name: source.name,
			id: source.id,
			bound,
			stagingPresent: staging.exists,
			sealedPresent: sealed.exists,
			stagingKey,
			sealedKey,
		})
	}
	return {
		ok: true,
		configured: true,
		day,
		tier,
		sources: statuses,
		stagingPresentCount,
		sealedPresentCount,
		boundCount,
	}
}

/**
 * Operator-facing GET (also accepts POST) returning paced staging/sealed
 * presence counts per configured source. Reuses DR_RESTORE_SECRET.
 */
export async function handleD1PacedStatusRequest(
	request: Request,
	env: Env,
	s3?: DrBackupS3Client,
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const secret = env.DR_RESTORE_SECRET?.trim()
	if (!secret) {
		return new Response('DR paced status is not configured', { status: 503 })
	}
	const bearer = readBearerToken(request)
	if (bearer === null || !(await timingSafeEqualString(bearer, secret))) {
		return new Response('Unauthorized', { status: 401 })
	}
	const url = new URL(request.url)
	const dayParam = url.searchParams.get('day')?.trim()
	try {
		const payload = await collectD1PacedStatus({
			env,
			s3,
			...(dayParam ? { day: dayParam } : {}),
		})
		return Response.json(payload)
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		)
	}
}
