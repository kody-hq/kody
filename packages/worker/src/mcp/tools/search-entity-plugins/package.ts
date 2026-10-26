import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { listingAheadSearchNotice } from '#universal/community-listing-ahead.ts'
import {
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
} from '#worker/vectorize/embedding.ts'
import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	lexicalScore,
	reciprocalRankFusion,
	sortIdsByScore,
} from '#worker/vectorize/scoring.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import {
	buildPackageSearchDocument,
	buildPackageSearchProjection,
	type PackageSearchProjection,
} from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { buildPackageReadmeIntent } from '#worker/package-registry/package-readme.ts'
import { buildPackageAgentsDocs } from '#worker/repo/required-package-docs.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'
import { webhookDefaultRateLimitPerMinute } from '#worker/package-registry/types.ts'

import {
	findPackageExportByFragment,
	formatPackageExportEntityDetail,
	formatUnknownPackageExportError,
} from '../package-export-search-detail.ts'
import { formatPackageFileEntityDetail } from '../package-file-search-detail.ts'
import {
	maxFusedPackageCandidates,
	maxPackageExportCandidatesPerPackage,
	packageExportCandidateMinScore,
	packageExportCloseScoreGap,
} from '../search-constants.ts'
import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from '../markdown-safety.ts'
import {
	buildEntityRef,
	buildPackageActionImportUsage,
	buildPackageHostedUrl,
	buildPackageListNextStep,
	buildPackageMaintainSnippets,
	buildPackageRootImportUsage,
	buildPackageSourceFollowUp,
	getPrimaryPackageActionFunction,
} from '../search-format-helpers.ts'
import {
	type PackageActionMatch,
	type SearchMatch,
} from '../search-format-types.ts'
import {
	buildCandidateBaseScore,
	scoreMatchedTerms,
} from '../search-scoring.ts'
import { type PackageSearchRow, type SearchCandidate } from '../search-types.ts'
import { extractMeaningfulSearchTokens } from '../understand-search-query.ts'

export function flattenReferencedTypeFields(
	referencedTypes:
		| ReadonlyArray<{ name: string; definition: string }>
		| undefined,
): Array<string> {
	return (referencedTypes ?? []).flatMap((referencedType) => [
		referencedType.name,
		referencedType.definition,
	])
}

function buildPackageExportSearchFields(
	exportDetail: PackageSearchProjection['exports'][number],
) {
	return [
		exportDetail.subpath,
		exportDetail.runtimeTarget ?? '',
		exportDetail.typesPath ?? '',
		exportDetail.description ?? '',
		exportDetail.typeDefinition ?? '',
		...flattenReferencedTypeFields(exportDetail.referencedTypes),
		...(exportDetail.functions ?? []).flatMap((fn) => [
			fn.name,
			fn.description ?? '',
			fn.typeDefinition ?? '',
			...flattenReferencedTypeFields(fn.referencedTypes),
		]),
	]
}

/**
 * Parent package identity folded into export candidates so aliases (tags),
 * `kodyId`, scoped name, and name leaf help pick among that package's exports.
 */
export function buildPackageExportParentIdentityFields(input: {
	kodyId: string
	name: string
	tags: ReadonlyArray<string>
}): Array<string> {
	return [
		input.kodyId,
		input.name,
		getPackageNameLeaf(input.name),
		...input.tags,
	]
}

