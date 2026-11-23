import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { getOrgBySlug } from '#worker/orgs/repo.ts'
import {
	getSavedPackageByName,
	listSavedPackagesByIds,
	listSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { loadPublishedEntitySource } from '#worker/repo/published-source.ts'
import {
	type AppStarterFieldError,
	type AppStarterManifest,
	validateAppStarterManifest,
} from './manifest.ts'
import {
	type AppStarterRow,
	deleteAppStarterRow,
	insertAppStarterRow,
	listAppStarterRows,
	saveAppStarterRows,
} from './repo.ts'
import { readSharedTokenUsage } from './shared-tokens.ts'

/** Starters are ordinary packages owned by this org. */
export const appStarterOrgSlug = 'kody'

export const maxAppStarterNoteLength = 500

export type AppStarterCheck = {
	id: string
	label: string
	ok: boolean
	detail: string
}

export type AppStarterInspection = {
	packageId: string
	packageName: string
	updatedAt: string
	listingId: string | null
	starter: AppStarterManifest | null
	checks: Array<AppStarterCheck>
	problems: Array<AppStarterFieldError>
}

export type AppStarterEntry = AppStarterInspection & {
	rank: number
	enabled: boolean
	note: string | null
}

export class AppStarterError extends Error {
	readonly status: 400 | 404 | 409
	readonly fieldErrors: Array<AppStarterFieldError>
	constructor(
		message: string,
		status: 400 | 404 | 409,
		fieldErrors: Array<AppStarterFieldError> = [],
	) {
		super(message)
		this.name = 'AppStarterError'
		this.status = status
		this.fieldErrors = fieldErrors
	}
}

const manifestFields = [
	'name',
	'description',
	'whenToUse',
	'tags',
	'preview',
	'capabilities',
	'customize.themeTokens',
	'customize.routes',
	'customize.content',
] as const

const missingFieldDetail = 'Missing from the kody.starter key in package.json.'

async function loadStarterOrg(env: Env) {
	const org = await getOrgBySlug(env.APP_DB, appStarterOrgSlug)
	if (!org) {
		throw new AppStarterError(
			`The @${appStarterOrgSlug} org was not found.`,
			404,
		)
	}
	return org
}

function parseStarterPackageName(packageRef: string) {
	const match = /^(?:@([^/\s]+)\/)?([^/\s@]+)$/.exec(packageRef.trim())
	if (!match) {
		throw new AppStarterError(
			`Enter a package as @${appStarterOrgSlug}/package-name.`,
			400,
		)
	}
	const scope = (match[1] ?? appStarterOrgSlug).toLowerCase()
	if (scope !== appStarterOrgSlug) {
		throw new AppStarterError(
			`Starters are packages in the @${appStarterOrgSlug} org. Enter @${appStarterOrgSlug}/${match[2]}.`,
			400,
		)
	}
	return `@${appStarterOrgSlug}/${match[2]!.toLowerCase()}`
}

function readPath(value: unknown, path: string) {
	let current = value
	for (const key of path.split('.')) {
		if (!current || typeof current !== 'object') return undefined
		current = (current as Record<string, unknown>)[key]
	}
	return current
}

function describeValue(value: unknown) {
	return Array.isArray(value) ? value.join(', ') : String(value)
}

function hasPackagePath(files: Record<string, string>, path: string) {
	const normalized = path.replace(/^\.\//, '').replace(/\/+$/, '')
	return (
		Object.hasOwn(files, normalized) ||
		Object.keys(files).some((file) => file.startsWith(`${normalized}/`))
	)
}

function manifestChecks(input: {
	packageJson: unknown
	files: Record<string, string> | null
}) {
	const result = validateAppStarterManifest(input.packageJson)
	const starterValue = readPath(input.packageJson, 'kody.starter')
	const errors = result.ok ? [] : result.fieldErrors
	const checks: Array<AppStarterCheck> = manifestFields.map((field) => {
		const value = readPath(starterValue, field)
		const error = errors.find(
			(entry) =>
				entry.field === `kody.starter.${field}` ||
				entry.field.startsWith(`kody.starter.${field}.`),
		)
		if (value === undefined) {
			return { id: field, label: field, ok: false, detail: missingFieldDetail }
		}
		if (error) {
			return { id: field, label: field, ok: false, detail: error.message }
		}
		return { id: field, label: field, ok: true, detail: describeValue(value) }
	})
	const extraKeys = errors.filter(
		(entry) =>
			!manifestFields.some(
				(field) =>
					entry.field === `kody.starter.${field}` ||
					entry.field.startsWith(`kody.starter.${field}.`),
			) && entry.field !== 'kody.starter',
	)
	for (const extra of extraKeys) {
		checks.push({
			id: extra.field,
			label: extra.field.replace(/^kody\.starter\./, ''),
			ok: false,
			detail: extra.message,
		})
	}
	if (input.files) {
		for (const check of checks) {
			if (!check.ok) continue
			if (check.id === 'preview' || check.id.startsWith('customize.')) {
				if (!hasPackagePath(input.files, check.detail)) {
					check.ok = false
					check.detail = `${check.detail} was not found in the package.`
				}
			}
		}
	}
	return { starter: result.ok ? result.starter : null, checks }
}

/** Reads the published package and checks it against the starter contract. */
async function inspectStarterPackage(
	env: Env,
	savedPackage: SavedPackageRecord,
	options: { checkFiles: boolean } = { checkFiles: true },
): Promise<AppStarterInspection> {
	let files: Record<string, string> | null = null
	let packageJson: unknown = null
	try {
		const published = await loadPublishedEntitySource({
			env,
			userId: savedPackage.userId,
			sourceId: savedPackage.sourceId,
		})
		files = published.files
		packageJson = JSON.parse(published.files['package.json'] ?? 'null')
	} catch (error) {
		console.error('app-starter-source-read-failed', {
			packageId: savedPackage.id,
			error,
		})
		packageJson = null
	}
	const { starter, checks } = manifestChecks({
		packageJson,
		files: options.checkFiles ? files : null,
	})
	checks.push(
		savedPackage.hasApp
			? {
					id: 'appEntry',
					label: 'Package app entry',
					ok: true,
					detail: 'This is a package app with an app entry.',
				}
			: {
					id: 'appEntry',
					label: 'Package app entry',
					ok: false,
					detail: 'Add kody.app.entry so this package serves an app.',
				},
	)
	if (options.checkFiles) {
		const themePath = starter?.customize.themeTokens.replace(/^\.\//, '')
		const css = themePath && files ? files[themePath] : undefined
		const usage = css === undefined ? null : readSharedTokenUsage(css)
		const tokensOk =
			usage !== null && usage.missing.length === 0 && usage.hasDark
		checks.push({
			id: 'tokens',
			label: 'Shared CSS tokens',
			ok: tokensOk,
			detail: tokensOk
				? 'Uses the shared CSS custom property names.'
				: usage && usage.missing.length > 0
					? `The theme file does not use the shared token names. Add ${usage.missing.join(', ')}.`
					: usage
						? 'The theme file does not set dark values for the shared token names.'
						: 'The theme file does not use the shared token names.',
		})
		const themeCheck = checks.find(
			(check) => check.id === 'customize.themeTokens',
		)
		if (themeCheck?.ok && !tokensOk) {
			themeCheck.ok = false
			themeCheck.detail = `${themeCheck.detail} does not use the shared CSS custom property names.`
		}
	}
	const listing = await getCommunityListingByOwnerAndPackage(env.APP_DB, {
		ownerUserId: savedPackage.userId,
		packageId: savedPackage.id,
	})
	const listingId = listing?.status === 'active' ? listing.id : null
	checks.push({
		id: 'listing',
		label: 'Public listing',
		ok: listingId !== null,
		detail: listingId
			? 'Listed publicly, so agents can fork it.'
			: 'List the package publicly so agents can fork it.',
	})
	return {
		packageId: savedPackage.id,
		packageName: savedPackage.name,
		updatedAt: savedPackage.updatedAt,
		listingId,
		starter,
		checks,
		problems: checks
			.filter((check) => !check.ok)
			.map((check) => ({ field: check.label, message: check.detail })),
	}
}

async function loadEntries(
	env: Env,
	rows: Array<AppStarterRow>,
	options: { checkFiles: boolean },
): Promise<Array<AppStarterEntry>> {
	if (rows.length === 0) return []
	const org = await loadStarterOrg(env)
	const packages = await listSavedPackagesByIds(env.APP_DB, {
		userId: org.id,
		packageIds: rows.map((row) => row.packageId),
	})
	const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]))
	return Promise.all(
		rows.map(async (row): Promise<AppStarterEntry> => {
			const savedPackage = packagesById.get(row.packageId)
			if (savedPackage) {
				return {
					...row,
					...(await inspectStarterPackage(env, savedPackage, options)),
				}
			}
			const check = {
				id: 'package',
				label: 'package',
				ok: false,
				detail: `The package is no longer in the @${appStarterOrgSlug} org.`,
			}
			return {
				...row,
				packageName: row.packageId,
				updatedAt: '',
				listingId: null,
				starter: null,
				checks: [check],
				problems: [{ field: check.label, message: check.detail }],
			}
		}),
	)
}

