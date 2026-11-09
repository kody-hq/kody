/** @jsxImportSource @emotion/react */
import { Menu } from '@base-ui/react/menu'
import {
	overlayItemCss,
	overlayPopupCss,
	overlayPositionerCss,
} from './overlay-styles.ts'
import { useHotkeys } from '@tanstack/react-hotkeys'
import { useRouter } from '@tanstack/react-router'
import { WorkspaceBreadcrumbs } from '../pages/workspace-breadcrumbs.tsx'
import { WorkspaceFileBrowser } from '../pages/workspace-file-browser.tsx'
import { detectFileMediaType } from '#universal/file-viewers.ts'
import { FileGlyph } from './file-glyph.tsx'
import { workspaceDirectoryMediaType } from '#universal/workspace-page.ts'
import { SkillReadAcknowledgement } from './skill-read-acknowledgement.tsx'
import { type CSSObject } from '@emotion/react'
import {
	type ReactNode,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	Fragment,
} from 'react'
import { LoadingIndicator } from './loading-indicator.tsx'
import { SiteLink } from './site-link.tsx'
import { withInstallOrg } from '#universal/community-search.ts'

import { ControlTooltip } from './control-tooltip.tsx'
import { Combobox } from './combobox.tsx'
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
	joinPackageFilesPath,
	packageFileLanguageLabel,
} from '#universal/package-files.ts'
import { directoryOfPackageFilePath } from '#universal/package-readme-images.ts'
import { usePackageInstall } from '../use-package-install.ts'
import { renderInstallStrip } from './community-detail-sections.tsx'
import {
	PackageInstallContext,
	renderPackageRepoActions,
} from './package-title-actions.tsx'
import {
	PackageRepoTabPanel,
	renderPackageRepoChrome,
} from './package-repo-nav.tsx'
import { renderIcon } from './icon.tsx'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	packageDetailPageCss,
	proseCss,
} from '#universal/styles/style-primitives.ts'

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

declare module '@tanstack/history' {
	interface HistoryState {
		fileColumnNavigation?: boolean
	}
}

function countLines(value: string) {
	return value.replace(/\n$/, '').split('\n').length
}

export function PackageFilesExplorer(props: {
	data: PackageFilesLoaderData
	busy?: boolean
	hideExplorer?: boolean
	embedded?: boolean
	fillHeight?: boolean
	fileHref?: (path: string) => string
}) {
	const install = usePackageInstall(props.data.repoActions?.fork ?? null)
	return (
		<PackageInstallContext.Provider value={install.context}>
			{props.data.skillRead ? (
				<SkillReadAcknowledgement
					identity={`${props.data.contentPath}:${props.data.viewedCommit}`}
					{...props.data.skillRead}
				/>
			) : null}
			<PackageFilesExplorerContent
				{...props}
				installOrg={install.org}
				installStrip={props.embedded ? undefined : renderInstallStrip(install)}
			/>
		</PackageInstallContext.Provider>
	)
}