export function buildPackageActionMatches(input: {
	query: string
	meaningfulTokens: ReadonlyArray<string>
	exports: ReadonlyArray<PackageSearchProjection['exports'][number]>
	parentIdentityFields?: ReadonlyArray<string>
	/**
	 * Cap for nested package-index display. Omit (or leave unset) when
	 * scoring the full export surface for first-pass promotion.
	 */
	limit?: number
}): Array<PackageActionMatch> {
	if (input.meaningfulTokens.length === 0) return []
	const parentIdentityFields = input.parentIdentityFields ?? []
	const matches = input.exports
		.map((exportDetail) => {
			const exportSearchFields = buildPackageExportSearchFields(exportDetail)
			const searchFields = [...parentIdentityFields, ...exportSearchFields]
			const matchedTerms = input.meaningfulTokens.filter((token) =>
				scoreMatchedTerms(searchFields, [token]),
			)
			const exportLocalMatchedTermCount = input.meaningfulTokens.filter(
				(token) => scoreMatchedTerms(exportSearchFields, [token]),
			).length
			const termCoverage =
				matchedTerms.length / Math.max(1, input.meaningfulTokens.length)
			const score =
				lexicalScore(input.query, searchFields.join('\n')) +
				Math.min(0.5, termCoverage * 0.65)
			return {
				subpath: exportDetail.subpath,
				description: exportDetail.description,
				typeDefinition: exportDetail.typeDefinition,
				functions: (exportDetail.functions ?? []).map((fn) => ({
					name: fn.name,
					description: fn.description,
					typeDefinition: fn.typeDefinition,
				})),
				score,
				matchedTerms,
				exportLocalMatchedTermCount,
			}
		})
		.filter(
			(match) =>
				match.functions.length > 0 &&
				(match.exportLocalMatchedTermCount ?? match.matchedTerms.length) > 0 &&
				(match.matchedTerms.length >= 2 || match.score >= 0.35),
		)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score
			return left.subpath.localeCompare(right.subpath)
		})
	return input.limit == null ? matches : matches.slice(0, input.limit)
}

/**
 * Stricter than nested actionMatches: exports enter the first-pass pool only
 * when the query clearly targets the export (multi-term hit or strong score)
 * and at least one term hits export-local fields (not parent identity alone).
 */
export function shouldPromotePackageExportCandidate(
	actionMatch: PackageActionMatch,
): boolean {
	const exportLocalMatchedTermCount =
		actionMatch.exportLocalMatchedTermCount ?? actionMatch.matchedTerms.length
	if (exportLocalMatchedTermCount < 1) return false
	return (
		actionMatch.matchedTerms.length >= 2 ||
		actionMatch.score >= packageExportCandidateMinScore
	)
}

/**
 * Promote the top eligible export and close runners-up (score within
 * `packageExportCloseScoreGap` of the leader), up to
 * `maxPackageExportCandidatesPerPackage`. Clear score gaps stay single-winner.
 */
export function selectPromotedPackageExportCandidates(
	actionMatches: ReadonlyArray<PackageActionMatch>,
): Array<PackageActionMatch> {
	const eligible = actionMatches.filter(shouldPromotePackageExportCandidate)
	if (eligible.length === 0) return []
	const [top, ...rest] = eligible
	if (!top) return []
	const promoted: Array<PackageActionMatch> = [top]
	for (const candidate of rest) {
		if (promoted.length >= maxPackageExportCandidatesPerPackage) break
		if (top.score - candidate.score > packageExportCloseScoreGap) break
		promoted.push(candidate)
	}
	return promoted
}

function buildPackageExportCandidate(input: {
	entry: PackageSearchRow
	actionMatch: PackageActionMatch
	exportDetail: PackageSearchProjection['exports'][number]
	readmeSnippet: string
}): SearchCandidate {
	const { entry, actionMatch, exportDetail, readmeSnippet } = input
	const primaryFunction = getPrimaryPackageActionFunction(actionMatch)
	const title = primaryFunction
		? `${entry.record.name} ${primaryFunction.name}`
		: `${entry.record.name} ${actionMatch.subpath}`
	const description =
		actionMatch.description ??
		primaryFunction?.description ??
		entry.record.description
	const parentIdentityFields = buildPackageExportParentIdentityFields({
		kodyId: entry.record.kodyId,
		name: entry.record.name,
		tags: entry.record.tags,
	})
	return {
		match: {
			type: 'package' as const,
			packageId: entry.record.id,
			kodyId: entry.record.kodyId,
			name: entry.record.name,
			title,
			description,
			tags: entry.record.tags,
			hasApp: entry.record.hasApp,
			hidden: entry.record.hidden,
			readmeSnippet: entry.readmeSnippet ?? null,
			exportSubpath: actionMatch.subpath,
			actionMatches: [actionMatch],
			...(entry.listingAhead === true ? { listingAhead: true as const } : {}),
		},
		type: 'package' as const,
		id: `${entry.record.kodyId}#${actionMatch.subpath}`,
		title,
		packageIdentityFields: [...parentIdentityFields, readmeSnippet],
		searchFields: [
			...parentIdentityFields,
			...buildPackageExportSearchFields(exportDetail),
		],
		scoreComponents: buildCandidateBaseScore({
			lexical: actionMatch.score,
		}),
	}
}

