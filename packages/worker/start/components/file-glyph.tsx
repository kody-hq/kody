import { fileViewerKind } from '#universal/file-viewers.ts'
import {
	workspaceDirectoryMediaType,
	workspacePageMediaType,
} from '#universal/workspace-page.ts'
import { colors } from '#universal/styles/tokens.ts'

export function FileGlyph({
	mediaType,
	name = '',
}: {
	mediaType: string
	name?: string
}) {
	const kind = fileViewerKind(name, mediaType)
	const palette = {
		folder: 'light-dark(#347bae, #83b8de)',
		page: 'light-dark(#4c6fa6, #93b3df)',
		image: 'light-dark(#7b4fb3, #b99bea)',
		video: 'light-dark(#a43b68, #e18aad)',
		audio: 'light-dark(#087d82, #6fc4c7)',
		sheet: 'light-dark(#2d7a49, #80c59a)',
		document: 'light-dark(#2563a8, #7db6f2)',
		slide: 'light-dark(#b45c25, #e9a371)',
		pdf: 'light-dark(#be4545, #ed9292)',
		archive: 'light-dark(#946d16, #d6ba6a)',
		code: 'light-dark(#a76b1b, #dbb878)',
		markdown: 'light-dark(#576aa6, #a3afdf)',
	}
	const color =
		mediaType === workspaceDirectoryMediaType
			? palette.folder
			: mediaType === workspacePageMediaType
				? palette.page
				: kind === 'image'
					? palette.image
					: kind === 'video'
						? palette.video
						: kind === 'audio'
							? palette.audio
							: kind === 'xlsx' || mediaType === 'text/csv'
								? palette.sheet
								: kind === 'docx'
									? palette.document
									: kind === 'pptx'
										? palette.slide
										: kind === 'pdf'
											? palette.pdf
											: kind === 'zip'
												? palette.archive
												: kind === 'json' || mediaType === 'text/html'
													? palette.code
													: mediaType === 'text/markdown'
														? palette.markdown
														: colors.textMuted

	if (mediaType === workspaceDirectoryMediaType)
		return (
			<svg
				aria-hidden="true"
				style={{ color, flexShrink: 0 }}
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinejoin="round"
			>
				<path d="M1.5 4V2.8h5l1.5 1.7h6.5v8.7h-13z" />
				<path d="M1.5 5.5h13" />
			</svg>
		)
	const detail =
		kind === 'image'
			? 'm4.8 11.5 2.3-3 1.5 1.8 1-1.2 1.6 2.4'
			: kind === 'xlsx' || mediaType === 'text/csv'
				? 'M5.2 7.5h5.6v4.7H5.2zM5.2 9.85h5.6M8 7.5v4.7'
				: kind === 'json' || mediaType === 'text/html'
					? 'm6.8 8-2 2 2 2m2.4-4 2 2-2 2'
					: kind === 'video'
						? 'm6 7.2 4.5 2.6L6 12.4z'
						: kind === 'audio'
							? 'M9.7 7v4.1a1.3 1.3 0 1 1-1.3-1.3M9.7 7l-2 .5'
							: kind === 'zip'
								? 'M7.5 6.5h1M8.5 8h-1M7.5 9.5h1M7.5 11h1v1.5h-1z'
								: kind === 'pptx'
									? 'M5 7h6v4H5zM8 11v1.5M6.5 12.5h3'
									: 'M5.4 8h5.2M5.4 10.7h4'

	return (
		<svg
			aria-hidden="true"
			style={{ color, flexShrink: 0 }}
			width="15"
			height="15"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
		>
			<path
				d="M3.5 1.8h5.6l3.4 3.4v9h-9zM9 1.8v3.6h3.5"
				strokeLinejoin="round"
			/>
			<path d={detail} />
		</svg>
	)
}
