/** @jsxImportSource @emotion/react */
import { WorkspaceEmptyFolder } from './workspace-empty-folder.tsx'
import type { ReactNode } from 'react'
import { colors } from '#universal/styles/tokens.ts'
import { workspaceDirectoryMediaType } from '#universal/workspace-page.ts'
import { kodyLogoOutlinedSvgMarkup } from '../brand/kody-logo.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	PublicShareActions,
	ShareIcon,
	shareActionCss,
} from './public-share-actions.tsx'

type SharedItem = {
	id: string
	name: string
	mediaType: string
	parentId?: string
}
export function PublicFileShell({
	scope,
	file,
	files,
	children,
	openUse = false,
}: {
	scope: { orgSlug: string; rootId: string; token: string }
	file: SharedItem
	files: SharedItem[]
	children: ReactNode
	openUse?: boolean
}) {
	const href = (id: string) =>
		`/shared-files/${scope.orgSlug}/${scope.rootId}/${scope.token}?item=${id}`
	const asset = `/shared-file-assets/${scope.orgSlug}/${scope.rootId}/${scope.token}/${file.id}`
	const byId = new Map(files.map((item) => [item.id, item])),
		chain: SharedItem[] = [],
		seen = new Set<string>()
	let current: SharedItem | undefined = file
	while (current && !seen.has(current.id)) {
		chain.unshift(current)
		seen.add(current.id)
		current = current.parentId ? byId.get(current.parentId) : undefined
	}
	const items = files
		.filter((item) => item.parentId === file.id)
		.sort(
			(a, b) =>
				Number(b.mediaType === workspaceDirectoryMediaType) -
					Number(a.mediaType === workspaceDirectoryMediaType) ||
				a.name.localeCompare(b.name, undefined, {
					numeric: true,
					sensitivity: 'base',
				}),
		)
	const directory = file.mediaType === workspaceDirectoryMediaType
	return (
		<div
			css={{
				height: '100dvh',
				display: 'flex',
				flexDirection: 'column',
				background: colors.background,
				color: colors.text,
			}}
		>
			<header
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: 16,
					padding: '10px 20px',
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
					minWidth: 0,
					'@media(max-width:600px)': {
						padding: '8px 12px',
						gap: 8,
						flexWrap: 'wrap',
					},
				}}
			>
				<SiteLink
					href="/"
					aria-label="Kody"
					css={{ display: 'flex', color: colors.text, flexShrink: 0 }}
				>
					<span
						aria-hidden="true"
						css={{ display: 'block', width: 83, height: 24 }}
						dangerouslySetInnerHTML={{
							__html: kodyLogoOutlinedSvgMarkup('currentColor'),
						}}
					/>
				</SiteLink>
				<nav
					aria-label="Shared file path"
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: 7,
						minWidth: 0,
						flex: 1,
						overflowX: 'auto',
						fontSize: 13,
						'& a': {
							color: colors.text,
							textUnderlineOffset: 3,
							textDecorationColor: colors.border,
						},
						'& a:hover': { textDecorationColor: 'currentColor' },
						'@media(max-width:600px)': { order: 3, flexBasis: '100%' },
					}}
				>
					{chain.map((item, index) => (
						<span
							key={item.id}
							css={{
								display: 'inline-flex',
								gap: 7,
								alignItems: 'center',
								minWidth: 0,
								maxWidth:
									index === chain.length - 1 ? '100%' : 'min(180px, 45vw)',
								flexShrink: index === chain.length - 1 ? 1 : 0,
							}}
						>
							{index > 0 && (
								<span css={{ color: colors.textMuted, display: 'flex' }}>
									<ShareIcon kind="chevron" />
								</span>
							)}
							{index === chain.length - 1 ? (
								<span
									aria-current="page"
									css={{
										whiteSpace: 'nowrap',
										overflow: 'hidden',
										textOverflow: 'ellipsis',
									}}
								>
									{item.name}
								</span>
							) : (
								<SiteLink
									href={href(item.id)}
									title={item.name}
									css={{
										minWidth: 0,
										whiteSpace: 'nowrap',
										overflow: 'hidden',
										textOverflow: 'ellipsis',
									}}
								>
									{item.name}
								</SiteLink>
							)}
						</span>
					))}
				</nav>
				<div
					css={{
						display: 'flex',
						gap: 5,
						alignItems: 'center',
						marginLeft: 'auto',
					}}
				>
					<PublicShareActions
						key={file.id}
						scope={{ ...scope, itemId: file.id }}
						name={file.name}
						downloadUrl={directory ? undefined : asset}
						openOnLoad={openUse}
					/>
				</div>
			</header>
			<section
				aria-label={file.name}
				css={{
					flex: 1,
					minHeight: 0,
					overflow: 'auto',
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				{directory ? (
					<div
						css={{
							width: '100%',
							maxWidth: 1040,
							boxSizing: 'border-box',
							marginInline: 'auto',
							padding: 'clamp(18px, 4vw, 32px) clamp(14px, 4vw, 24px)',
						}}
					>
						<div
							css={{
								display: 'flex',
								gap: 12,
								alignItems: 'center',
								marginBottom: 24,
							}}
						>
							<ShareIcon kind="folder" />
							<h1
								css={{
									margin: 0,
									minWidth: 0,
									overflowWrap: 'anywhere',
									fontSize: 26,
								}}
							>
								{file.name}
							</h1>
						</div>
						<div css={{ display: 'grid', gap: 0 }}>
							{items.length === 0 ? (
								<WorkspaceEmptyFolder />
							) : (
								items.map((item) => (
									<SiteLink
										key={item.id}
										href={href(item.id)}
										css={{
											display: 'flex',
											gap: 12,
											alignItems: 'center',
											padding: '13px 8px',
											borderBottom: `1px solid ${colors.borderSubtle}`,
											fontSize: 14,
											color: colors.text,
											textDecoration: 'none',
											'&:hover': { background: colors.borderSubtle },
											'&:focus-visible': {
												outline: `2px solid ${colors.primary}`,
											},
										}}
									>
										<span css={{ display: 'flex', color: colors.textMuted }}>
											<ShareIcon
												kind={
													item.mediaType === workspaceDirectoryMediaType
														? 'folder'
														: 'file'
												}
											/>
										</span>
										<span
											css={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
										>
											{item.name}
										</span>
										<ShareIcon kind="chevron" />
									</SiteLink>
								))
							)}
						</div>
						<p css={{ color: colors.textMuted, fontSize: 12, marginTop: 20 }}>
							Shared by @{scope.orgSlug}
						</p>
					</div>
				) : (
					<>
						{children}
						{items.length > 0 && (
							<nav
								aria-label="Shared contents"
								css={{
									maxWidth: 880,
									width: '100%',
									boxSizing: 'border-box',
									padding: '12px 28px 32px',
									marginInline: 'auto',
									display: 'grid',
									gap: 4,
								}}
							>
								{items.map((item) => (
									<SiteLink
										key={item.id}
										href={href(item.id)}
										css={{
											...shareActionCss,
											justifyContent: 'flex-start',
											minWidth: 0,
											whiteSpace: 'normal',
											overflowWrap: 'anywhere',
											fontSize: 14,
										}}
									>
										<ShareIcon
											kind={
												item.mediaType === workspaceDirectoryMediaType
													? 'folder'
													: 'file'
											}
										/>
										{item.name}
									</SiteLink>
								))}
							</nav>
						)}
					</>
				)}
			</section>
		</div>
	)
}
export function SharedFileUnavailable() {
	return (
		<div
			css={{
				minHeight: '100dvh',
				display: 'grid',
				placeItems: 'center',
				background: colors.background,
				color: colors.text,
				padding: 24,
				boxSizing: 'border-box',
			}}
		>
			<div css={{ maxWidth: 360, textAlign: 'center' }}>
				<span
					aria-label="Kody"
					css={{ display: 'inline-block', width: 96, height: 28 }}
					dangerouslySetInnerHTML={{
						__html: kodyLogoOutlinedSvgMarkup('currentColor'),
					}}
				/>
				<h1 css={{ fontSize: 22, marginTop: 28 }}>This link is unavailable</h1>
				<p css={{ fontSize: 14, lineHeight: 1.6, color: colors.textMuted }}>
					Ask the sender for a new link or a direct invitation.
				</p>
				<SiteLink href="/login" css={shareActionCss}>
					Sign in to Kody <ShareIcon kind="arrow" />
				</SiteLink>
			</div>
		</div>
	)
}