/** Every starter on the list. A starter that stops passing stays, marked failed. */
export async function listAdminAppStarters(env: Env) {
	return loadEntries(env, await listAppStarterRows(env.APP_DB), {
		checkFiles: true,
	})
}

/** Enabled starters in rank order whose package still meets the starter contract. */
export async function listRecommendedAppStarters(
	env: Env,
	input: { limit?: number; budgetMs?: number } = {},
) {
	const limit = input.limit ?? 5
	const deadline = performance.now() + (input.budgetMs ?? Infinity)
	const rows = await withinMs(
		listAppStarterRows(env.APP_DB, { enabledOnly: true }),
		deadline - performance.now(),
	)
	if (!rows) return []
	const recommended: Array<AppStarterEntry & { starter: AppStarterManifest }> =
		[]
	for (
		let start = 0;
		start < rows.length && recommended.length < limit;
		start += limit
	) {
		const entries = await withinMs(
			loadEntries(env, rows.slice(start, start + limit), {
				checkFiles: true,
			}).catch((error: unknown) => {
				console.error('app-starters-recommendation-batch-failed', error)
				return null
			}),
			deadline - performance.now(),
		)
		// Out of time or failed: keep the starters already validated.
		if (!entries) break
		recommended.push(
			...entries.filter(
				(entry): entry is AppStarterEntry & { starter: AppStarterManifest } =>
					entry.starter !== null && entry.problems.length === 0,
			),
		)
	}
	return recommended.slice(0, limit)
}

