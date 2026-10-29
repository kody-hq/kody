import { createServerFn } from '@tanstack/react-start'
import { notFound } from '@tanstack/react-router'
import { z } from 'zod'

export const loadSkillsPage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			skill: z.string().optional(),
			file: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const [{ loadScopedCollection }, { createMcpCallerContext }, catalogTools] =
			await Promise.all([
				import('./collection-context.ts'),
				import('#mcp/context.ts'),
				import('#mcp/skills/skills-catalog.ts'),
			])
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
		const catalog = await catalogTools.loadCallerSkillsCatalog({
			env,
			callerContext,
			failOnError: true,
		})
		const skills = catalogTools
			.listCatalogSkills(catalog)
			.map(({ package: pkg, skill }) => ({
				uri: skill.uri,
				name: skill.name,
				description: skill.frontmatter.description,
				packageName: pkg.index.kodyId,
				packageId: pkg.packageId,
				commit: pkg.index.publishedCommit,
				files: skill.resources.map((file) => ({
					uri: file.uri,
					path: file.relativePath,
					size: file.size,
				})),
			}))
			.sort(
				(a, b) =>
					a.name.localeCompare(b.name) ||
					a.packageName.localeCompare(b.packageName),
			)
		const selected = data.skill
			? skills.find((skill) => skill.uri === data.skill)
			: null
		if (data.skill && !selected) throw notFound()
		const file = selected?.files.find(
			(file) => file.uri === (data.file ?? selected.uri),
		)
		if (selected && !file) throw notFound()
		const content = file
			? (
					await catalogTools.readCatalogSkillResource({
						env,
						callerContext,
						catalog,
						uri: file.uri,
					})
				).contents[0]
			: null
		const { issueSkillReadReceipt, catalogReadResource } =
			await import('#worker/package-registry/skill-read-events.ts')
		const match = file
			? catalogTools
					.listCatalogSkillResources(catalog)
					.find(({ resource }) => resource.uri === file.uri)
			: null
		const readReceipt =
			match && user.request.actor
				? await issueSkillReadReceipt(env.COOKIE_SECRET, {
						resource: catalogReadResource(match),
						actorId: user.request.actor.userId,
						orgId: user.request.org.id,
						channel: 'skills-page',
					})
				: null
		const { highlightSnippets, highlightMarkdownFences } =
			await import('#app/highlight-code.ts')
		const text = content && 'text' in content ? (content.text ?? null) : null
		const { languageFromFilePath } = await import('#universal/package-files.ts')
		const highlighted =
			text !== null && file
				? ((
						await highlightSnippets(env, [
							{
								code: text,
								lang: languageFromFilePath(file.path) ?? 'plaintext',
							},
						])
					)[0] ?? null)
				: null
		const fences =
			text !== null && file?.path.endsWith('.md')
				? await highlightMarkdownFences(env, text)
				: []
		const { loadSkillMetrics } = await import('#app/skill-metrics.ts')
		return {
			orgSlug: data.orgSlug,
			readReceipt,
			highlighted,
			fences,
			metrics: await loadSkillMetrics({ env, callerContext, catalog }),
			skills,
			selected: selected ?? null,
			file: file ?? null,
			content: content ?? null,
		}
	})

/** Explicit acknowledgement of a signed, authorized file response. Never run by preloads. */
export const recordSkillPageRead = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			receipt: z.string().max(16000),
			eventId: z.uuid(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadScopedCollection },
			{ createMcpCallerContext },
			{ recordSkillRead, verifySkillReadReceipt },
			{ authorize, packageResource },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('#mcp/context.ts'),
			import('#worker/package-registry/skill-read-events.ts'),
			import('#worker/authorization/authorize.ts'),
		])
		const {
			bindings: env,
			request,
			user,
		} = await loadScopedCollection({
			orgSlug: data.orgSlug,
			section: 'skills',
			returnTo: `/@${data.orgSlug}/-/skills`,
		})
		const receipt = await verifySkillReadReceipt(
			env.COOKIE_SECRET,
			data.receipt,
		)
		if (
			receipt.orgId !== user.request.org.id ||
			receipt.actorId !== user.request.actor?.userId
		)
			throw notFound()
		const callerContext = {
			...createMcpCallerContext({
				baseUrl: new URL(request.url).origin,
				user: user.mcpUser,
				source: { kind: 'session' },
			}),
			request: user.request,
		}
		const { getSavedPackageById } =
			await import('#worker/package-registry/repo.ts')
		const pkg = await getSavedPackageById(env.APP_DB, {
			userId: receipt.resource.packageOwnerId,
			packageId: receipt.resource.packageId,
		})
		if (!pkg) throw notFound()
		await authorize(
			{ env, request: user.request },
			'package:read',
			packageResource(pkg),
		)
		await recordSkillRead({
			env,
			callerContext,
			channel: receipt.channel,
			resource: receipt.resource,
			eventId: data.eventId,
		})
		return { ok: true }
	})
