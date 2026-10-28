import { z } from 'zod'
import {
	getNodeName,
	listScannableModulePaths,
	parseModule,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const pageSizeMax = 50
const reportTtlSeconds = 24 * 60 * 60
const reportKeyPrefix = 'admin-package-credential-supplier-report:'

const countsSchema = z.object({
	packagesCallingCredentialVisitor: z.number().int().nonnegative(),
	appsWithVisitorNeeds: z.number().int().nonnegative(),
	packagesWithOwnerCredentialForVisitorsNeeds: z.number().int().nonnegative(),
	ownerCredentialForVisitorsNeeds: z.number().int().nonnegative(),
	packagesSkipped: z.number().int().nonnegative(),
	personalMappingsOnOwnerCredentialForVisitorsNeeds: z
		.number()
		.int()
		.nonnegative(),
	enablementMappingsOnOwnerCredentialForVisitorsNeeds: z
		.number()
		.int()
		.nonnegative(),
})

const inputSchema = z.object({
	runId: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(pageSizeMax).default(20),
})

const outputSchema = z.object({
	runId: z.string(),
	complete: z.boolean(),
	counts: countsSchema,
})

type ReportCounts = z.infer<typeof countsSchema>

type ReportState = {
	cursor: string | null
	complete: boolean
	counts: ReportCounts
}

function emptyCounts(): ReportCounts {
	return {
		packagesCallingCredentialVisitor: 0,
		appsWithVisitorNeeds: 0,
		packagesWithOwnerCredentialForVisitorsNeeds: 0,
		ownerCredentialForVisitorsNeeds: 0,
		packagesSkipped: 0,
		personalMappingsOnOwnerCredentialForVisitorsNeeds: 0,
		enablementMappingsOnOwnerCredentialForVisitorsNeeds: 0,
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function readsCredentialVisitorCall(source: string) {
	const parsed = parseModule(source)
	if (!parsed) return false
	let found = false
	walkAst(parsed, (node) => {
		if (
			found ||
			(node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression')
		) {
			return
		}
		const callee = node.callee
		if (
			(callee?.type === 'MemberExpression' ||
				callee?.type === 'OptionalMemberExpression') &&
			callee.computed !== true &&
			getNodeName(callee.property) === 'visitor' &&
			callee.object?.type === 'Identifier' &&
			getNodeName(callee.object) === 'credential'
		) {
			found = true
		}
	})
	return found
}

export function analyzePackageCredentialSupplierSource(input: {
	files: Record<string, string>
	manifestPath: string
}) {
	let callsCredentialVisitor = false
	for (const path of listScannableModulePaths(input.files)) {
		const source = input.files[path]
		if (source && readsCredentialVisitorCall(source)) {
			callsCredentialVisitor = true
			break
		}
	}

	let visitorNeeds = false
	const ownerNeedKeys: Array<string> = []
	try {
		const manifest: unknown = JSON.parse(input.files[input.manifestPath] ?? '')
		if (isRecord(manifest) && isRecord(manifest.kody)) {
			const kody = manifest.kody
			if (isRecord(kody.app) && isRecord(kody.app.visitorNeeds)) {
				visitorNeeds = Object.hasOwn(kody.app, 'visitorNeeds')
			}
			if (isRecord(kody.credentials)) {
				for (const [key, need] of Object.entries(kody.credentials)) {
					if (isRecord(need) && need.ownerCredentialForVisitors === true) {
						ownerNeedKeys.push(key)
					}
				}
			}
		}
	} catch {
		// Invalid manifests are skipped by the package runtime as well.
	}

	return { callsCredentialVisitor, visitorNeeds, ownerNeedKeys }
}

export function addPackageCredentialSupplierCounts(
	counts: ReportCounts,
	analysis: ReturnType<typeof analyzePackageCredentialSupplierSource>,
	mappingRows: ReadonlyArray<{ target: string; count: number }> = [],
) {
	if (analysis.callsCredentialVisitor) {
		counts.packagesCallingCredentialVisitor += 1
	}
	if (analysis.visitorNeeds) counts.appsWithVisitorNeeds += 1
	if (analysis.ownerNeedKeys.length > 0) {
		counts.packagesWithOwnerCredentialForVisitorsNeeds += 1
		counts.ownerCredentialForVisitorsNeeds += analysis.ownerNeedKeys.length
	}
	addPackageCredentialSupplierMappingCounts(counts, mappingRows)
}

export function addPackageCredentialSupplierMappingCounts(
	counts: ReportCounts,
	mappingRows: ReadonlyArray<{ target: string; count: number }>,
) {
	for (const row of mappingRows) {
		if (row.target === 'mine') {
			counts.personalMappingsOnOwnerCredentialForVisitorsNeeds += row.count
		}
		if (row.target === 'enablement') {
			counts.enablementMappingsOnOwnerCredentialForVisitorsNeeds += row.count
		}
	}
}

async function addMappingCounts(input: {
	db: D1Database
	orgId: string
	packageId: string
	needKeys: ReadonlyArray<string>
	counts: ReportCounts
}) {
	if (input.needKeys.length === 0) return
	for (let index = 0; index < input.needKeys.length; index += 90) {
		const needKeys = input.needKeys.slice(index, index + 90)
		const result = await input.db
			.prepare(
				`SELECT target, COUNT(*) AS count
				FROM credential_mappings
				WHERE org_id = ? AND package_id = ?
					AND target IN ('mine', 'enablement')
					AND need_key IN (${needKeys.map(() => '?').join(', ')})
				GROUP BY target`,
			)
			.bind(input.orgId, input.packageId, ...needKeys)
			.all<{ target: string; count: number }>()
		addPackageCredentialSupplierMappingCounts(
			input.counts,
			result.results ?? [],
		)
	}
}

function mergeCounts(target: ReportCounts, source: ReportCounts) {
	for (const key of Object.keys(target) as Array<keyof ReportCounts>) {
		target[key] += source[key]
	}
}

export async function scanPackageCredentialSupplierReportStep(input: {
	env: Env
	baseUrl: string
	state: ReportState
	limit: number
}) {
	const packages = await listSavedPackagesPage(input.env.APP_DB, {
		afterId: input.state.cursor,
		limit: input.limit + 1,
	})
	const page = packages.slice(0, input.limit)
	for (const savedPackage of page) {
		const packageCounts = emptyCounts()
		try {
			const loaded = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			const analysis = analyzePackageCredentialSupplierSource({
				files: loaded.files,
				manifestPath: loaded.source.manifest_path,
			})
			addPackageCredentialSupplierCounts(packageCounts, analysis)
			if (analysis.ownerNeedKeys.length > 0) {
				await addMappingCounts({
					db: input.env.APP_DB,
					orgId: savedPackage.userId,
					packageId: savedPackage.id,
					needKeys: analysis.ownerNeedKeys,
					counts: packageCounts,
				})
			}
			mergeCounts(input.state.counts, packageCounts)
		} catch {
			input.state.counts.packagesSkipped += 1
		}
		input.state.cursor = savedPackage.id
	}
	input.state.complete = packages.length <= input.limit
	return input.state
}

export const adminPackageCredentialSupplierReportCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminPackageCredentialSupplierReport',
		contextRuns: 'deny',
		description:
			'Read-only counts-only report of saved package credential.visitor usage, visitor needs, owner-credential-for-visitors needs, matching live personal and enablement credential mappings, and packages skipped after scan errors. Never returns handles, usernames, package names, emails, need keys, or package identifiers. Admin-only; counts are for internal rollout decisions.',
		keywords: [
			'admin',
			'package',
			'credential',
			'visitor',
			'needs',
			'mappings',
			'counts',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageCredentialSupplierReport',
				async () => {
					await resolveActingAdminPerson(ctx)
					const runId = args.runId ?? crypto.randomUUID()
					const key = `${reportKeyPrefix}${runId}`
					const current = args.runId
						? await ctx.env.BUNDLE_ARTIFACTS_KV.get<ReportState>(key, 'json')
						: null
					if (args.runId && !current) {
						throw new Error('Credential supplier report run was not found.')
					}
					const state: ReportState = current ?? {
						cursor: null,
						complete: false,
						counts: emptyCounts(),
					}
					if (!state.complete) {
						await scanPackageCredentialSupplierReportStep({
							env: ctx.env,
							baseUrl: ctx.callerContext.baseUrl,
							state,
							limit: args.limit,
						})
						await ctx.env.BUNDLE_ARTIFACTS_KV.put(key, JSON.stringify(state), {
							expirationTtl: reportTtlSeconds,
						})
					}
					return {
						runId,
						complete: state.complete,
						counts: state.counts,
					}
				},
				{
					successReason: (result) =>
						`complete=${String(result.complete)};visitorCalls=${String(result.counts.packagesCallingCredentialVisitor)};ownerNeeds=${String(result.counts.ownerCredentialForVisitorsNeeds)}`,
				},
			)
		},
	})
