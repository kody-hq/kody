/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type ReactNode, useState, useMemo } from 'react'
import { SiteLink } from './site-link.tsx'

import { CopyTextButton } from './copy-text-button.tsx'

import { matchesSearchQuery } from '#client/search-filter.ts'
import { renderMarkdownNodes } from './markdown-view.tsx'
import { renderHighlightedCode } from './syntax-highlight.tsx'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import {
	isPackageFilesMediaKind,
	packageFileBaseName,
	packageFileKindLabel,
} from '#universal/package-file-media.ts'
import {
	buildPackageFilesAncestors,
	joinPackageFilesPath,
	listPackageFilesChildren,
	packageFileLanguageLabel,
} from '#universal/package-files.ts'
import { directoryOfPackageFilePath } from '#universal/package-readme-images.ts'
import { usePackageInstall } from '../use-package-install.ts'
import { renderInstallStrip } from './community-detail-sections.tsx'
import { PackageInstallContext } from './package-title-actions.tsx'
import { renderPackageRepoActions } from './package-title-actions.tsx'
import { renderPackageRepoChrome } from './package-repo-nav.tsx'
import { renderIcon } from './icon.tsx'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	packageDetailPageCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'

/** Directories on the way to `path`, which open so the file is in view. */
function ancestorDirectories(path: string) {
	return buildPackageFilesAncestors(path)
		.map((ancestor) => ancestor.path)
		.filter((candidate) => candidate !== path)
}

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileByteLength(data: PackageFilesLoaderData) {
	if (typeof data.contentByteLength === 'number') return data.contentByteLength
	if (data.content) return new TextEncoder().encode(data.content).byteLength
	return 0
}

function countLines(value: string) {
	return value.replace(/\n$/, '').split('\n').length
}

export function PackageFilesExplorer(props: {
	data: PackageFilesLoaderData
	busy?: boolean
}) {
	const install = usePackageInstall(props.data.repoActions?.fork ?? null)
	return (
		<PackageInstallContext.Provider value={install.context}>
			<PackageFilesExplorerContent
				{...props}
				installStrip={renderInstallStrip(install)}
			/>
		</PackageInstallContext.Provider>
	)
}

function PackageFilesExplorerContent({
	data,
	busy,
	installStrip,
}: {
	data: PackageFilesLoaderData
	busy?: boolean
	installStrip?: ReactNode
}) {
	const [expanded, setExpanded] = useState(
		() =>
			new Set([
				...ancestorDirectories(data.selectedPath),
				...(data.kind === 'directory' && data.selectedPath
					? [data.selectedPath]
					: []),
			]),
	)
	const [openedFor, setOpenedFor] = useState(data.selectedPath)
	const [query, setQuery] = useState('')
	if (openedFor !== data.selectedPath) {
		setOpenedFor(data.selectedPath)
		setQuery('')
		setExpanded(
			(previous) =>
				new Set([
					...previous,
					...ancestorDirectories(data.selectedPath),
					...(data.kind === 'directory' && data.selectedPath
						? [data.selectedPath]
						: []),
				]),
		)
	}
	function toggleDirectory(path: string) {
		setExpanded((previous) => {
			const next = new Set(previous)
			if (next.has(path)) next.delete(path)
			else next.add(path)
			return next
		})
	}
	function collapseAll() {
		setExpanded(new Set())
	}
	const contentNode = useMemo(() => renderContent(data), [data])

	const showRepoChrome = Boolean(data.username && data.kodyId)

	return (
		<article
			css={articleCss}
			data-testid="package-files"
			// The previous file stays on screen while the next one loads, so
			// assistive tech is told the region is mid-update.
			aria-busy={busy ? 'true' : undefined}
		>
			{showRepoChrome && data.username && data.kodyId ? (
				renderPackageRepoChrome({
					username: data.username,
					kodyId: data.kodyId,
					isPrivate: data.isPrivate ?? false,
					isListed: data.isListed === true,
					hasPackage: data.hasPackage,
					viewerIsOwner: data.viewerIsOwner ?? false,
					viewerCanManage: data.viewerCanManage ?? false,
					viewerCanManageAccess: data.viewerCanManageAccess,
					active: 'files',
					actions: renderPackageRepoActions(data.repoActions ?? null),
					filesHref: data.filesBasePath,
					description: data.description,
					ownerProfilePublic: data.ownerProfilePublic,
					iconUrl: data.iconUrl ?? null,
					iconName: data.kodyId,
				})
			) : (
				<>
					<SiteLink href={data.backHref} css={backLinkCss}>
						{arrowLeftIcon()} {data.backLabel}
					</SiteLink>
					<header css={headCss}>
						<h1 css={titleCss}>{data.title}</h1>
					</header>
				</>
			)}
			{installStrip}
			<div css={layoutCss}>
				<nav aria-label="Files" css={treeCss}>
					<div css={treeHeadCss}>
						<h2 css={treeHeadingCss}>Files</h2>
						{/* Always rendered so the row keeps its height — appearing and
							    disappearing shifted the filter and tree below it. */}
						<button
							type="button"
							disabled={expanded.size === 0}
							css={
								expanded.size > 0 ? collapseButtonCss : collapseButtonHiddenCss
							}
							onClick={collapseAll}
						>
							Collapse all
						</button>
					</div>
					<div css={filterWrapCss}>
						<div css={filterFieldCss}>
							<span css={filterIconCss}>{searchIcon()}</span>
							<input
								type="text"
								role="searchbox"
								inputMode="search"
								autoComplete="off"
								placeholder="Go to file"
								aria-label="Filter files"
								css={filterInputCss}
								value={query}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
						</div>
					</div>
					<div css={treeScrollCss}>
						{query.trim()
							? renderMatches(data, query)
							: renderTree(
									data.paths,
									'',
									data.selectedPath,
									data.filesBasePath,
									expanded,
									toggleDirectory,
									0,
								)}
					</div>
				</nav>
				<section css={contentCss} aria-label="Selected file">
					{contentNode}
				</section>
			</div>
		</article>
	)
}