/** @kody packages an admin can still add, newest first. */
export async function listAppStarterCandidates(env: Env) {
	const org = await loadStarterOrg(env)
	const [packages, rows] = await Promise.all([
		listSavedPackagesByUserId(env.APP_DB, { userId: org.id }),
		listAppStarterRows(env.APP_DB),
	])
	const listed = new Set(rows.map((row) => row.packageId))
	return packages
		.filter((pkg) => !listed.has(pkg.id))
		.map((pkg) => ({ packageName: pkg.name, kodyId: pkg.kodyId }))
}

async function findStarterPackage(env: Env, packageRef: string) {
	const packageName = parseStarterPackageName(packageRef)
	const org = await loadStarterOrg(env)
	const savedPackage = await getSavedPackageByName(env.APP_DB, {
		userId: org.id,
		name: packageName,
	})
	if (!savedPackage) {
		throw new AppStarterError(`${packageName} was not found.`, 404)
	}
	return savedPackage
}

/** The add form's checklist for one candidate package. */
export async function inspectAppStarterCandidate(env: Env, packageRef: string) {
	return inspectStarterPackage(env, await findStarterPackage(env, packageRef))
}

function normalizeNote(note: string | null | undefined) {
	const trimmed = note?.trim() ?? ''
	if (trimmed.length > maxAppStarterNoteLength) {
		throw new AppStarterError(
			`Keep the note under ${String(maxAppStarterNoteLength)} characters.`,
			400,
		)
	}
	return trimmed || null
}

/** Only rows whose settings changed, so a save never rewrites another admin's edit. */
function changedRows(
	before: Array<AppStarterRow>,
	after: Array<AppStarterRow>,
) {
	const previous = new Map(before.map((row) => [row.packageId, row]))
	return after.filter((row) => {
		const prior = previous.get(row.packageId)
		return (
			!prior ||
			prior.rank !== row.rank ||
			prior.enabled !== row.enabled ||
			prior.note !== row.note
		)
	})
}

