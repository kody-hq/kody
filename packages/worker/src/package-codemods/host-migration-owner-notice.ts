import {
	buildPackageAppHostOrigin,
	buildPackageAppSubdomainUrl,
	isProfilePackage,
} from '@kody-internal/shared/public-urls.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { renderTransactionalEmail } from '#app/email/template.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import {
	detectPackageAppHostMigrationCodemodId,
	packageAppHostMigrationPatternFromMessage,
	type PackageAppHostMigrationPattern,
} from './codemods/0019-detect-package-app-host-migration.ts'
import { getPackageScopeByUserId } from '#worker/package-registry/user-scope.ts'
import { packageAppHostMigrationAgentPrompt } from './host-migration-agent-prompt.ts'
import {
	getPackageCodemodRunById,
	listPackageCodemodRunItems,
	type PackageCodemodRunItemRecord,
} from './ledger.ts'
import {
	PackageOwnerNoticeError,
	noticeOneOwner,
	packageOwnerNoticeDefaultLimit,
	packageOwnerNoticeIdPattern,
	packageOwnerNoticeMaxLimit,
	type PackageOwnerNoticeRecipient,
	type PackageOwnerNoticeStatus,
} from './owner-notice.ts'

/**
 * Owner email for the package app host migration: each app moves from
 * `{user}.kody.run/{app}` to `{app}--{user}.kody.run`. Recipients and the
 * per-app list come from a `0019-detect-package-app-host-migration` scan run.
 * The wording is approved text; change it only with a new approval.
 */

export const packageAppHostMigrationNoticeKinds = [
	'announce',
	'reminder',
] as const
export type PackageAppHostMigrationNoticeKind =
	(typeof packageAppHostMigrationNoticeKinds)[number]

/** Why an app is in the email. `outside` alone does not select a recipient. */
export type PackageAppHostMigrationNoticeCategory =
	| 'browserData'
	| 'addressCode'
	| 'outsideRequests'

const patternCategories: Partial<
	Record<PackageAppHostMigrationPattern, PackageAppHostMigrationNoticeCategory>
> = {
	localStorage: 'browserData',
	indexedDB: 'browserData',
	'cache storage': 'browserData',
	'service worker': 'browserData',
	'hardcoded mount path': 'addressCode',
	'build-time base': 'addressCode',
	'cookie path': 'addressCode',
	'cookie domain': 'addressCode',
	'origin check': 'addressCode',
	'web app manifest': 'addressCode',
	'list-unsubscribe': 'outsideRequests',
	'oauth form_post': 'outsideRequests',
	'oauth redirect uri': 'outsideRequests',
	'webhook receiver': 'outsideRequests',
}

const outsideDescriptions: Partial<
	Record<PackageAppHostMigrationPattern, string>
> = {
	'list-unsubscribe': 'unsubscribe links in email it sends',
	'oauth form_post': 'an OAuth sign-in callback',
	'oauth redirect uri': 'an OAuth sign-in callback',
	'webhook receiver': 'a webhook receiver',
}

export type PackageAppHostMigrationNoticeApp = {
	packageId: string
	name: string
	oldUrl: string
	newUrl: string
	categories: Array<PackageAppHostMigrationNoticeCategory>
	/** What was found that outside services call, in words. */
	outside: Array<string>
}

type CategoryCount = { owners: number; apps: number }

export type PackageAppHostMigrationNoticeTotals = {
	/** Owners that get the email, and their listed apps. */
	recipients: CategoryCount
	byCategory: Record<PackageAppHostMigrationNoticeCategory, CategoryCount>
	/** Owners whose apps only have outside-request findings: not emailed. */
	outsideOnly: CategoryCount
	/** Apps with no `{app}--{user}` host (profile packages, invalid labels). */
	appsWithoutNewHost: number
}

export type PackageAppHostMigrationNoticeOwner = {
	ownerId: string
	status: PackageOwnerNoticeStatus
	recipientCount: number
	apps: Array<PackageAppHostMigrationNoticeApp>
}