const maxFilterMatches = 100

function renderMatches(data: PackageFilesLoaderData, query: string): ReactNode {
	const matches = data.paths.filter((path) => matchesSearchQuery(query, [path]))
	if (matches.length === 0) {
		return <p css={emptyCss}>No file matches that filter.</p>
	}
	const overflow = matches.length - maxFilterMatches
	return (
		<ul css={treeListCss}>
			{matches.slice(0, maxFilterMatches).map((path) => {
				const slash = path.lastIndexOf('/')
				const name = slash === -1 ? path : path.slice(slash + 1)
				const directory = slash === -1 ? '' : path.slice(0, slash)
				return (
					<li key={path}>
						<SiteLink
							href={joinPackageFilesPath(data.filesBasePath, path)}
							aria-current={data.selectedPath === path ? 'page' : undefined}
							css={data.selectedPath === path ? rowCurrentCss : rowCss}
						>
							<span css={rowIconCss}>{fileIcon()}</span>
							<span css={rowNameCss}>{name}</span>
							{directory ? <span css={rowMetaCss}>{directory}</span> : null}
						</SiteLink>
					</li>
				)
			})}
			{overflow > 0 ? (
				<li>
					<p css={emptyCss}>…and {overflow} more. Keep typing to narrow.</p>
				</li>
			) : null}
		</ul>
	)
}