function placeAtRank(
	rows: Array<AppStarterRow>,
	packageId: string,
	rank: number | undefined,
) {
	const ordered = [...rows]
	if (rank !== undefined) {
		const from = ordered.findIndex((row) => row.packageId === packageId)
		const [moved] = ordered.splice(from, 1)
		const to = Math.min(Math.max(Math.trunc(rank), 1), ordered.length + 1) - 1
		ordered.splice(to, 0, moved!)
	}
	return ordered.map((row, index) => ({ ...row, rank: index + 1 }))
}

/** Adds a published @kody package after every starter check passes. */
export async function addAppStarter(input: {
	env: Env
	packageRef: string
	note?: string | null
	enabled?: boolean
	rank?: number
}) {
	const note = normalizeNote(input.note)
	const savedPackage = await findStarterPackage(input.env, input.packageRef)
	const rows = await listAppStarterRows(input.env.APP_DB)
	if (rows.some((row) => row.packageId === savedPackage.id)) {
		throw new AppStarterError(`${savedPackage.name} is already a starter.`, 409)
	}
	const { problems } = await inspectStarterPackage(input.env, savedPackage)
	if (problems.length > 0) {
		throw new AppStarterError(
			`${savedPackage.name} is not a valid starter. Fix these fields:\n${problems
				.map((problem) => `${problem.field}: ${problem.message}`)
				.join('\n')}`,
			400,
			problems,
		)
	}
	const row: AppStarterRow = {
		packageId: savedPackage.id,
		rank: (rows.at(-1)?.rank ?? 0) + 1,
		enabled: input.enabled ?? true,
		note,
	}
	await insertAppStarterRow(input.env.APP_DB, row)
	if (input.rank !== undefined && input.rank < row.rank) {
		await saveAppStarterRows(
			input.env.APP_DB,
			changedRows(
				[...rows, row],
				placeAtRank([...rows, row], row.packageId, input.rank),
			),
		)
	}
	return listAdminAppStarters(input.env)
}

/** Moves, enables, disables, or re-notes a starter. Ranks stay 1..n. */
export async function updateAppStarter(input: {
	env: Env
	packageId: string
	rank?: number
	enabled?: boolean
	note?: string | null
}) {
	const rows = await listAppStarterRows(input.env.APP_DB)
	const current = rows.find((row) => row.packageId === input.packageId)
	if (!current)
		throw new AppStarterError('That starter is not on the list.', 404)
	const note =
		input.note === undefined ? current.note : normalizeNote(input.note)
	const updated = rows.map((row) =>
		row.packageId === input.packageId
			? { ...row, enabled: input.enabled ?? row.enabled, note }
			: row,
	)
	await saveAppStarterRows(
		input.env.APP_DB,
		changedRows(rows, placeAtRank(updated, input.packageId, input.rank)),
	)
	return listAdminAppStarters(input.env)
}

/** Saves a full new order. Every listed starter must appear exactly once. */
export async function reorderAppStarters(input: {
	env: Env
	packageIds: Array<string>
}) {
	const rows = await listAppStarterRows(input.env.APP_DB)
	const byId = new Map(rows.map((row) => [row.packageId, row]))
	const unique = new Set(input.packageIds)
	if (
		unique.size !== input.packageIds.length ||
		unique.size !== rows.length ||
		input.packageIds.some((id) => !byId.has(id))
	) {
		throw new AppStarterError(
			'The starter list changed. Reload and try again.',
			409,
		)
	}
	await saveAppStarterRows(
		input.env.APP_DB,
		changedRows(
			rows,
			input.packageIds.map((id, index) => ({
				...byId.get(id)!,
				rank: index + 1,
			})),
		),
	)
	return listAdminAppStarters(input.env)
}

/** Takes a package off the list. The package itself is untouched. */
export async function removeAppStarter(input: { env: Env; packageId: string }) {
	const rows = await listAppStarterRows(input.env.APP_DB)
	if (!rows.some((row) => row.packageId === input.packageId)) {
		throw new AppStarterError('That starter is not on the list.', 404)
	}
	await deleteAppStarterRow(input.env.APP_DB, input.packageId)
	const remaining = rows.filter((row) => row.packageId !== input.packageId)
	await saveAppStarterRows(
		input.env.APP_DB,
		changedRows(remaining, placeAtRank(remaining, input.packageId, undefined)),
	)
	return listAdminAppStarters(input.env)
}

function withinMs<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	if (ms === Infinity) return promise
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		promise,
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), Math.max(0, ms))
		}),
	]).finally(() => clearTimeout(timer))
}