function collectPackageExportCandidates(input: {
	packageCandidates: ReadonlyArray<SearchCandidate>
	rowsByRecordId: ReadonlyMap<string, PackageSearchRow>
	query: string
	meaningfulTokens: ReadonlyArray<string>
}): Array<SearchCandidate> {
	const exportCandidates: Array<SearchCandidate> = []
	for (const candidate of input.packageCandidates) {
		if (candidate.match.type !== 'package') continue
		if (candidate.match.exportSubpath) continue
		const row = input.rowsByRecordId.get(candidate.match.packageId)
		if (!row) continue
		const exports = Array.isArray(row.projection.exports)
			? row.projection.exports
			: []
		const parentIdentityFields = buildPackageExportParentIdentityFields({
			kodyId: row.record.kodyId,
			name: row.record.name,
			tags: row.record.tags,
		})
		// Rebuild uncapped so promotion sees every eligible export; nested
		// package-index display stays capped separately (limit: 3).
		const actionMatches = buildPackageActionMatches({
			query: input.query,
			meaningfulTokens: input.meaningfulTokens,
			exports,
			parentIdentityFields,
		})
		const promoted = selectPromotedPackageExportCandidates(actionMatches)
		for (const actionMatch of promoted) {
			const exportDetail = exports.find(
				(item) => item.subpath === actionMatch.subpath,
			)
			if (!exportDetail) continue
			exportCandidates.push(
				buildPackageExportCandidate({
					entry: row,
					actionMatch,
					exportDetail,
					readmeSnippet: row.readmeSnippet?.snippet ?? '',
				}),
			)
		}
	}
	return exportCandidates
}

/**
 * Queries Vectorize for this user's `package_{id}` vectors with
 * `{ kind: 'package', userId }`. Returns null when unavailable.
 */
async function queryPackageVectorScores(input: {
	env: Env
	query: string
	rows: Array<PackageSearchRow>
	userId: OwnerId
	limit: number
	queryVector?: ReadonlyArray<number>
}): Promise<Map<string, number> | null> {
	const index = getCapabilityVectorIndex(input.env)
	if (!index || !input.userId) return null
	const recordIdByVectorId = new Map(
		input.rows.map(
			(row) => [savedPackageVectorId(row.record.id), row.record.id] as const,
		),
	)
	const queryVector = [
		...(input.queryVector ??
			(await embedTextForVectorize(input.env, input.query))),
	]
	const topK = Math.min(Math.max(input.rows.length, input.limit * 5), 100)
	const vectorMatches = await index.query(queryVector, {
		topK,
		namespace: userVectorNamespace(input.userId),
		returnMetadata: 'none',
		filter: {
			kind: { $eq: 'package' },
			userId: { $eq: input.userId },
		},
	})
	const scores = new Map<string, number>()
	for (const match of vectorMatches.matches) {
		if (typeof match.id !== 'string') continue
		const recordId = recordIdByVectorId.get(match.id)
		if (!recordId || scores.has(recordId)) continue
		scores.set(recordId, match.score)
	}
	return scores
}