function PackageFilesExplorerContent({
	data,
	busy,
	installStrip,
	installOrg,
	embedded,
	hideExplorer,
	fillHeight,
	fileHref,
}: {
	data: PackageFilesLoaderData
	busy?: boolean
	hideExplorer?: boolean
	embedded?: boolean
	fillHeight?: boolean
	fileHref?: (path: string) => string
	installStrip?: ReactNode
	installOrg: string | null
}) {
	const router = useRouter()
	const [pointerHover, setPointerHover] = useState(true)
	const [query, setQuery] = useState('')
	const [openedFor, setOpenedFor] = useState(data.selectedPath)
	const explorer = useRef<HTMLDivElement>(null)
	const columns = useRef<HTMLDivElement>(null)
	const fileView = useRef<HTMLElement>(null)
	const viewToggle = useRef<HTMLButtonElement>(null)
	const [wrapLines, setWrapLines] = useState(false)
	const [fullPath, setFullPath] = useState<string | null>(null)
	if (openedFor !== data.selectedPath) {
		setOpenedFor(data.selectedPath)
		if (fullPath !== data.selectedPath) setFullPath(null)
		setQuery('')
	}
	const canOpen =
		!hideExplorer && data.kind === 'file' && Boolean(data.selectedPath)
	const fullView = canOpen && fullPath === data.selectedPath
	const wasFullView = useRef(false)

	useLayoutEffect(() => {
		if (wasFullView.current === fullView) return
		wasFullView.current = fullView
		if (fullView) {
			fileView.current?.focus({ preventScroll: true })
			return
		}
		const frame = requestAnimationFrame(() => {
			const selected = columns.current?.querySelector<HTMLElement>(
				`[data-browser-item="${CSS.escape(data.selectedPath)}"]`,
			)
			const target = selected ?? viewToggle.current
			target?.focus({ preventScroll: true })
		})
		return () => cancelAnimationFrame(frame)
	}, [data.selectedPath, fullView])

	useHotkeys(
		[
			{
				hotkey: 'Mod+O',
				callback: (event) => {
					const item = (event.target as Element).closest<HTMLElement>(
						'[data-browser-item]',
					)
					if (
						!canOpen ||
						fullView ||
						(item && item.dataset.browserItem !== data.selectedPath)
					)
						return
					event.preventDefault()
					setFullPath(data.selectedPath)
				},
			},
			{
				hotkey: 'Escape',
				callback: (event) => {
					if (
						!fullView ||
						explorer.current?.querySelector('[popover]:popover-open')
					)
						return
					event.preventDefault()
					setFullPath(null)
				},
			},
		],
		{ target: explorer, preventDefault: false },
	)

	const entries = useMemo(() => {
		const byPath = new Map<
			string,
			{ id: string; parentId?: string; name: string; mediaType: string }
		>()
		const directories = new Set(
			data.children
				.filter((child) => child.kind === 'directory')
				.map((child) => child.path),
		)
		const paths = new Set([
			...data.paths,
			...data.children.map((child) => child.path),
		])
		for (const path of paths) {
			let parent = directoryOfPackageFilePath(path)
			while (parent) {
				directories.add(parent)
				parent = directoryOfPackageFilePath(parent)
			}
		}
		for (const path of new Set([...paths, ...directories])) {
			const slash = path.lastIndexOf('/')
			byPath.set(path, {
				id: path,
				parentId: slash < 0 ? undefined : path.slice(0, slash),
				name: path.slice(slash + 1),
				mediaType: directories.has(path)
					? workspaceDirectoryMediaType
					: detectFileMediaType(path, ''),
			})
		}
		return [...byPath.values()].sort(
			(a, b) =>
				Number(b.mediaType === workspaceDirectoryMediaType) -
					Number(a.mediaType === workspaceDirectoryMediaType) ||
				a.name.localeCompare(b.name),
		)
	}, [data.children, data.paths])
	const hrefForFile =
		fileHref ??
		((path: string) =>
			withInstallOrg(
				joinPackageFilesPath(data.filesBasePath, path),
				installOrg,
			))

	const Panel = embedded ? Fragment : PackageRepoTabPanel
	const showRepoChrome = Boolean(data.username && data.kodyId)

	const preview = (
		<section
			css={fullView || hideExplorer ? contentCss : { minWidth: 0 }}
			aria-label="Selected file"
			ref={fileView}
			tabIndex={fullView ? -1 : undefined}
			data-file-column-browser={fullView ? true : undefined}
		>
			<FileContent
				key={data.contentPath ?? data.selectedPath}
				data={data}
				fileHref={hrefForFile}
				wrapLines={wrapLines}
				onWrapLinesChange={setWrapLines}
				fullBreadcrumbs={
					fullView ? (
						<WorkspaceBreadcrumbs
							files={entries}
							directory={entries.find(
								(entry) => entry.id === data.selectedPath,
							)}
							orgSlug={data.username ?? ''}
							rootHref={hrefForFile('')}
							itemHref={hrefForFile}
						/>
					) : undefined
				}
				viewAction={
					canOpen && !fullView ? (
						<button
							ref={viewToggle}
							type="button"
							css={openButtonCss}
							onClick={() => setFullPath(data.selectedPath)}
						>
							Open
						</button>
					) : undefined
				}
			/>
		</section>
	)

	return (
		<article
			css={
				embedded
					? {
							minWidth: 0,
							minHeight: 0,
							display: 'flex',
							flexDirection: 'column',
							flex: 1,
						}
					: articleCss
			}
			data-testid="package-files"
			// The previous file stays on screen while the next one loads, so
			// assistive tech is told the region is mid-update.
			aria-busy={busy ? 'true' : undefined}
		>
			{embedded ? null : showRepoChrome && data.username && data.kodyId ? (
				renderPackageRepoChrome({
					username: data.username,
					kodyId: data.kodyId,
					isPrivate: data.isPrivate ?? false,
					isListed: data.isListed === true,
					hasPackage: data.hasPackage,
					viewerIsOwner: data.viewerIsOwner ?? false,
					viewerCanManage: data.viewerCanManage ?? false,
					viewerCanManageAccess: data.viewerCanManageAccess,
					viewerCanSeeConnectedPeople: data.viewerCanSeeConnectedPeople,
					active: 'files',
					actions: renderPackageRepoActions(data.repoActions ?? null),
					filesHref: data.filesBasePath,
					installOrg,
					description: data.description,
					ownerProfilePublic: data.ownerProfilePublic,
					iconUrl: data.iconUrl ?? null,
					iconName: data.kodyId,
				})
			) : (
				<>
					<SiteLink
						href={withInstallOrg(data.backHref, installOrg)}
						css={backLinkCss}
					>
						{arrowLeftIcon()} {data.backLabel}
					</SiteLink>
					<header css={headCss}>
						<h1 css={titleCss}>{data.title}</h1>
					</header>
				</>
			)}
			<Panel>
				{installStrip}
				<div
					ref={explorer}
					css={[
						layoutCss,
						embedded && { marginTop: 0 },
						fillHeight && { flex: 1, minHeight: 0 },
					]}
				>
					{!hideExplorer && (
						<div
							ref={columns}
							role="region"
							aria-label="Files"
							inert={fullView}
							css={[
								treeCss,
								fullView && {
									position: 'absolute',
									insetInline: 0,
									visibility: 'hidden',
								},
							]}
						>
							<div css={treeHeadCss}>
								<h2 css={treeHeadingCss}>Files</h2>
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
							{query.trim() ? (
								<div css={treeScrollCss}>
									{renderMatches(data, query, hrefForFile)}
								</div>
							) : entries.length ? (
								<div
									css={{ display: 'flex', height: 'max(24rem, 58dvh)' }}
									onKeyDownCapture={(event) => {
										if (
											[
												'ArrowDown',
												'ArrowUp',
												'ArrowLeft',
												'ArrowRight',
												'Home',
												'End',
											].includes(event.key)
										)
											setPointerHover(false)
									}}
									onPointerMoveCapture={(event) => {
										if (event.pointerType === 'mouse') setPointerHover(true)
									}}
								>
									<WorkspaceFileBrowser
										files={entries}
										rootId={data.selectedPath || undefined}
										selectionKey={data.selectedPath}
										orgSlug={data.username ?? ''}
										itemHref={hrefForFile}
										rootLabel="Package root"
										onOpen={(file) => {
											if (file.mediaType !== workspaceDirectoryMediaType)
												setFullPath(file.id)
										}}
										fullPreview
										renderPreview={
											fullView
												? undefined
												: (file) =>
														file.id === data.selectedPath ? (
															preview
														) : (
															<LoadingIndicator label="Loading file" />
														)
										}
										pointerHover={pointerHover}
										onSelectionChange={(path) => {
											const href = hrefForFile(path ?? '')
											if (href !== '#')
												void router.navigate({
													href,
													resetScroll: false,
													state: { fileColumnNavigation: true },
												})
										}}
										renderIcon={(file) => (
											<FileGlyph mediaType={file.mediaType} name={file.name} />
										)}
									/>
								</div>
							) : (
								<p css={emptyCss}>No published files.</p>
							)}
						</div>
					)}
					{(fullView ||
						hideExplorer ||
						(query.trim() && data.kind === 'file')) &&
						preview}
				</div>
			</Panel>
		</article>
	)
}