function renderTree(
	paths: Array<string>,
	directoryPath: string,
	selectedPath: string,
	filesBasePath: string,
	expanded: Set<string>,
	toggleDirectory: (path: string) => void,
	depth: number,
): ReactNode {
	const children = listPackageFilesChildren(paths, directoryPath)
	if (children.length === 0 && directoryPath === '') {
		return <p css={emptyCss}>No published files.</p>
	}
	return (
		<ul css={treeListCss}>
			{children.map((child) => {
				const href = joinPackageFilesPath(filesBasePath, child.path)
				const current = selectedPath === child.path
				const isDirectory = child.kind === 'directory'
				const isOpen = isDirectory && expanded.has(child.path)
				return (
					<li key={child.path}>
						<div css={rowShellCss} style={{ paddingLeft: depth * 14 }}>
							{isDirectory ? (
								<button
									type="button"
									aria-expanded={isOpen ? 'true' : 'false'}
									aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${child.name}`}
									css={chevronButtonCss}
									onClick={() => toggleDirectory(child.path)}
								>
									<span css={isOpen ? chevronOpenCss : chevronCss}>
										{chevronIcon()}
									</span>
								</button>
							) : (
								<span css={chevronSpacerCss} aria-hidden="true" />
							)}
							<SiteLink
								href={href}
								aria-current={current ? 'page' : undefined}
								css={current ? rowCurrentCss : rowCss}
							>
								<span css={isDirectory ? rowDirIconCss : rowIconCss}>
									{isDirectory ? directoryIcon() : fileIcon()}
								</span>
								<span css={rowNameCss}>{child.name}</span>
							</SiteLink>
						</div>
						{isOpen
							? renderTree(
									paths,
									child.path,
									selectedPath,
									filesBasePath,
									expanded,
									toggleDirectory,
									depth + 1,
								)
							: null}
					</li>
				)
			})}
		</ul>
	)
}

function renderContent(data: PackageFilesLoaderData): ReactNode {
	if (data.kind === 'directory' && !data.content) {
		return (
			<div>
				<div css={contentToolbarCss}>
					<div css={contentHeadingWrapCss}>
						<span css={headingIconCss}>{directoryIcon()}</span>
						<h2 css={contentHeadingCss}>
							{data.selectedPath ? data.selectedPath : 'Package root'}
						</h2>
					</div>
				</div>
				{data.children.length === 0 ? (
					<p css={emptyCss}>This folder is empty.</p>
				) : (
					<ul css={dirListCss}>
						{data.children.map((child) => (
							<li key={child.path}>
								<SiteLink
									href={joinPackageFilesPath(data.filesBasePath, child.path)}
									css={dirLinkCss}
								>
									<span
										css={
											child.kind === 'directory' ? rowDirIconCss : rowIconCss
										}
									>
										{child.kind === 'directory' ? directoryIcon() : fileIcon()}
									</span>
									<span css={rowNameCss}>{child.name}</span>
								</SiteLink>
							</li>
						))}
					</ul>
				)}
			</div>
		)
	}

	const heading = data.contentPath ?? data.selectedPath
	const body = data.content ?? ''
	const kindLabel =
		packageFileKindLabel(data.contentPath, data.contentKind) ||
		packageFileLanguageLabel(data.contentPath)
	const byteLength = fileByteLength(data)
	const showTextMeta =
		Boolean(body) && !isPackageFilesMediaKind(data.contentKind)
	return (
		<div>
			<div css={contentToolbarCss}>
				<div css={contentHeadingWrapCss}>
					<span css={headingIconCss}>{fileIcon()}</span>
					<h2 css={contentHeadingCss} title={heading}>
						{heading}
					</h2>
					{byteLength > 0 || kindLabel ? (
						<span css={contentMetaCss}>
							{showTextMeta ? `${countLines(body)} lines · ` : ''}
							{byteLength > 0 ? formatBytes(byteLength) : ''}
							{kindLabel ? `${byteLength > 0 ? ' · ' : ''}${kindLabel}` : ''}
						</span>
					) : null}
				</div>
				<div css={contentActionsCss}>
					{data.rawHref ? (
						<a
							href={data.rawHref}
							data-testid="package-files-raw-link"
							aria-label={`View raw ${heading}`}
							css={rawLinkCss}
						>
							Raw
						</a>
					) : null}
					{body &&
					data.contentKind !== 'binary' &&
					!isPackageFilesMediaKind(data.contentKind) ? (
						<CopyTextButton
							value={body}
							idleLabel="Copy"
							variant="ghost"
							size="sm"
							ariaLabel={`Copy ${heading}`}
						/>
					) : null}
				</div>
			</div>
			{renderFilePreview(data, heading, body)}
		</div>
	)
}

function renderFilePreview(
	data: PackageFilesLoaderData,
	heading: string,
	body: string,
): ReactNode {
	const contentKind = data.contentKind
	switch (contentKind) {
		case 'markdown':
			return (
				<div css={markdownCss} data-testid="package-files-markdown">
					{renderMarkdownNodes(body, {
						fences: data.contentFences,
						imageBaseHref: data.imageBaseHref ?? undefined,
						imageFromDirectory: directoryOfPackageFilePath(data.contentPath),
					})}
				</div>
			)
		case 'image': {
			if (!data.mediaHref) {
				throw new Error(`Image preview is missing a raw href for ${heading}.`)
			}
			const name = packageFileBaseName(heading)
			return (
				<div css={mediaPreviewCss} data-testid="package-files-image">
					{/* SVG is XSS-sensitive: preview only via <img src> to the
					    allowlisted /raw/ route. Never inject SVG markup. */}
					<img src={data.mediaHref} alt={name} css={mediaImageCss} />
				</div>
			)
		}
		case 'video': {
			if (!data.mediaHref) {
				throw new Error(`Video preview is missing a raw href for ${heading}.`)
			}
			return (
				<div css={mediaPreviewCss} data-testid="package-files-video">
					{/* oxlint-disable-next-line jsx-a11y/media-has-caption -- repo videos have no sidecar captions; filename is the accessible name */}
					<video
						src={data.mediaHref}
						controls
						preload="metadata"
						aria-label={packageFileBaseName(heading)}
						css={mediaVideoCss}
					>
						Your browser cannot play this video.
					</video>
				</div>
			)
		}
		case 'audio': {
			if (!data.mediaHref) {
				throw new Error(`Audio preview is missing a raw href for ${heading}.`)
			}
			return (
				<div css={mediaPreviewCss} data-testid="package-files-audio">
					{/* oxlint-disable-next-line jsx-a11y/media-has-caption -- repo audio has no sidecar captions; filename is the accessible name */}
					<audio
						src={data.mediaHref}
						controls
						preload="metadata"
						aria-label={packageFileBaseName(heading)}
						css={mediaAudioCss}
					>
						Your browser cannot play this audio.
					</audio>
				</div>
			)
		}
		case 'binary':
			return (
				<p css={binaryCss} data-testid="package-files-binary">
					This is a binary file and cannot be previewed.
				</p>
			)
		case 'code':
		case 'text':
		case null:
			return (
				<div css={codeCss} data-testid="package-files-code">
					{renderHighlightedCode(
						data.contentHighlighted ??
							plainHighlightedCode(body, data.language ?? 'plaintext'),
					)}
				</div>
			)
		default: {
			const exhaustive: never = contentKind
			throw new Error(`Unknown package file content kind: ${exhaustive}`)
		}
	}
}

function arrowLeftIcon() {
	return renderIcon('arrow-left', { size: '14' })
}

function chevronIcon() {
	return renderIcon('chevron-right', { size: '12' })
}

function directoryIcon() {
	return renderIcon('folder', { size: '15' })
}

function fileIcon() {
	return renderIcon('file', { size: '15' })
}

function searchIcon() {
	return renderIcon('search', { size: '14' })
}

// Same box as the site header (`navCss`): `layoutMaxWidths.extended` centered,
// inset by `pageGutter`. A container that picks its own padding renders wider
// than the nav above it.
// This route owns its gutters — the shell leaves it unpadded (`app.tsx`), so
// the same box as the site header lines the two up at every width.
const articleCss = packageDetailPageCss

const backLinkCss = {
	// Pinned out of the `page` transition with the rest of the explorer chrome.
	viewTransitionName: 'files-back',
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': { color: colors.text },
} satisfies CSSObject

const headCss = {
	// Lifted out of the `page` view transition (see `public/styles.css`) so the
	// title does not slide on every in-explorer file switch.
	viewTransitionName: 'files-head',
	// The back link reads as part of this head, so it sits tight to the title.
	marginTop: spacing.sm,
	display: 'grid',
	gap: spacing.xs,
} satisfies CSSObject

const titleCss = {
	margin: 0,
	fontSize: typography.fontSize['2xl'],
	fontWeight: typography.fontWeight.semibold,
	overflowWrap: 'anywhere' as const,
} satisfies CSSObject

// Two columns need room for both: below the tablet breakpoint the blob is too
// narrow to read code in, so the tree moves above it and runs full width.
const layoutCss = {
	marginTop: spacing.lg,
	display: 'grid',
	gridTemplateColumns: '18.75rem minmax(0, 1fr)',
	gap: spacing.lg,
	alignItems: 'start',
	[mq.tablet]: {
		gridTemplateColumns: 'minmax(0, 1fr)',
		gap: spacing.md,
	},
} satisfies CSSObject

const treeCss = {
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	minWidth: 0,
	viewTransitionName: 'files-tree',
	// 5rem clears the sticky site header, as on the timeline and account nav.
	position: 'sticky' as const,
	top: '5rem',
	[mq.tablet]: {
		position: 'static' as const,
	},
} satisfies CSSObject

const treeHeadCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
	padding: `${spacing.md} ${spacing.md} ${spacing.sm}`,
} satisfies CSSObject

const treeHeadingCss = {
	margin: 0,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	letterSpacing: '0.02em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
} satisfies CSSObject

const collapseButtonCss = {
	padding: spacing.xs,
	border: 'none',
	background: 'transparent',
	color: colors.textMuted,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
	cursor: 'pointer',
	'&:hover': { color: colors.text },
} satisfies CSSObject

// Holds its space in the layout; `visibility` also drops it from the
// accessibility tree and out of tab order.
const collapseButtonHiddenCss = {
	...collapseButtonCss,
	visibility: 'hidden' as const,
} satisfies CSSObject

const filterWrapCss = {
	padding: `0 ${spacing.md} ${spacing.sm}`,
} satisfies CSSObject

// The icon is positioned against the input, not the padded wrapper around it —
// anchoring it to the wrapper puts it outside the field by the padding.
const filterFieldCss = {
	position: 'relative' as const,
	display: 'flex',
	alignItems: 'center',
} satisfies CSSObject

const filterIconCss = {
	position: 'absolute' as const,
	left: '0.625rem',
	top: '50%',
	translate: '0 -50%',
	display: 'inline-flex',
	color: colors.textMuted,
	pointerEvents: 'none' as const,
} satisfies CSSObject

const filterInputCss = {
	width: '100%',
	minWidth: 0,
	height: '2rem',
	padding: `0 ${spacing.sm} 0 1.875rem`,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.sm,
	backgroundColor: colors.background,
	color: colors.text,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	boxSizing: 'border-box' as const,
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '-1px',
		borderColor: 'transparent',
	},
} satisfies CSSObject

const treeScrollCss = {
	maxHeight: '38rem',
	overflowY: 'auto' as const,
	padding: `0 ${spacing.sm} ${spacing.sm}`,
	// Stacked above the file, the tree must not push the content off-screen.
	[mq.tablet]: {
		maxHeight: '18rem',
	},
} satisfies CSSObject

const treeListCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	'& ul': {
		margin: 0,
		padding: 0,
		listStyle: 'none',
	},
} satisfies CSSObject

const rowShellCss = {
	display: 'flex',
	alignItems: 'center',
	minWidth: 0,
} satisfies CSSObject

const chevronButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flex: 'none',
	width: '1.25rem',
	height: '2rem',
	padding: 0,
	border: 'none',
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	'&:hover': { color: colors.text },
} satisfies CSSObject

const chevronSpacerCss = {
	flex: 'none',
	width: '1.25rem',
} satisfies CSSObject

const chevronCss = {
	display: 'inline-flex',
	transition: `rotate ${transitions.fast}`,
	rotate: '0deg',
} satisfies CSSObject

const chevronOpenCss = {
	...chevronCss,
	rotate: '90deg',
} satisfies CSSObject

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flex: 1,
	minWidth: 0,
	height: '2rem',
	padding: `0 ${spacing.sm}`,
	borderRadius: radius.sm,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	textDecoration: 'none',
	'&:hover': {
		backgroundColor: colors.primarySoftest,
		color: colors.primaryText,
	},
} satisfies CSSObject

const rowCurrentCss = {
	...rowCss,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
} satisfies CSSObject

const rowIconCss = {
	display: 'inline-flex',
	flex: 'none',
	color: colors.textMuted,
} satisfies CSSObject

const rowDirIconCss = {
	display: 'inline-flex',
	flex: 'none',
	color: colors.primaryText,
} satisfies CSSObject

const rowNameCss = {
	flex: 1,
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
} satisfies CSSObject

const rowMetaCss = {
	flex: 'none',
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.normal,
	color: colors.textMuted,
} satisfies CSSObject

const contentCss = {
	// Named so the file pane cross-fades in place instead of sliding up with
	// the page; its group is pinned so the box does not morph between the
	// old and new file's heights.
	viewTransitionName: 'files-blob',
	minWidth: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	overflow: 'hidden',
} satisfies CSSObject

const contentToolbarCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	padding: `${spacing.sm} ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
} satisfies CSSObject

const contentActionsCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
}

const rawLinkCss = {
	...getGhostButtonCss({ size: 'sm' }),
	textDecoration: 'none',
}

const contentHeadingWrapCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
	color: colors.textMuted,
} satisfies CSSObject

const headingIconCss = {
	display: 'inline-flex',
	flex: 'none',
} satisfies CSSObject

// `overflow-wrap: anywhere` broke the path one character per line as soon as
// the toolbar squeezed it; the path truncates instead, with the full location
// in the title tooltip and the tree alongside.
const contentHeadingCss = {
	margin: 0,
	minWidth: 0,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
} satisfies CSSObject

const contentMetaCss = {
	flex: 'none',
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
	[mq.mobile]: {
		display: 'none',
	},
} satisfies CSSObject

// Rendered markdown is prose, so it gets the reading inset the code view gets
// from its own gutter and `pre` padding.
const markdownCss = {
	...proseCss,
	padding: spacing.lg,
	// The panel supplies the inset, so the prose block adds none of its own and
	// the first block — a heading here, which `proseCss` only zeroes for a
	// leading paragraph — starts flush with the padding.
	marginTop: 0,
	'& > :first-child': {
		marginTop: 0,
	},
	// Guide/blog `proseCss` tables keep real column layout. README files
	// sit in a narrower explorer column, so this view still sizes to
	// `max-content` and scrolls instead of wrapping every cell.
	'& table': {
		display: 'block',
		width: 'max-content',
		maxWidth: '100%',
		overflowX: 'auto',
		margin: '1.15rem 0 0',
		borderCollapse: 'collapse',
		fontSize: typography.fontSize.sm,
	},
	'& th, & td': {
		padding: `${spacing.sm} ${spacing.md}`,
		border: `1px solid ${colors.border}`,
		textAlign: 'left' as const,
		verticalAlign: 'top' as const,
	},
	'& th': {
		fontWeight: typography.fontWeight.semibold,
		backgroundColor: colors.background,
		whiteSpace: 'nowrap' as const,
	},
	'& td code': {
		whiteSpace: 'nowrap' as const,
	},
	'& img': {
		display: 'block',
		maxWidth: '100%',
		height: 'auto',
		margin: '1.15rem 0 0',
		borderRadius: radius.md,
		border: `1px solid ${colors.border}`,
	},
} satisfies CSSObject

// Line numbers ride Shiki's own `.line` spans as a CSS counter, so the
// highlighter keeps emitting one flat token tree.
const packageFileLineNumberWidth = '2.5rem'

const codeCss = {
	'& pre': {
		margin: 0,
		padding: `${spacing.md} 0`,
		overflowX: 'auto' as const,
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.8125rem',
		lineHeight: 1.55,
	},
	// Padding lives on `code`, not the .line spans, so the fallback output
	// (plaintext before the Shiki chunk resolves, or an oversized file) gets
	// the same gutters as highlighted lines.
	//
	// `fit-content` + min-width: 100% sizes `code` to the longest line (and
	// at least the pane). Block `.line` children stretch to that box so
	// hover paint covers the full scroll width, not just the tokens.
	'& code': {
		display: 'block',
		width: 'fit-content',
		minWidth: '100%',
		paddingInline: spacing.md,
		counterReset: 'package-file-line',
	},
	'& .line': {
		display: 'block',
		position: 'relative' as const,
		// Tab stops start at the content edge. An in-flow number + gap ate
		// into the first tab stop, so a leading tab was shorter than later
		// tabs on the same line. Keep the gutter as padding and paint the
		// number on top so every tab is a full `tab-size`.
		paddingInlineStart: `calc(${packageFileLineNumberWidth} + ${spacing.md})`,
		minHeight: '1.55em',
		counterIncrement: 'package-file-line',
	},
	'& .line:hover': {
		backgroundColor: colors.primarySoftest,
	},
	'& .line::before': {
		content: 'counter(package-file-line)',
		position: 'absolute' as const,
		insetInlineStart: 0,
		width: packageFileLineNumberWidth,
		textAlign: 'right' as const,
		color: colors.textMuted,
		opacity: 0.65,
		userSelect: 'none' as const,
	},
} satisfies CSSObject

const mediaPreviewCss = {
	display: 'flex',
	justifyContent: 'center',
	alignItems: 'center',
	padding: spacing.lg,
	minHeight: '12rem',
	backgroundColor: colors.background,
} satisfies CSSObject

const mediaImageCss = {
	display: 'block',
	maxWidth: '100%',
	maxHeight: '36rem',
	height: 'auto',
	borderRadius: radius.sm,
} satisfies CSSObject

const mediaVideoCss = {
	display: 'block',
	width: '100%',
	maxWidth: '40rem',
	maxHeight: '36rem',
	backgroundColor: colors.surface,
} satisfies CSSObject

const mediaAudioCss = {
	width: '100%',
	maxWidth: '28rem',
} satisfies CSSObject

const binaryCss = {
	margin: 0,
	padding: spacing.lg,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject

const emptyCss = {
	margin: `${spacing.sm} ${spacing.sm}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject

const dirListCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
} satisfies CSSObject

const dirLinkCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	padding: `0 ${spacing.md}`,
	height: '2.75rem',
	borderBottom: `1px solid ${colors.border}`,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	textDecoration: 'none',
	'&:hover': {
		backgroundColor: colors.primarySoftest,
		color: colors.primaryText,
	},
} satisfies CSSObject