export const packageSearchEntityPlugin = {
	type: 'package',
	candidateTimingKey: 'packageCandidatesMs',
	buildDescriptors(input) {
		return input.optionalRows.packageRows.map((entry) => {
			const subscriptions = Array.isArray(entry.projection.subscriptions)
				? entry.projection.subscriptions
				: []
			return {
				type: 'package',
				id: entry.record.kodyId,
				title: entry.record.name,
				primaryAliases: [entry.record.kodyId, entry.record.name],
				secondaryAliases: [
					entry.record.description,
					entry.record.searchText ?? '',
					...entry.record.tags,
				],
				tertiaryAliases: [
					...entry.projection.exports.flatMap((exportDetail) => [
						exportDetail.subpath,
						exportDetail.description ?? '',
						exportDetail.typeDefinition ?? '',
						...flattenReferencedTypeFields(exportDetail.referencedTypes),
						...(exportDetail.functions ?? []).flatMap((fn) => [
							fn.name,
							fn.description ?? '',
							fn.typeDefinition ?? '',
							...flattenReferencedTypeFields(fn.referencedTypes),
						]),
					]),
					...entry.projection.jobs.map((job) => job.name),
					...subscriptions.flatMap((subscription) => [
						subscription.topic,
						subscription.handler,
						subscription.description ?? '',
					]),
					entry.readmeSnippet?.snippet ?? '',
					...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
				],
			}
		})
	},
	async buildCandidates(input) {
		const rows = input.optionalRows.packageRows
		if (rows.length === 0) return []
		// Fail closed in every mode: no userId, and foreign rows never enter
		// ranking (no cross-org discovery).
		if (!input.userId) return []
		if (rows.some((row) => row.record.userId !== input.userId)) {
			console.warn(
				JSON.stringify({
					message: 'package candidates skipped: row userId mismatch',
					expectedUserId: input.userId,
				}),
			)
			return []
		}
		const meaningfulTokens = extractMeaningfulSearchTokens(input.query)
		let vectorScoresByRecordId: Map<string, number> | null = null
		if (!input.offline && input.userId) {
			try {
				vectorScoresByRecordId = await queryPackageVectorScores({
					env: input.env,
					query: input.query,
					rows,
					userId: input.userId,
					limit: input.limit,
					...(input.sharedQueryVector
						? { queryVector: input.sharedQueryVector }
						: {}),
				})
			} catch (error) {
				console.warn(
					JSON.stringify({
						message: 'package vector query failed, using lexical ranking',
						error: error instanceof Error ? error.message : String(error),
					}),
				)
			}
		}
		const candidates = rows
			.map((entry) => {
				const exports = Array.isArray(entry.projection.exports)
					? entry.projection.exports
					: []
				const jobs = Array.isArray(entry.projection.jobs)
					? entry.projection.jobs
					: []
				const subscriptions = Array.isArray(entry.projection.subscriptions)
					? entry.projection.subscriptions
					: []
				const readmeSnippet = entry.readmeSnippet?.snippet ?? ''
				const actionMatches = buildPackageActionMatches({
					query: input.query,
					meaningfulTokens,
					exports,
					parentIdentityFields: buildPackageExportParentIdentityFields({
						kodyId: entry.record.kodyId,
						name: entry.record.name,
						tags: entry.record.tags,
					}),
					limit: 3,
				})
				const document = [
					buildPackageSearchDocument(entry.projection),
					readmeSnippet,
				]
					.filter((value) => value.trim().length > 0)
					.join('\n')
				const lexical = Math.max(
					lexicalScore(input.query, document),
					(actionMatches[0]?.score ?? 0) * 0.8,
				)
				const vectorHit = vectorScoresByRecordId?.get(entry.record.id)
				const scoreComponents =
					vectorScoresByRecordId != null
						? buildCandidateBaseScore({
								lexical,
								...(vectorHit !== undefined ? { vector: vectorHit } : {}),
							})
						: buildCandidateBaseScore({
								lexical,
								vector: cosineSimilarity(
									input.queryEmbedding,
									deterministicEmbedding(document),
								),
							})
				return {
					match: {
						type: 'package' as const,
						packageId: entry.record.id,
						kodyId: entry.record.kodyId,
						name: entry.record.name,
						title: entry.record.name,
						description: entry.record.description,
						tags: entry.record.tags,
						hasApp: entry.record.hasApp,
						hidden: entry.record.hidden,
						readmeSnippet: entry.readmeSnippet ?? null,
						actionMatches,
						...(entry.listingAhead === true
							? { listingAhead: true as const }
							: {}),
					},
					type: 'package' as const,
					id: entry.record.kodyId,
					title: entry.record.name,
					packageIdentityFields: [
						entry.record.kodyId,
						entry.record.name,
						...entry.record.tags,
						readmeSnippet,
					],
					searchFields: [
						entry.record.kodyId,
						entry.record.name,
						entry.record.description,
						entry.record.searchText ?? '',
						...entry.record.tags,
						...exports.flatMap(buildPackageExportSearchFields),
						...jobs.flatMap((job) => [
							job.name,
							job.entry,
							job.schedule,
							job.enabled ? 'enabled' : 'disabled',
						]),
						...subscriptions.flatMap((subscription) => [
							subscription.topic,
							subscription.handler,
							subscription.description ?? '',
						]),
						...(entry.projection.appEntry ? [entry.projection.appEntry] : []),
						readmeSnippet,
						...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
					],
					scoreComponents,
				}
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
		const rowsByRecordId = new Map(
			rows.map((row) => [row.record.id, row] as const),
		)
		let packageCandidates = candidates
		if (vectorScoresByRecordId) {
			// Fuse lexical and vector rankings to bound the online candidate set.
			const candidateIds = packageCandidates.map(
				(candidate) => candidate.match.packageId,
			)
			const lexicalById = new Map(
				packageCandidates.map(
					(candidate) =>
						[
							candidate.match.packageId,
							candidate.scoreComponents.lexical,
						] as const,
				),
			)
			const lexicalOrder = sortIdsByScore(
				candidateIds,
				(id) => lexicalById.get(id) ?? 0,
			)
			const vectorHitIds = candidateIds.filter((id) =>
				vectorScoresByRecordId.has(id),
			)
			const vectorOrder = sortIdsByScore(
				vectorHitIds,
				(id) => vectorScoresByRecordId.get(id) ?? 0,
			)
			const fused = reciprocalRankFusion(
				[lexicalOrder, vectorOrder],
				CAPABILITY_SEARCH_RRF_K,
			)
			const keptIds = new Set(
				sortIdsByScore(candidateIds, (id) => fused.get(id) ?? 0).slice(
					0,
					Math.min(
						maxFusedPackageCandidates,
						Math.max(input.limit * 5, input.limit),
					),
				),
			)
			packageCandidates = packageCandidates.filter((candidate) =>
				keptIds.has(candidate.match.packageId),
			)
		}

		// Lean search rows omit exports until hydrate. Bound hydrate to the
		// requested page so strong exports can enter the first-pass pool
		// without loading every package source. Jev wide recall (50) must not
		// multiply source loads and export AST parses for rows that rarely
		// reach the returned page.
		const hydrateBudget = Math.min(
			packageCandidates.length,
			input.pageLimit ?? input.limit,
		)
		const hydrateTargets = [...packageCandidates]
			.sort(
				(left, right) => right.scoreComponents.base - left.scoreComponents.base,
			)
			.slice(0, hydrateBudget)
		await Promise.all(
			hydrateTargets.map(async (candidate) => {
				if (candidate.match.type !== 'package') return
				if ((candidate.match.actionMatches?.length ?? 0) > 0) return
				const row = rowsByRecordId.get(candidate.match.packageId)
				if (!row?.hydrate) return
				try {
					const hydrated = await row.hydrate()
					row.projection = hydrated.projection
					row.readmeSnippet = hydrated.readmeSnippet
					candidate.match.readmeSnippet = hydrated.readmeSnippet
					candidate.match.actionMatches = buildPackageActionMatches({
						query: input.query,
						meaningfulTokens,
						exports: hydrated.projection.exports,
						parentIdentityFields: buildPackageExportParentIdentityFields({
							kodyId: row.record.kodyId,
							name: row.record.name,
							tags: row.record.tags,
						}),
						limit: 3,
					})
				} catch (error) {
					console.warn(
						JSON.stringify({
							message:
								'package export candidate hydrate failed; skipping export promotion',
							packageId: candidate.match.packageId,
							error: error instanceof Error ? error.message : String(error),
						}),
					)
				}
			}),
		)

		const exportCandidates = collectPackageExportCandidates({
			packageCandidates,
			rowsByRecordId,
			query: input.query,
			meaningfulTokens,
		})
		return [...packageCandidates, ...exportCandidates]
	},
	formatSlimMatch({ match, baseUrl, packageAppBaseUrl, username }) {
		const rootImportUsage = buildPackageRootImportUsage(match.name)
		const actionMatches = (match.actionMatches ?? []).map((actionMatch) => {
			const importSpecifier = buildPackageImportSpecifier(
				match.name,
				actionMatch.subpath,
			)
			return {
				subpath: actionMatch.subpath,
				importSpecifier,
				description: actionMatch.description,
				typeDefinition: actionMatch.typeDefinition,
				functions: actionMatch.functions.map((fn) => ({
					name: fn.name,
					description: fn.description,
					typeDefinition: fn.typeDefinition,
					usage: buildPackageActionImportUsage({
						packageName: match.name,
						subpath: actionMatch.subpath,
						functionName: fn.name,
					}),
				})),
				score: actionMatch.score,
				matchedTerms: actionMatch.matchedTerms,
			}
		})
		const exportSubpath = match.exportSubpath
		const [primaryAction] = actionMatches
		const primaryActionFunction = primaryAction
			? getPrimaryPackageActionFunction(primaryAction)
			: null
		const entityRef = buildEntityRef(match.kodyId, 'package', exportSubpath)
		const nextStep = buildPackageListNextStep(match)
		return {
			type: 'package',
			id: exportSubpath ? `${match.kodyId}#${exportSubpath}` : match.kodyId,
			entityRef,
			packageId: match.packageId,
			kodyId: match.kodyId,
			title: match.title,
			description: match.description,
			usage: primaryActionFunction?.usage ?? rootImportUsage,
			rootImportUsage,
			tags: match.tags,
			hasApp: match.hasApp,
			hidden: match.hidden,
			...(exportSubpath ? { exportSubpath } : {}),
			...(match.listingAhead === true ? { listingAhead: true as const } : {}),
			...(match.exportCallContract
				? { exportCallContract: match.exportCallContract }
				: {}),
			hostedUrl:
				match.hasApp && username
					? buildPackageHostedUrl({
							packageAppBaseUrl: packageAppBaseUrl ?? null,
							appBaseUrl: baseUrl,
							username,
							kodyId: match.kodyId,
						})
					: null,
			readmeSnippet: match.readmeSnippet
				? {
						path: match.readmeSnippet.path,
						snippet: match.readmeSnippet.snippet,
						truncated: match.readmeSnippet.truncated,
					}
				: null,
			actionMatches,
			nextStep,
		}
	},
	formatEntityDetail(detail, options) {
		const exportProjection = buildPackageSearchProjection(
			detail.manifest,
			detail.files,
		)
		if (detail.section) {
			const exportDetail = findPackageExportByFragment(
				exportProjection.exports,
				detail.section,
			)
			if (exportDetail) {
				return formatPackageExportEntityDetail({
					detail,
					exportDetail,
					includeBoilerplate: options?.includeBoilerplate ?? true,
				})
			}
			const fileDetail = formatPackageFileEntityDetail({
				detail,
				section: detail.section,
				includeBoilerplate: options?.includeBoilerplate ?? true,
			})
			if (fileDetail) return fileDetail
			throw new McpCallerError(
				formatUnknownPackageExportError({
					entityRef: buildEntityRef(detail.record.kodyId, 'package'),
					section: detail.section,
					exports: exportProjection.exports,
				}),
			)
		}
		const exportDetails = exportProjection.exports.map((exportDetail) => ({
			subpath: exportDetail.subpath,
			description:
				exportDetail.description ??
				exportDetail.functions.find((fn) => fn.description)?.description ??
				null,
		}))
		const jobs = Object.keys(detail.manifest.kody.jobs ?? {}).map((name) => ({
			name,
		}))
		const webhooks = (detail.manifest.kody.webhooks ?? []).map((webhook) => ({
			name: webhook.name,
			exportName: webhook.export,
			responseMode: webhook.responseMode ?? 'ack',
			inputMode: webhook.inputMode ?? 'request',
			rateLimitPerMinute:
				webhook.rateLimitPerMinute ?? webhookDefaultRateLimitPerMinute,
			replay: webhook.replay ?? null,
			signedPayload:
				webhook.verification?.type === 'url-secret'
					? null
					: (webhook.verification?.signedPayload ?? null),
			challenge: webhook.challenge ?? null,
		}))
		const appEntry = detail.manifest.kody.app?.entry ?? null
		const readmeIntent = buildPackageReadmeIntent({
			files: detail.files,
		})
		const agentsDocs = buildPackageAgentsDocs({
			files: detail.files,
		})
		const maintain = buildPackageMaintainSnippets(detail.record.id)
		const rootImportUsage = buildPackageRootImportUsage(detail.record.name)
		const listingAhead = detail.listingAhead === true
		const sourceFollowUp = buildPackageSourceFollowUp({
			packageId: detail.record.id,
			kodyId: detail.record.kodyId,
		})
		const followUp = listingAhead
			? `${listingAheadSearchNotice} ${sourceFollowUp}`
			: sourceFollowUp
		const lines = [
			`# Package — \`${detail.record.kodyId}\``,
			'',
			detail.description,
			'',
			'## Index',
			'',
			`- Entity: \`${buildEntityRef(detail.record.kodyId, 'package')}\``,
			`- Package name: \`${detail.record.name}\``,
			`- Tags: ${detail.record.tags.length > 0 ? detail.record.tags.map((tag) => `\`${tag}\``).join(', ') : 'none'}`,
			`- Has app: ${detail.record.hasApp ? 'yes' : 'no'}`,
			`- Has skills: ${detail.record.hasSkills ? 'yes' : 'no'}`,
			`- Hidden: ${detail.record.hidden ? 'yes' : 'no'}`,
			...(detail.hostedUrl ? [`- Hosted URL: \`${detail.hostedUrl}\``] : []),
			...(listingAhead
				? [`- Listing ahead: yes — ${listingAheadSearchNotice}`]
				: []),
		]
		const skillManifestPaths = Object.keys(detail.files)
			.filter((path) => /^skills\/[^/]+\/SKILL\.md$/u.test(path))
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
		if (skillManifestPaths.length > 0) {
			lines.push(
				'',
				'## Skills',
				'',
				'Agent Skills shipped in this package (`skills/<name>/SKILL.md`). Open a skill file with search entity detail, or use Skills-over-MCP when the client and `mcp-skills-extension` flag support it.',
				'',
				...skillManifestPaths.map((path) => {
					const skillName = path.slice('skills/'.length, -'/SKILL.md'.length)
					return `- \`${skillName}\` — \`search({ entity: "package:${detail.record.kodyId}#${path}" })\``
				}),
			)
		}
		if (exportDetails.length > 0) {
			lines.push('', '## Exports', '', '| Subpath | Purpose |', '| --- | --- |')
			for (const exportDetail of exportDetails) {
				lines.push(
					`| ${formatMarkdownInlineCode(exportDetail.subpath)} | ${escapeMarkdownText(exportDetail.description ?? 'Package export.')} |`,
				)
			}
		}
		if (jobs.length > 0) {
			lines.push(
				'',
				'## Jobs',
				'',
				...jobs.map((job) => `- ${formatMarkdownInlineCode(job.name)}`),
			)
		}
		if (webhooks.length > 0) {
			lines.push(
				'',
				'## Webhooks',
				'',
				...webhooks.map((webhook) => {
					const replayParts = [
						webhook.signedPayload ? `signed ${webhook.signedPayload}` : null,
						webhook.replay?.timestampHeader
							? `timestamp ${webhook.replay.timestampHeader}${webhook.replay.timestampFormat ? ` ${webhook.replay.timestampFormat}` : ''}`
							: null,
						webhook.replay?.deliveryIdHeader
							? `delivery ${webhook.replay.deliveryIdHeader}`
							: null,
						webhook.challenge ? `challenge ${webhook.challenge.type}` : null,
					].filter((value): value is string => value != null)
					const replaySuffix =
						replayParts.length > 0 ? ` (${replayParts.join(', ')})` : ''
					const modeParts = [
						webhook.responseMode,
						webhook.inputMode === 'params' ? 'params' : null,
						webhook.rateLimitPerMinute !== webhookDefaultRateLimitPerMinute
							? `${webhook.rateLimitPerMinute}/min`
							: null,
					].filter((value): value is string => value != null)
					return `- ${formatMarkdownInlineCode(webhook.name)} → ${formatMarkdownInlineCode(webhook.exportName)} (${modeParts.join(', ')}${replaySuffix})`
				}),
			)
		}
		if (readmeIntent) {
			lines.push(
				'',
				`## README Intent (${formatMarkdownInlineCode(readmeIntent.path)})`,
				'',
				readmeIntent.content,
				...(readmeIntent.truncated
					? ['', '> README Intent was truncated for this index.']
					: []),
			)
		}
		if (agentsDocs) {
			lines.push(
				'',
				`## Agent docs (${formatMarkdownInlineCode(agentsDocs.path)})`,
				'',
				agentsDocs.content,
				...(agentsDocs.truncated
					? ['', '> AGENTS.md was truncated for this index.']
					: []),
			)
		}
		if (options?.includeBoilerplate ?? true) {
			lines.push('', '## Follow up', '', followUp)
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'package',
				detailMode: 'index',
				id: detail.record.kodyId,
				entityRef: buildEntityRef(detail.record.kodyId, 'package'),
				title: detail.title,
				description: detail.description,
				usage: rootImportUsage,
				packageId: detail.record.id,
				kodyId: detail.record.kodyId,
				name: detail.record.name,
				tags: detail.record.tags,
				hasApp: detail.record.hasApp,
				hidden: detail.record.hidden,
				hostedUrl: detail.hostedUrl,
				appEntry,
				maintain,
				exports: exportDetails,
				jobs,
				webhooks,
				readmeIntent,
				agentsDocs,
				followUp,
				listingAhead: detail.listingAhead,
			},
		}
	},
} satisfies SearchEntityPlugin<'package'>

