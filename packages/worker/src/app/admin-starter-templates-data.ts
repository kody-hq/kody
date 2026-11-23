import {
	AppStarterError,
	type AppStarterInspection,
	inspectAppStarterCandidate,
	listAdminAppStarters,
	listAppStarterCandidates,
} from '#worker/app-starters/service.ts'
import type { AdminStarterTemplatesLoaderData } from '#universal/loader-data.ts'

function previewUrlFor(inspection: AppStarterInspection) {
	const preview = inspection.checks.find((check) => check.id === 'preview')
	if (!preview?.ok || !inspection.listingId) return null
	const path = preview.detail
		.replace(/^\.\//, '')
		.split('/')
		.map(encodeURIComponent)
		.join('/')
	return `/community/${encodeURIComponent(inspection.listingId)}/raw/${path}`
}

export async function loadAdminStarterTemplatesData(
	env: Env,
	input: { candidatePackage?: string | null } = {},
): Promise<AdminStarterTemplatesLoaderData> {
	const [entries, candidates] = await Promise.all([
		listAdminAppStarters(env),
		listAppStarterCandidates(env).catch(() => []),
	])
	let candidate: AdminStarterTemplatesLoaderData['candidate'] = null
	let candidateError: string | null = null
	if (input.candidatePackage) {
		try {
			const inspection = await inspectAppStarterCandidate(
				env,
				input.candidatePackage,
			)
			candidate = {
				packageName: inspection.packageName,
				checks: inspection.checks,
				previewPath: inspection.starter?.preview ?? null,
				previewUrl: previewUrlFor(inspection),
				canAdd: inspection.problems.length === 0,
			}
		} catch (error) {
			if (!(error instanceof AppStarterError)) throw error
			candidateError = error.message
		}
	}
	return {
		ok: true,
		starters: entries.map((entry) => ({
			packageId: entry.packageId,
			packageName: entry.packageName,
			rank: entry.rank,
			enabled: entry.enabled,
			note: entry.note,
			updatedAt: entry.updatedAt,
			name: entry.starter?.name ?? entry.packageName,
			description: entry.starter?.description ?? '',
			tags: entry.starter?.tags ?? [],
			previewUrl: previewUrlFor(entry),
			status: entry.problems.length === 0 ? 'ready' : 'failed',
		})),
		candidates,
		candidate,
		candidateError,
	}
}
