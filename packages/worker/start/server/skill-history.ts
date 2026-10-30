import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'
import { z } from 'zod'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	loadCallerSkillsCatalog,
	listCatalogSkills,
} from '#mcp/skills/skills-catalog.ts'
import { listPackageSkillsIndexes } from '#worker/package-registry/skills-index-cache.ts'
import {
	readPublishedSourceManifestSnapshot,
	readPublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	digestSnapshotContent,
	skillResourceIsBinary,
	bytesToBase64,
} from '#worker/package-registry/package-skills.ts'
import {
	computeEffectivePermissions,
	checkPermission,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { loadScopedCollection } from './collection-context.ts'

const input = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	skill: z.string().min(1),
	commit: z.string().min(1).optional(),
	compare: z.string().min(1).optional(),
	path: z.string().optional(),
})

async function historyContext(data: z.infer<typeof input>) {
	const {
		bindings: env,
		request,
		user,
	} = await loadScopedCollection({
		orgSlug: data.orgSlug,
		section: 'skills',
		returnTo: `/@${data.orgSlug}/-/skills`,
	})
	const callerContext = {
		...createMcpCallerContext({
			baseUrl: new URL(request.url).origin,
			user: user.mcpUser,
			source: { kind: 'session' },
		}),
		request: user.request,
	}
	const catalog = await loadCallerSkillsCatalog({
		env,
		callerContext,
		failOnError: true,
	})
	const current = listCatalogSkills(catalog).find(
		({ skill }) => skill.uri === data.skill,
	)
	if (!current) throw notFound()
	const indexes = await listPackageSkillsIndexes({
		env,
		userId: current.package.ownerUserId,
		packageId: current.package.packageId,
	})
	if (
		!indexes.some(
			(index) =>
				index.publishedCommit === current.package.index.publishedCommit,
		)
	)
		indexes.push(current.package.index)
	const versions = []
	for (let offset = 0; offset < indexes.length; offset += 10) {
		const batch = await Promise.all(
			indexes.slice(offset, offset + 10).map(async (index) => {
				const skill = index.skills.find(
					(entry) => entry.name === current.skill.name,
				)
				if (!skill) return null
				const manifest = index.publishedAt
					? null
					: await readPublishedSourceManifestSnapshot({
							env,
							sourceId: current.package.sourceId,
							publishedCommit: index.publishedCommit,
						})
				return {
					commit: index.publishedCommit,
					createdAt: index.publishedAt ?? manifest?.createdAt ?? null,
					publishedBy: index.publishedBy ?? null,
					skill,
				}
			}),
		)
		for (const version of batch) if (version) versions.push(version)
	}
	versions.sort(
		(a, b) =>
			(b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
			b.commit.localeCompare(a.commit),
	)
	// The live commit is authoritative even if its KV publication timestamp is missing.
	const live = versions.findIndex(
		(version) => version.commit === current.package.index.publishedCommit,
	)
	if (live > 0) versions.unshift(...versions.splice(live, 1))
	return { env, callerContext, current, versions }
}

export const loadSkillHistory = createServerFn({ method: 'GET' })
	.validator(input)
	.handler(async ({ data }) => {
		const { env, callerContext, current, versions } = await historyContext(data)
		const version = versions.find(
			(entry) =>
				entry.commit === (data.commit ?? current.package.index.publishedCommit),
		)
		if (!version) throw notFound()
		const comparison = data.compare
			? versions.find((entry) => entry.commit === data.compare)
			: versions[versions.indexOf(version) + 1]
		if (data.compare && !comparison) throw notFound()
		const files = [
			...new Set(
				[
					...version.skill.resources,
					...(comparison?.skill.resources ?? []),
				].map((file) => file.relativePath),
			),
		].sort()
		const path = data.path ?? 'SKILL.md'
		if (!files.includes(path)) throw notFound()
		async function read(entry: typeof version) {
			const resource = entry?.skill.resources.find(
				(file) => file.relativePath === path,
			)
			if (!entry || !resource) return null
			const snapshot = await readPublishedSourceSnapshot({
				env,
				sourceId: current.package.sourceId,
				publishedCommit: entry.commit,
			})
			const content = snapshot?.files[resource.packagePath]
			if (content === undefined)
				throw new Error('This published snapshot is unavailable.')
			const { digest, size, bytes } = await digestSnapshotContent(
				content,
				resource.packagePath,
			)
			if (digest !== resource.digest || size !== resource.size)
				throw new Error(
					'The archived file does not match its published version.',
				)
			const binary = skillResourceIsBinary(resource.packagePath, content)
			const { issueSkillReadReceipt, catalogReadResource } =
				await import('#worker/package-registry/skill-read-events.ts')
			const actor = callerContext.request?.actor
			const receipt = actor
				? await issueSkillReadReceipt(env.COOKIE_SECRET, {
						resource: catalogReadResource({
							package: {
								...current.package,
								index: {
									...current.package.index,
									publishedCommit: entry.commit,
								},
							},
							skill: entry.skill,
							resource,
						}),
						actorId: actor.userId,
						orgId: callerContext.request!.org.id,
						channel: 'skills-page',
					})
				: null
			return {
				receipt,

				text: binary ? null : content,
				blob: binary ? bytesToBase64(bytes) : null,
				mimeType: resource.mimeType,
				size,
			}
		}
		const [content, previous] = await Promise.all([
			read(version),
			read(comparison),
		])
		const { diffLines } = await import('diff')
		const binary =
			(content && content.text === null) || (previous && previous.text === null)
		const diff = binary
			? []
			: diffLines(previous?.text ?? '', content?.text ?? '', {
					timeout: 500,
					maxEditLength: 10000,
				})
		const changes = (diff ?? []).map(({ added, removed, value }) => ({
			added: added === true,
			removed: removed === true,
			value,
		}))
		const access = await computeEffectivePermissions({
			env,
			request: callerContext.request!,
		})
		return {
			versions: versions.map(({ commit, createdAt, publishedBy }) => ({
				commit,
				createdAt,
				publishedBy,
			})),
			currentCommit: current.package.index.publishedCommit,
			commit: version.commit,
			compare: comparison?.commit ?? null,
			files: files.map((path) => {
				const file = version.skill.resources.find(
					(entry) => entry.relativePath === path,
				)
				const old = comparison?.skill.resources.find(
					(entry) => entry.relativePath === path,
				)
				return {
					path,
					status: !old
						? 'added'
						: !file
							? 'removed'
							: old.digest !== file.digest
								? 'changed'
								: 'unchanged',
				}
			}),
			path,
			content,
			previous,
			binary: !!binary,
			changes,
			diffUnavailable: diff === undefined,
			canRestore: checkPermission(
				access,
				'package:write',
				packageResource({
					id: current.package.packageId,
					userId: current.package.ownerUserId,
				}),
			).allowed,
		}
	})

export const restoreSkillVersion = createServerFn({ method: 'POST' })
	.validator(
		input.extend({
			commit: z.string().min(1),
			expectedCommit: z.string().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			async () => {
				const { env, callerContext, current, versions } =
					await historyContext(data)
				const { authorize } = await import('#worker/authorization/authorize.ts')
				await authorize(
					{ env, request: callerContext.request! },
					'package:write',
					packageResource({
						id: current.package.packageId,
						userId: current.package.ownerUserId,
					}),
				)
				if (current.package.index.publishedCommit !== data.expectedCommit)
					throw new Error(
						'This package changed. Reload history before restoring.',
					)
				if (!versions.some((version) => version.commit === data.commit))
					throw notFound()
				if (data.commit === data.expectedCommit)
					throw new Error('This version is already current.')
				const [
					{ repoOpenSessionCapability },
					{ repoCommitCapability },
					{ repoRunChecksCapability },
					{ repoPublishSessionCapability },
					{ repoDiscardSessionCapability },
					{ repoSessionRpc },
				] = await Promise.all([
					import('#mcp/capabilities/repo/repo-open-session.ts'),
					import('#mcp/capabilities/repo/repo-commit.ts'),
					import('#mcp/capabilities/repo/repo-run-checks.ts'),
					import('#mcp/capabilities/repo/repo-publish-session.ts'),
					import('#mcp/capabilities/repo/repo-discard-session.ts'),
					import('#worker/repo/repo-session-rpc.ts'),
				])
				const ctx = { env, callerContext }
				let retainSession = false
				const opened = (await repoOpenSessionCapability.handler(
					{
						target: { kind: 'package', package_id: current.package.packageId },
					},
					ctx,
				)) as { id: string; base_commit: string }
				try {
					if (opened.base_commit !== data.expectedCommit)
						throw new Error(
							'This package changed. Reload history before restoring.',
						)
					const restored = await repoSessionRpc(
						env,
						opened.id,
					).restorePublishedSkill({
						sessionId: opened.id,
						userId: current.package.ownerUserId,
						commit: data.commit,
						name: current.skill.name,
					})
					if (!restored.changed)
						throw new Error(
							'This version of the skill matches the current one.',
						)
					await repoCommitCapability.handler(
						{
							session_id: opened.id,
							message: `Restore skill ${current.skill.name} from ${data.commit}`,
						},
						ctx,
					)
					const checks = (await repoRunChecksCapability.handler(
						{ session_id: opened.id },
						ctx,
					)) as {
						ok: boolean
						results: Array<{ ok: boolean; message: string }>
					}
					if (!checks.ok)
						throw new Error(
							`Publish checks failed: ${checks.results
								.filter((result) => !result.ok)
								.map((result) => result.message)
								.join(' ')}`,
						)
					const result = (await repoPublishSessionCapability.handler(
						{ session_id: opened.id },
						ctx,
					)) as { status: string; message: string; approval_url?: string }
					if (result.status !== 'ok' && !result.approval_url)
						throw new Error(result.message)
					retainSession = !!result.approval_url
					return {
						ok: result.status === 'ok',
						message:
							result.status === 'ok'
								? 'Skill restored as a new published version.'
								: result.message,
						approvalUrl: result.approval_url ?? null,
					}
				} finally {
					if (!retainSession) {
						try {
							await repoDiscardSessionCapability.handler(
								{ session_id: opened.id },
								ctx,
							)
						} catch (error) {
							console.error(
								'skill-restore-session-cleanup-failed',
								opened.id,
								error,
							)
						}
					}
				}
			},
		)
	})