export async function hydrateTopPackageMatches(input: {
	query: string
	matches: Array<SearchMatch>
	rows: Array<PackageSearchRow>
}): Promise<void> {
	const rowsByRecordId = new Map(
		input.rows.map((row) => [row.record.id, row] as const),
	)
	const packageMatches = input.matches.flatMap((match) =>
		match.type === 'package' ? [match] : [],
	)
	if (packageMatches.length === 0) return
	const meaningfulTokens = extractMeaningfulSearchTokens(input.query)
	await Promise.all(
		packageMatches.map(async (match) => {
			const row = rowsByRecordId.get(match.packageId)
			if (!row?.hydrate) return
			try {
				const hydrated = await row.hydrate()
				match.readmeSnippet = hydrated.readmeSnippet
				const actionMatches = buildPackageActionMatches({
					query: input.query,
					meaningfulTokens,
					exports: hydrated.projection.exports,
					parentIdentityFields: buildPackageExportParentIdentityFields({
						kodyId: row.record.kodyId,
						name: row.record.name,
						tags: row.record.tags,
					}),
					limit: match.exportSubpath ? undefined : 3,
				})
				// Export-focused ranked hits must keep actionMatches aligned with
				// exportSubpath. Replacing with the full nested-display list would
				// let list/slim formatting pair the wrong usage with the entity ref.
				if (match.exportSubpath) {
					const focused =
						findPackageExportByFragment(actionMatches, match.exportSubpath) ??
						null
					match.actionMatches = focused
						? [focused]
						: (match.actionMatches ?? []).filter(
								(actionMatch) =>
									findPackageExportByFragment(
										[actionMatch],
										match.exportSubpath!,
									) != null,
							)
					return
				}
				match.actionMatches = actionMatches
			} catch (error) {
				console.warn(
					JSON.stringify({
						message: 'package search match hydration failed',
						packageId: match.packageId,
						error: error instanceof Error ? error.message : String(error),
					}),
				)
			}
		}),
	)
}