const maxFilterMatches = 100

function renderMatches(
	data: PackageFilesLoaderData,
	query: string,
	fileHref: (path: string) => string,
): ReactNode {
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
							href={fileHref(path)}
							aria-current={data.selectedPath === path ? 'page' : undefined}
							css={data.selectedPath === path ? rowCurrentCss : rowCss}
						>
							<span css={rowIconCss}>
								<FileGlyph
									mediaType={detectFileMediaType(path, '')}
									name={name}
								/>
							</span>
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

function FileContent({
	data,
	fileHref,
	viewAction,
	fullBreadcrumbs,
	wrapLines,
	onWrapLinesChange,
}: {
	data: PackageFilesLoaderData
	fileHref: (path: string) => string
	viewAction?: ReactNode
	fullBreadcrumbs?: ReactNode
	wrapLines: boolean
	onWrapLinesChange: (value: boolean) => void
}): ReactNode {
	const [raw, setRaw] = useState(false)
	const displayId = useId()

	if (data.kind === 'directory' && !data.content) {
		return (
			<div>
				<div
					css={[
						contentToolbarCss,
						{ padding: '0.4rem 0.65rem', flexShrink: 0 },
					]}
				>
					<div css={contentHeadingWrapCss}>
						<span css={headingIconCss}>
							<FileGlyph mediaType={workspaceDirectoryMediaType} />
						</span>
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
								<SiteLink href={fileHref(child.path)} css={dirLinkCss}>
									<span css={rowIconCss}>
										<FileGlyph
											mediaType={
												child.kind === 'directory'
													? workspaceDirectoryMediaType
													: detectFileMediaType(child.path, '')
											}
											name={child.name}
										/>
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
	const canCopy =
		Boolean(body) &&
		data.contentKind !== 'binary' &&
		!isPackageFilesMediaKind(data.contentKind)
	const canWrap =
		raw ||
		data.contentKind === 'code' ||
		data.contentKind === 'text' ||
		data.contentKind === null
	return (
		<div
			css={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
		>
			<div
				css={[contentToolbarCss, { padding: '0.4rem 0.65rem', flexShrink: 0 }]}
			>
				{viewAction}
				<div
					css={[
						contentHeadingWrapCss,
						Boolean(fullBreadcrumbs) && {
							flex: '1 1 22rem',
							alignItems: 'baseline',
						},
					]}
				>
					{fullBreadcrumbs ? (
						fullBreadcrumbs
					) : (
						<>
							<span css={headingIconCss}>
								<FileGlyph
									mediaType={detectFileMediaType(heading, '')}
									name={heading}
								/>
							</span>
							<h2 css={contentHeadingCss} title={heading}>
								{packageFileBaseName(heading)}
							</h2>
						</>
					)}
					{byteLength > 0 || kindLabel ? (
						<span css={contentMetaCss}>
							{showTextMeta ? `${countLines(body)} lines · ` : ''}
							{byteLength > 0 ? formatBytes(byteLength) : ''}
							{kindLabel ? `${byteLength > 0 ? ' · ' : ''}${kindLabel}` : ''}
						</span>
					) : null}
				</div>
				<div css={{ display: 'flex', gap: spacing.xs }}>
					{data.contentKind === 'markdown' ? (
						<div
							css={{
								width: raw ? '4.75rem' : '6.75rem',
								flexShrink: 0,
								'& button[data-field-ring]': {
									borderColor: 'transparent',
									backgroundColor: 'transparent',
									boxShadow: 'none',
								},
							}}
						>
							<Combobox
								id={displayId}
								label="File display"
								selectOnly
								minListWidth={144}
								hideLabel
								value={raw ? 'raw' : 'formatted'}
								options={[
									{ id: 'formatted', label: 'Formatted' },
									{ id: 'raw', label: 'Raw' },
								]}
								onChange={(value) => setRaw(value === 'raw')}
							/>
						</div>
					) : null}
					{(data.rawHref || canCopy) && (
						<div
							css={[contentActionsCss, { border: 0 }]}
							role="group"
							aria-label="File actions"
						>
							{data.rawHref ? (
								<ControlTooltip
									trigger={
										<a
											href={data.rawHref}
											download={
												data.rawHref.startsWith('data:')
													? packageFileBaseName(heading)
													: undefined
											}
											data-testid="package-files-raw-link"
											aria-label={`View raw ${heading}`}
											css={rawLinkCss}
										>
											{renderIcon('arrow-up-right', { size: '14' })}
										</a>
									}
								>
									Open raw file
								</ControlTooltip>
							) : null}
							{canCopy ? (
								<CopyTextButton
									iconOnly
									title=""
									value={body}
									idleLabel="Copy"
									variant="ghost"
									size="sm"
									ariaLabel={`Copy ${heading}`}
									wrapButton={(button) => (
										<ControlTooltip trigger={button}>
											Copy source
										</ControlTooltip>
									)}
								/>
							) : null}
						</div>
					)}
					{canWrap && (
						<Menu.Root modal={false}>
							<Menu.Trigger
								type="button"
								aria-label="Preview options"
								title="Preview options"
								css={[
									openButtonCss,
									{
										width: '2rem',
										padding: 0,
										border: 0,
									},
								]}
							>
								<svg
									aria-hidden="true"
									width="16"
									height="16"
									viewBox="0 0 16 16"
									fill="currentColor"
								>
									<circle cx="3" cy="8" r="1.2" />
									<circle cx="8" cy="8" r="1.2" />
									<circle cx="13" cy="8" r="1.2" />
								</svg>
							</Menu.Trigger>
							<Menu.Portal>
								<Menu.Positioner
									align="end"
									sideOffset={4}
									css={overlayPositionerCss}
								>
									<Menu.Popup
										aria-label="Preview options"
										css={{ ...overlayPopupCss, minWidth: 170 }}
									>
										<Menu.CheckboxItem
											checked={wrapLines}
											onCheckedChange={onWrapLinesChange}
											css={overlayItemCss}
										>
											<span css={{ width: '1rem' }}>
												<Menu.CheckboxItemIndicator>
													✓
												</Menu.CheckboxItemIndicator>
											</span>
											Wrap lines
										</Menu.CheckboxItem>
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.Root>
					)}
				</div>
			</div>
			<div css={{ overflow: 'auto', minWidth: 0, minHeight: 0, flex: 1 }}>
				{renderFilePreview(
					raw ? { ...data, contentKind: 'code' } : data,
					heading,
					data.contentKind === 'markdown' && !raw
						? body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
						: body,
					wrapLines,
				)}
			</div>
		</div>
	)
}

function renderFilePreview(
	data: PackageFilesLoaderData,
	heading: string,
	body: string,
	wrapLines: boolean,
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
				<div
					css={[codeCss, wrapLines && wrappedCodeCss]}
					data-testid="package-files-code"
				>
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

const layoutCss = {
	position: 'relative',
	display: 'flex',
	flexDirection: 'column',
	gap: spacing.md,
} satisfies CSSObject

const treeCss = {
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	minWidth: 0,
	overflow: 'hidden',
} satisfies CSSObject

const treeHeadCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
	padding: spacing.sm,
	paddingInlineStart: spacing.md,
} satisfies CSSObject

const treeHeadingCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
} satisfies CSSObject

// The icon is positioned against the input, not the padded wrapper around it —
// anchoring it to the wrapper puts it outside the field by the padding.
const filterFieldCss = {
	width: 'min(100%, 22rem)',
	minWidth: 0,
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
	height: '2.25rem',
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
	display: 'inline-flex',
	alignItems: 'center',
	flexShrink: 0,
	height: '2rem',
	boxSizing: 'border-box',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.sm,
	'& button, & a': {
		minHeight: 0,
		height: '1.875rem',
		boxSizing: 'border-box',
		border: 0,
		borderRadius: radius.sm,
		boxShadow: 'none',
		'&:not(:disabled):hover, &:not(:disabled):active': {
			boxShadow: 'none',
			transform: 'none',
		},
		'&:focus-visible': {
			outline: `2px solid ${colors.primary}`,
			outlineOffset: '-2px',
		},
	},
	'& > span > button, & > span > a': {
		width: '1.875rem',
		padding: 0,
	},
} satisfies CSSObject

const rawLinkCss = {
	...getGhostButtonCss({ size: 'sm' }),
	textDecoration: 'none',
}

const openButtonCss = {
	...rawLinkCss,
	height: '2rem',
	minHeight: 0,
	boxSizing: 'border-box',
	padding: `0 ${spacing.sm}`,
	borderRadius: radius.sm,
	border: 0,
	boxShadow: 'none',
	'&:not(:disabled):hover, &:not(:disabled):active': {
		boxShadow: 'none',
		transform: 'none',
	},
} satisfies CSSObject

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
	lineHeight: 1.25,
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
	width: '100%',
	minWidth: 0,
	overflow: 'hidden',
	'& pre': {
		maxWidth: '100%',
		boxSizing: 'border-box',
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
		boxSizing: 'border-box',
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

const wrappedCodeCss = {
	'& code': {
		width: '100%',
		whiteSpace: 'pre-wrap',
		overflowWrap: 'anywhere',
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