export type PackageAppHostMigrationNoticeResult = {
	runId: string
	noticeId: string
	kind: PackageAppHostMigrationNoticeKind
	dryRun: boolean
	totals: PackageAppHostMigrationNoticeTotals
	owners: Array<PackageAppHostMigrationNoticeOwner>
	summary: Partial<Record<PackageOwnerNoticeStatus, number>>
	/** Rendered email for the first owner on this page (dry run only). */
	preview: { subject: string; text: string } | null
	nextCursor: string | null
}

const maxRunItemsRead = 10_000
const runItemsPageSize = 200
const packageNameLookupChunk = 50

function classifyItem(item: PackageCodemodRunItemRecord) {
	const patterns = new Set<PackageAppHostMigrationPattern>()
	for (const finding of item.findings) {
		const pattern = packageAppHostMigrationPatternFromMessage(finding.message)
		if (pattern) patterns.add(pattern)
	}
	// A declared Kody webhook is delivered on the Kody webhook address, which
	// does not change, so a receiver match in that package is not counted.
	if (patterns.has('declared kody webhook')) patterns.delete('webhook receiver')
	const categories = new Set<PackageAppHostMigrationNoticeCategory>()
	// The ledger stores at most 50 findings per app. A cut list may have lost
	// the findings that select a recipient, so the owner is told anyway.
	if (item.findings.some((finding) => finding.message.startsWith('…truncated')))
		categories.add('addressCode')
	const outside = new Set<string>()
	for (const pattern of patterns) {
		const category = patternCategories[pattern]
		if (category) categories.add(category)
		const description = outsideDescriptions[pattern]
		if (description) outside.add(description)
	}
	return { categories: [...categories].sort(), outside: [...outside].sort() }
}

