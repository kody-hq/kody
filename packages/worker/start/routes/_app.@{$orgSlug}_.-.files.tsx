import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { fileIdSchema } from '#universal/files.ts'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { filesPageQuery } from '../files-query.ts'
import { FilesPage } from '../pages/files.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/files')({
	validateSearch: (
		search: Record<string, unknown>,
	): {
		file?: string
		active?: string
		collection?: 'packages'
		repo?: string
		repoPath?: string
		repoOpen?: boolean
		trash?: boolean
		new?: boolean
		page?: boolean
		folder?: boolean
		parent?: string
	} => {
		if (search.collection === 'packages')
			return {
				collection: 'packages',
				repo: typeof search.repo === 'string' ? search.repo : undefined,
				repoPath:
					typeof search.repoPath === 'string' ? search.repoPath : undefined,
				repoOpen:
					search.repoOpen === true || search.repoOpen === 'true' || undefined,
			}
		const active =
			search.active === 'root'
				? 'root'
				: fileIdSchema.safeParse(search.active).data
		const id = fileIdSchema.safeParse(search.file)
		return id.success
			? { file: id.data, active }
			: search.trash === '1' || search.trash === true
				? { trash: true }
				: search.new === 'folder' ||
					  (search.new === true && search.folder === true)
					? {
							new: true,
							folder: true,
							parent: fileIdSchema.safeParse(search.parent).data,
						}
					: search.new === 'page' ||
						  (search.new === true && search.page === true)
						? {
								new: true,
								page: true,
								parent: fileIdSchema.safeParse(search.parent).data,
							}
						: search.new === '1' || search.new === true
							? {
									new: true,
									parent: fileIdSchema.safeParse(search.parent).data,
								}
							: { active }
	},
	loaderDeps: ({ search }) => ({ fileId: search.file }),
	staticData: {
		workspaceSwitch: { section: 'files' },
		navigation: { rail: 'workspace', item: 'files' },
		orgScope: { section: 'files' },
	},
	loader: ({ context, preload, params, deps }) =>
		loadPageQuery(
			context.queryClient,
			filesPageQuery(context.actorKey, {
				orgSlug: params.orgSlug,
				fileId: deps.fileId,
			}),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { orgSlug } = Route.useParams()
	const navigate = Route.useNavigate()
	const {
		file,
		active,
		collection,
		repo,
		repoPath,
		repoOpen,
		new: isNew,
		page,
		folder,
		parent,
		trash,
	} = Route.useSearch()
	const { actorKey } = Route.useRouteContext()
	const data = usePageQuery(
		filesPageQuery(actorKey, { orgSlug, fileId: file }),
	).data
	const byId = new Map(data.files.map((item) => [item.id, item]))
	const ancestors: string[] = []
	const seen = new Set<string>()
	let next = file ? byId.get(file)?.parentId : isNew ? parent : undefined
	while (next && !seen.has(next)) {
		seen.add(next)
		ancestors.push(next)
		next = byId.get(next)?.parentId
	}
	const navigation = JSON.stringify([
		orgSlug,
		collection,
		file,
		isNew,
		parent,
		trash,
		ancestors,
	])
	const [tree, setTree] = useState<{
		navigation: string
		orgSlug: string
		collapsed: ReadonlySet<string>
	}>(() => ({
		navigation,
		orgSlug,
		collapsed: new Set(collection === 'packages' ? [] : ['system:packages']),
	}))
	let collapsed = tree.collapsed
	if (tree.navigation !== navigation) {
		const revealed = new Set(tree.orgSlug === orgSlug ? tree.collapsed : [])
		for (const id of ancestors) revealed.delete(id)
		if (collection === 'packages') revealed.delete('system:packages')
		collapsed = revealed
		setTree({ navigation, orgSlug, collapsed: revealed })
	}
	function toggleBranch(id: string) {
		setTree((previous) => {
			const next = new Set(previous.collapsed)
			if (!next.delete(id)) next.add(id)
			return { ...previous, collapsed: next }
		})
	}

	return (
		<FilesPage
			key={
				file ??
				(isNew ? `new:${page}:${folder}:${parent}` : trash ? 'trash' : 'index')
			}
			finderActive={active}
			onFinderSelectionChange={(id) => {
				void navigate({
					search: (previous) => ({ ...previous, active: id ?? 'root' }),
					resetScroll: false,
				})
			}}
			data={data}
			initialCreating={isNew}
			initialPage={page}
			initialDirectory={folder}
			showTrash={trash}
			showPackages={collection === 'packages'}
			repo={repo}
			repoPath={repoPath}
			repoOpen={repoOpen}
			parentId={parent}
			collapsed={collapsed}
			onToggleBranch={toggleBranch}
		/>
	)
}
