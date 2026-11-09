/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useState } from 'react'
import { z } from 'zod'
import { loadPublicFile } from '#start/server/public-files'
import {
	PublicFileShell,
	SharedFileUnavailable,
} from '../pages/public-file-shell.tsx'
import {
	workspacePageMediaType,
	workspaceDirectoryMediaType,
} from '#universal/workspace-page.ts'
import { FileViewer } from '../pages/file-viewers/file-viewer.tsx'
import { HtmlPreview } from '../pages/file-viewers/html-file-viewer.tsx'
import { CsvPreview } from '../pages/file-viewers/csv-file-viewer.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { workspaceProse } from '../pages/workspace-prose.ts'
const PageEditor = lazy(() =>
	import('../pages/workspace-page-editor.tsx').then((module) => ({
		default: module.WorkspacePageEditor,
	})),
)
const Markdown = lazy(
	() => import('../pages/file-viewers/markdown-file-viewer.tsx'),
)
export const Route = createFileRoute('/shared-files/$orgSlug/$rootId/$token')({
	staticData: { shell: { mode: 'standalone', gutters: 'page' } },
	preload: false,
	staleTime: 0,
	validateSearch: z.object({
		item: z.uuid().optional(),
		use: z.coerce.boolean().optional(),
	}),
	loaderDeps: ({ search }) => ({ item: search.item }),
	loader: ({ params, deps }) =>
		loadPublicFile({ data: { ...params, itemId: deps.item } }),
	head: () => ({
		meta: [
			{ title: 'Shared file' },
			{ name: 'referrer', content: 'no-referrer' },
			{ name: 'robots', content: 'noindex,nofollow' },
		],
	}),
	component: SharedFile,
})
type Result = Awaited<ReturnType<typeof loadPublicFile>>
function SharedFile() {
	const result = Route.useLoaderData(),
		params = Route.useParams()
	const search = Route.useSearch()
	if (!result.ok) return <SharedFileUnavailable />
	return (
		<PublicFileShell
			scope={params}
			file={result.file}
			files={result.files}
			openUse={search.use}
		>
			{result.file.mediaType === workspacePageMediaType && (
				<h1
					css={{
						fontSize: 32,
						fontWeight: 700,
						letterSpacing: '-0.03em',
						maxWidth: workspaceProse.width,
						width: '100%',
						boxSizing: 'border-box',
						padding: '28px 28px 0',
						margin: '0 auto 18px',
					}}
				>
					{result.file.name}
				</h1>
			)}
			<PublicPreview result={result} depth={0} />
		</PublicFileShell>
	)
}

function PublicEmbed({ id, depth }: { id: string; depth: number }) {
	const params = Route.useParams(),
		[result, setResult] = useState<Result | null>(null)
	useEffect(() => {
		let active = true
		void loadPublicFile({ data: { ...params, itemId: id } }).then(
			(value) => {
				if (active) setResult(value)
			},
			() => {
				if (active) setResult({ ok: false })
			},
		)
		return () => {
			active = false
		}
	}, [params.orgSlug, params.rootId, params.token, id])
	if (!result) return <LoadingIndicator label="Loading file" />
	if (!result.ok) return <span>File unavailable</span>
	return (
		<div css={{ minHeight: 240, display: 'flex', flexDirection: 'column' }}>
			<PublicPreview result={result} depth={depth} />
		</div>
	)
}
function PublicPreview({
	result,
	depth,
}: {
	result: Extract<Result, { ok: true }>
	depth: number
}) {
	const params = Route.useParams(),
		file = result.file
	const src = `/shared-file-assets/${params.orgSlug}/${params.rootId}/${params.token}/${file.id}`
	if (file.mediaType === workspaceDirectoryMediaType) return null
	if (file.mediaType === workspacePageMediaType)
		return (
			<div
				css={{
					maxWidth: workspaceProse.width,
					width: '100%',
					marginInline: 'auto',
					padding: depth ? 0 : '0 28px 28px',
					boxSizing: 'border-box',
				}}
			>
				<Suspense fallback={<LoadingIndicator label="Loading page" />}>
					<PageEditor
						content={file.content}
						files={[]}
						renderFile={(id) =>
							depth < 3 ? (
								<PublicEmbed id={id} depth={depth + 1} />
							) : (
								<SiteLink
									href={`/shared-files/${params.orgSlug}/${params.rootId}/${params.token}?item=${id}`}
								>
									Open file
								</SiteLink>
							)
						}
					/>
				</Suspense>
			</div>
		)
	if (file.mediaType === 'text/html')
		return (
			<HtmlPreview
				orgSlug={params.orgSlug}
				content={file.content}
				inline={depth > 0}
				fill={depth === 0}
			/>
		)
	if (file.mediaType === 'text/csv')
		return <CsvPreview content={file.content} />
	if (file.mediaType === 'text/markdown')
		return (
			<article
				css={{
					...workspaceProse.body,
					maxWidth: workspaceProse.width,
					width: '100%',
					marginInline: 'auto',
					padding: 24,
					boxSizing: 'border-box',
				}}
			>
				<Suspense fallback={<LoadingIndicator label="Loading document" />}>
					<Markdown content={file.content} />
				</Suspense>
			</article>
		)
	if (file.encoding !== 'base64' && file.mediaType.startsWith('text/'))
		return (
			<pre css={{ whiteSpace: 'pre-wrap', padding: 20 }}>{file.content}</pre>
		)
	return (
		<div
			css={{
				flex: 1,
				minHeight: depth ? 240 : '70vh',
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			<FileViewer
				orgSlug={params.orgSlug}
				fileId={file.id}
				revisionId={null}
				name={file.name}
				mediaType={file.mediaType}
				content={file.encoding === 'base64' ? undefined : file.content}
				assetUrl={src}
				inline={depth > 0}
			/>
		</div>
	)
}