/** Current name and owner: an app transferred after the scan follows its new owner. */
async function loadLivePackages(db: D1Database, packageIds: Array<string>) {
	const packages = new Map<string, { name: string; userId: string }>()
	for (
		let index = 0;
		index < packageIds.length;
		index += packageNameLookupChunk
	) {
		const chunk = packageIds.slice(index, index + packageNameLookupChunk)
		const { results } = await db
			.prepare(
				`SELECT id, name, user_id FROM saved_packages WHERE id IN (${chunk.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
			)
			.bind(...chunk)
			.all<{ id: string; name: string; user_id: string }>()
		for (const row of results)
			packages.set(row.id, { name: row.name, userId: row.user_id })
	}
	return packages
}

async function loadAppsByOwner(input: {
	db: D1Database
	runId: string
	packageAppOrigin: string
}) {
	const items: Array<PackageCodemodRunItemRecord> = []
	let afterId: string | null = null
	for (;;) {
		const page: Array<PackageCodemodRunItemRecord> =
			await listPackageCodemodRunItems(input.db, {
				runId: input.runId,
				afterId,
				limit: runItemsPageSize,
			})
		items.push(...page)
		if (items.length > maxRunItemsRead) {
			throw new PackageOwnerNoticeError(
				`Run has more than ${maxRunItemsRead} items; filter the scan before sending a notice.`,
			)
		}
		if (page.length < runItemsPageSize) break
		afterId = page.at(-1)!.id
	}
	const classified = items
		.map((item) => ({ item, ...classifyItem(item) }))
		.filter((entry) => entry.categories.length > 0)
	const packages = await loadLivePackages(
		input.db,
		classified.map((entry) => entry.item.packageId),
	)
	const scopes = new Map<string, string | null>()
	const byOwner = new Map<string, Array<PackageAppHostMigrationNoticeApp>>()
	let appsWithoutNewHost = 0
	for (const { item, categories, outside } of classified) {
		const live = packages.get(item.packageId)
		if (!live) continue
		const ownerId = live.userId
		if (!scopes.has(ownerId)) {
			scopes.set(
				ownerId,
				await getPackageScopeByUserId(input.db, ownerId).catch(() => null),
			)
		}
		const username = scopes.get(ownerId)
		const kodyId = live.name.slice(live.name.indexOf('/') + 1)
		if (!username || !kodyId) continue
		const name = `@${username}/${kodyId}`
		const newOrigin = isProfilePackage({ username, kodyId: kodyId! })
			? null
			: buildPackageAppHostOrigin({
					packageAppOrigin: input.packageAppOrigin,
					username,
					kodyId,
				})
		if (!newOrigin) {
			appsWithoutNewHost += 1
			continue
		}
		const apps = byOwner.get(ownerId) ?? []
		apps.push({
			packageId: item.packageId,
			name,
			oldUrl: `${buildPackageAppSubdomainUrl({
				packageAppOrigin: input.packageAppOrigin,
				username,
				kodyId,
			})}/`,
			newUrl: `${newOrigin}/`,
			categories,
			outside,
		})
		byOwner.set(ownerId, apps)
	}
	for (const apps of byOwner.values()) {
		apps.sort((left, right) => left.name.localeCompare(right.name))
	}
	return { byOwner, appsWithoutNewHost }
}

function isListedApp(app: PackageAppHostMigrationNoticeApp) {
	return (
		app.categories.includes('browserData') ||
		app.categories.includes('addressCode')
	)
}

function countTotals(input: {
	byOwner: Map<string, Array<PackageAppHostMigrationNoticeApp>>
	appsWithoutNewHost: number
}): PackageAppHostMigrationNoticeTotals {
	const empty = (): CategoryCount => ({ owners: 0, apps: 0 })
	const totals: PackageAppHostMigrationNoticeTotals = {
		recipients: empty(),
		byCategory: {
			browserData: empty(),
			addressCode: empty(),
			outsideRequests: empty(),
		},
		outsideOnly: empty(),
		appsWithoutNewHost: input.appsWithoutNewHost,
	}
	for (const apps of input.byOwner.values()) {
		const listed = apps.filter(isListedApp)
		if (listed.length === 0) {
			totals.outsideOnly.owners += 1
			totals.outsideOnly.apps += apps.length
			continue
		}
		totals.recipients.owners += 1
		totals.recipients.apps += listed.length
		for (const category of [
			'browserData',
			'addressCode',
			'outsideRequests',
		] as const) {
			const count = apps.filter((app) =>
				app.categories.includes(category),
			).length
			if (count === 0) continue
			totals.byCategory[category].owners += 1
			totals.byCategory[category].apps += count
		}
	}
	return totals
}

function appLine(app: PackageAppHostMigrationNoticeApp) {
	return `${app.name}: old ${app.oldUrl}, new ${app.newUrl}`
}

function fillPrompt(input: {
	apps: Array<PackageAppHostMigrationNoticeApp>
	cutoverDate: string
}) {
	const [, username, kodyId] = /^@([^/]+)\/([^/]+)$/.exec(input.apps[0]!.name)!
	const prompt = packageAppHostMigrationAgentPrompt
		.replaceAll('{owner}', username!)
		.replaceAll('{username}', username!)
		.replaceAll('{cutover date}', input.cutoverDate)
	return input.apps.length === 1 ? prompt.replaceAll('{app}', kodyId!) : prompt
}

export function buildPackageAppHostMigrationNoticeEmail(input: {
	appBaseUrl: string
	kind: PackageAppHostMigrationNoticeKind
	recipientName: string
	apps: Array<PackageAppHostMigrationNoticeApp>
	cutoverDate: string
	reminderDate: string
}) {
	const listed = input.apps.filter(isListedApp)
	const outside = input.apps.filter((app) => app.outside.length > 0)
	const username = /^@([^/]+)\//.exec(listed[0]!.name)![1]!
	const greeting = input.recipientName ? `Hi ${input.recipientName},` : 'Hi,'
	const visitLine = `Each person's browser has to open your app at the old address at least once after the update ships, before ${input.cutoverDate}, for their data to move. If other people use your app, tell them.`
	const outsideList = outside
		.map((app) => `${app.name} (${app.outside.join(', ')})`)
		.join('; ')
	const promptBlocks = [
		...(listed.length > 1
			? [
					"Paste the prompt once per app. Before pasting, replace {app} with that app's name (the part after the slash).",
				]
			: []),
		{
			kind: 'code' as const,
			text: fillPrompt({ apps: listed, cutoverDate: input.cutoverDate }),
		},
	]
	const footnote =
		"You're receiving this because you own a Kody package app that is moving to its own address."
	if (input.kind === 'reminder') {
		const subject = `One week left: your Kody apps move on ${input.cutoverDate}`
		return renderTransactionalEmail({
			appBaseUrl: input.appBaseUrl,
			subject,
			preheader: `On ${input.cutoverDate} the old addresses of your Kody apps only redirect to the new ones.`,
			heading: subject,
			body: [
				greeting,
				`A reminder that on ${input.cutoverDate} the old addresses of your Kody apps stop serving and only redirect to the new ones. Browser data saved under the old address cannot be read after that date.`,
				'Apps of yours that store data in the browser or have code tied to the old address:',
				...listed.map(appLine),
				visitLine,
				...(outside.length > 0
					? [
							`Apps of yours that receive requests from outside services at the old address: ${outsideList}.`,
						]
					: []),
				'If you have already shipped the move, or the data does not matter, there is nothing to do. Otherwise the prompt from our first email is repeated below.',
				'The Kody team',
			],
			afterAction: promptBlocks,
			footnote,
		})
	}
	const subject =
		'Your Kody apps are moving to their own addresses. Action needed to keep browser data'
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject,
		preheader: `Each Kody package app is getting its own address. The old address stops serving on ${input.cutoverDate}.`,
		heading: subject,
		body: [
			greeting,
			"Each Kody package app is getting its own address. Instead of https://{username}.kody.run/{app}/, your app will live at https://{app}--{username}.kody.run/. This gives every app its own browser origin, so your apps can no longer read each other's cookies or stored data.",
			'What stays the same: old links keep working. They redirect to the new address.',
			"What needs you: anything your app saved in the browser (localStorage, IndexedDB, cookies your app sets, and offline caches or service workers) is tied to the old address and will not follow the app. Data your app keeps on Kody's servers is not affected. Only data saved in visitors' browsers is. These apps of yours need a look, because they store data in the browser or have code tied to the old address:",
			...listed.map(appLine),
			`Both addresses work today. On ${input.cutoverDate} the old address stops serving your app for good and only redirects to the new one. This date is fixed and applies to every app. After it, data saved under the old address can no longer be read. If your app keeps data there that people would miss, add a one-time move before ${input.cutoverDate}. The prompt below does it, and it also fixes code tied to the old address. Paste it to your coding agent once per app.`,
			visitLine,
			'If people installed your app to a home screen or desktop, they will need to reinstall it from the new address.',
			"If the data is only a cache or can be rebuilt, the prompt's second step stops early and only the address fixes ship.",
			`If an old link must keep answering in place: redirects cover normal links, but some callers do not follow them (one-click unsubscribe buttons in mail you already sent, webhooks, some sign-in callbacks). To keep those working, create a package named @${username}/${username}. Once it is published, it owns every path on https://${username}.kody.run/ (except Kody's reserved /-/ paths) and Kody stops redirecting there, so your package decides what every old path does. It is a normal app, and you only need it if a redirect is not enough.`,
			...(outside.length > 0
				? [
						`Also before ${input.cutoverDate}: these apps receive requests from outside services at the old address: ${outsideList}. Redirects do not reliably carry those. Update the registered URL at each service (OAuth redirect URIs, webhook URLs) to the new address, and make sure any email your app sends uses the new address for unsubscribe links. The new address already works, so you can do this today.`,
					]
				: []),
			`We will send one reminder on ${input.reminderDate}.`,
			'Questions: reply to this email.',
			'The Kody team',
		],
		afterAction: promptBlocks,
		footnote,
	})
}

