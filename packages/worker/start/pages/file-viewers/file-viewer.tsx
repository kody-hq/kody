/** @jsxImportSource @emotion/react */
import { WorkspaceFileStatus } from '../workspace-file-status.tsx'
import { LoadingIndicator } from '../../components/loading-indicator.tsx'
import { Component, lazy, Suspense, type ReactNode } from 'react'
import { fileViewerKind } from '#universal/file-viewers.ts'
import { fileAssetUrl } from '#universal/file-assets.ts'
const ImageViewer = lazy(() =>
	import('../image-viewer.tsx').then((module) => ({
		default: module.ImageViewer,
	})),
)
const ZipViewer = lazy(() => import('./zip-file-viewer.tsx'))
const JsonViewer = lazy(() => import('./json-file-viewer.tsx'))
const NativeViewer = lazy(() => import('./native-file-viewer.tsx'))
const DocxViewer = lazy(() =>
	import('./office-file-viewer.tsx').then((module) => ({
		default: module.DocxViewer,
	})),
)
const XlsxViewer = lazy(() =>
	import('./office-file-viewer.tsx').then((module) => ({
		default: module.XlsxViewer,
	})),
)
const PptxViewer = lazy(() =>
	import('./office-file-viewer.tsx').then((module) => ({
		default: module.PptxViewer,
	})),
)
class PreviewBoundary extends Component<
	{ children: ReactNode; download: string },
	{ failed: boolean }
> {
	state = { failed: false }
	static getDerivedStateFromError() {
		return { failed: true }
	}
	render() {
		return this.state.failed ? (
			<WorkspaceFileStatus
				message="Could not preview this file."
				action={{ label: 'Download', href: this.props.download }}
			/>
		) : (
			this.props.children
		)
	}
}
export function FileViewer({
	orgSlug,
	fileId,
	revisionId,
	name,
	mediaType,
	inline = false,
	content,
	assetUrl,
}: {
	orgSlug: string
	fileId: string
	revisionId: string | null
	name: string
	mediaType: string
	inline?: boolean
	content?: string
	assetUrl?: string
}) {
	const kind = fileViewerKind(name, mediaType)
	const src = assetUrl ?? fileAssetUrl(orgSlug, fileId, revisionId),
		download = assetUrl
			? `${assetUrl}${assetUrl.includes('?') ? '&' : '?'}download=true`
			: fileAssetUrl(orgSlug, fileId, revisionId, true)
	const props = { src, name, download, inline, orgSlug }
	return (
		<PreviewBoundary key={src} download={download}>
			<Suspense fallback={<LoadingIndicator label="Loading preview…" />}>
				{!kind ? (
					<WorkspaceFileStatus
						message="Preview unavailable."
						action={{ label: 'Download', href: download }}
					/>
				) : kind === 'image' ? (
					<ImageViewer name={name} src={src} />
				) : kind === 'zip' ? (
					<ZipViewer {...props} />
				) : kind === 'json' ? (
					<JsonViewer {...props} content={content} />
				) : kind === 'docx' ? (
					<DocxViewer {...props} />
				) : kind === 'xlsx' ? (
					<XlsxViewer {...props} />
				) : kind === 'pptx' ? (
					<PptxViewer {...props} />
				) : (
					<NativeViewer {...props} kind={kind} />
				)}
			</Suspense>
		</PreviewBoundary>
	)
}