export async function runPackageAppHostMigrationNotice(input: {
	env: Env
	runId: string
	noticeId: string
	kind: PackageAppHostMigrationNoticeKind
	cutoverDate: string
	reminderDate: string
	dryRun: boolean
	cursor?: string | null
	limit?: number | null
}): Promise<PackageAppHostMigrationNoticeResult> {
	if (!packageOwnerNoticeIdPattern.test(input.noticeId)) {
		throw new PackageOwnerNoticeError(
			'noticeId must be 3-80 lowercase letters, digits, or dashes (for example "2026-12-app-hosts").',
		)
	}
	const run = await getPackageCodemodRunById(input.env.APP_DB, input.runId)
	if (!run) {
		throw new PackageOwnerNoticeError(`Codemod run ${input.runId} not found.`)
	}
	if (
		run.mode !== 'scan' ||
		run.codemodId !== detectPackageAppHostMigrationCodemodId
	) {
		throw new PackageOwnerNoticeError(
			`Codemod run ${run.id} is a ${run.mode} of ${run.codemodId}. This notice needs a scan run of ${detectPackageAppHostMigrationCodemodId}.`,
		)
	}
	if (!input.dryRun && run.status !== 'completed') {
		throw new PackageOwnerNoticeError(
			`Codemod run ${run.id} is ${run.status}. Send a notice only from a completed scan; a dry run can preview a scan in progress.`,
		)
	}
	const cutoverDate = input.cutoverDate.trim()
	const reminderDate = input.reminderDate.trim()
	if (!cutoverDate || !reminderDate) {
		throw new PackageOwnerNoticeError(
			'cutoverDate and reminderDate are required; the email states both.',
		)
	}
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	const packageAppOrigin = getPackageAppBaseUrl({ env: input.env })
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!emailConfig || !packageAppOrigin) {
		throw new PackageOwnerNoticeError(
			'Transactional email and the package app origin must be configured to render this notice.',
		)
	}
	if (!input.dryRun && !kv) {
		throw new PackageOwnerNoticeError(
			'BUNDLE_ARTIFACTS_KV is required to claim notices so owners are emailed once.',
		)
	}

	const loaded = await loadAppsByOwner({
		db: input.env.APP_DB,
		runId: run.id,
		packageAppOrigin,
	})
	const totals = countTotals(loaded)
	const limit = Math.min(
		Math.max(input.limit ?? packageOwnerNoticeDefaultLimit, 1),
		packageOwnerNoticeMaxLimit,
	)
	const remaining = [...loaded.byOwner.entries()]
		.filter(([, apps]) => apps.some(isListedApp))
		.map(([ownerId]) => ownerId)
		.sort()
		.filter((ownerId) => !input.cursor || ownerId > input.cursor)
	const page = remaining.slice(0, limit)

	const owners: Array<PackageAppHostMigrationNoticeOwner> = []
	const summary: Partial<Record<PackageOwnerNoticeStatus, number>> = {}
	let preview: PackageAppHostMigrationNoticeResult['preview'] = null
	for (const ownerId of page) {
		const apps = loaded.byOwner.get(ownerId)!
		const status = await noticeOneOwner({
			env: input.env,
			kv,
			emailConfig,
			noticeId: input.noticeId,
			ownerId,
			buildEmail: (recipient: PackageOwnerNoticeRecipient) =>
				buildPackageAppHostMigrationNoticeEmail({
					appBaseUrl: emailConfig.appBaseUrl,
					kind: input.kind,
					recipientName: recipient.name,
					apps,
					cutoverDate,
					reminderDate,
				}),
			dryRun: input.dryRun,
			onPreview: (email) => {
				preview ??= { subject: email.subject, text: email.text }
			},
		})
		owners.push({ ownerId, apps, ...status })
		summary[status.status] = (summary[status.status] ?? 0) + 1
	}

	return {
		runId: run.id,
		noticeId: input.noticeId,
		kind: input.kind,
		dryRun: input.dryRun,
		totals,
		owners,
		summary,
		preview,
		nextCursor: remaining.length > page.length ? (page.at(-1) ?? null) : null,
	}
}
