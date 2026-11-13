/** @jsxImportSource @emotion/react */
import { WorkspaceUploads } from './workspace-uploads.tsx'
import { useWorkspaceRail } from './use-workspace-rail.ts'
import { CommandTrigger } from '../commands/provider.tsx'
import { Outlet, useMatches } from '@tanstack/react-router'
import { useShellData } from '../routes/__root.tsx'
import { workspaceLayoutNavigation } from '../workspace-layout-policy.ts'
import { WorkspaceLayoutContext } from '../workspace-layout-context.ts'
import {
	ShellNavigation,
	ShellWorkspaceSwitcher,
} from '../pages/account-management-components.tsx'
import { accountManagementNarrowMq } from '../pages/account-management-link-nav.tsx'
import { BrandContextMenu } from './brand-context-menu.tsx'
import { DemoIndicator } from './demo-indicator.tsx'
import { GuestBanner } from '../pages/guest-banner.tsx'
import { KodyMark } from './kody-mark.tsx'
import { AccountMenu } from './org-switcher.tsx'
import { SiteLink } from './site-link.tsx'
import { renderIcon } from './icon.tsx'
import { workspaceTextureCss } from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

export function WorkspaceLayout() {
	const rail = useWorkspaceRail()
	const { session } = useShellData()
	const matches = useMatches()
	const navigation = workspaceLayoutNavigation(matches, session)
	const fullPanel = matches.some(
		(match) => match.staticData.navigation?.item === 'files',
	)
	if (!navigation || !session) return <Outlet />
	const resources = (
		<nav
			aria-label="Resources"
			css={{
				display: 'grid',
				gap: '0.25rem',
				borderTop: `1px solid ${colors.border}`,
				paddingTop: '0.75rem',
				fontSize: '0.875rem',
				'& a': {
					display: 'flex',
					alignItems: 'center',
					gap: '0.5rem',
					padding: '0.4rem 0.65rem',
					borderRadius: '0.5rem',
					color: colors.textMuted,
					textDecoration: 'none',
					'&:hover': {
						background: colors.primarySoftest,
						color: colors.text,
					},
				},
			}}
		>
			<h2
				data-rail-label
				css={{
					margin: '0 0 0.25rem',
					paddingInline: '0.65rem',
					fontSize: '0.7rem',
					fontWeight: 600,
					letterSpacing: '0.06em',
					textTransform: 'uppercase',
					color: colors.textMuted,
				}}
			>
				Resources
			</h2>
			<SiteLink href="/docs">
				<span aria-hidden="true">{renderIcon('book', { size: '1rem' })}</span>
				<span data-rail-label>Documentation</span>
			</SiteLink>
		</nav>
	)
	const adminLink = session.roles.includes('admin') ? (
		<div
			css={{
				flexShrink: 0,
				padding: '0.75rem 1rem',
				borderTop: `1px solid ${colors.border}`,
			}}
		>
			<SiteLink
				href="/admin/users"
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '0.4rem 0.65rem',
					borderRadius: '0.5rem',
					color: colors.textMuted,
					textDecoration: 'none',
					fontSize: '0.875rem',
					'&:hover': {
						background: colors.primarySoftest,
						color: colors.text,
					},
				}}
			>
				<span aria-hidden="true">{renderIcon('shield', { size: '1rem' })}</span>
				<span data-rail-label>Admin</span>
			</SiteLink>
		</div>
	) : null
	return (
		<WorkspaceUploads>
			<WorkspaceLayoutContext value={true}>
				<div
					data-workspace-layout
					data-workspace-files={fullPanel || undefined}
					css={{
						display: 'grid',
						gridTemplateColumns: `${rail.compact ? 52 : 248}px minmax(0, 1fr)`,
						transition: 'grid-template-columns 240ms cubic-bezier(.22,1,.36,1)',
						'@media(prefers-reduced-motion:reduce)': { transition: 'none' },
						minHeight: 'calc(100dvh - var(--desktop-toolbar-height, 0px))',
						width: '100%',
						[accountManagementNarrowMq]: {
							gridTemplateColumns: 'minmax(0, 1fr)',
							gridTemplateRows: 'auto 1fr',
						},
					}}
				>
					<aside
						aria-label="Workspace navigation"
						ref={rail.element}
						tabIndex={-1}
						{...rail.behavior}
						data-rail-compact={rail.compact || undefined}
						data-rail-expanded={rail.expanded || undefined}
						css={{
							position: 'sticky',
							width: rail.expanded ? 248 : 52,
							overflow: 'clip',
							transition:
								'width 240ms cubic-bezier(.22,1,.36,1), box-shadow 240ms ease',
							// Keep the icon column centered in the narrow rail, including its flyout.
							'@media (min-width: 601px)': {
								'&[data-rail-compact] > div': {
									transform: 'translateX(-8px)',
									width: 264,
								},
								'&[data-rail-compact] [data-rail-mode-bar]': {
									paddingInline: 16,
								},
								'&[data-rail-compact]:not([data-rail-expanded]) [data-rail-switcher]':
									{ paddingBottom: 4 },
								'&[data-rail-compact]:not([data-rail-expanded]) [data-account-nav-heading]':
									{ paddingBottom: 0 },
								'&[data-rail-compact]:not([data-rail-expanded]) [data-workspace-scroll]':
									{ gap: 0 },
								'&[data-rail-compact]:not([data-rail-expanded]) [aria-label="Resources"]':
									{ paddingTop: 0, borderTop: 0 },
								'&[data-rail-compact]:not([data-rail-expanded]) [aria-label="Resources"] a':
									{
										width: 36,
										boxSizing: 'border-box',
										paddingInline: 10,
										'& > span:first-of-type': {
											display: 'flex',
											flex: '0 0 16px',
											justifyContent: 'center',
										},
									},
								'&[data-rail-compact]:not([data-rail-expanded]) [aria-label="Resources"] h2':
									{ maxHeight: 0, margin: 0, overflow: 'hidden' },
								'&[data-rail-compact]:not([data-rail-expanded]) [data-rail-header]':
									{ paddingBlock: 4 },
								'&[data-rail-compact]:not([data-rail-expanded]) [data-account-nav-heading] button':
									{
										width: 36,
										minHeight: 36,
										padding: 2,
										borderColor: 'transparent',
										background: 'transparent',
										borderRadius: 10,
										'& > :first-child': { width: 30, height: 30, fontSize: 12 },
									},
								'&[data-rail-compact]:not([data-rail-expanded]) [data-rail-section]':
									{ maxHeight: 0, paddingTop: 0, paddingBottom: 0, opacity: 0 },
								'&[data-rail-compact]:not([data-rail-expanded]) [data-account-nav] a':
									{
										width: 36,
										boxSizing: 'border-box',
										padding: '6px 10px',
									},
								'&[data-rail-compact]:not([data-rail-expanded]) [data-rail-mark] > svg':
									{
										width: 26,
										height: 19.1,
										marginLeft: 0,
									},
							},
							'& > div': {
								transition: 'transform 240ms cubic-bezier(.22,1,.36,1)',
							},
							'& [data-rail-section]': {
								maxHeight: 48,
								overflow: 'hidden',
								transition:
									'max-height 240ms cubic-bezier(.22,1,.36,1), padding 240ms cubic-bezier(.22,1,.36,1), opacity 140ms ease',
							},
							'& [data-rail-mark] > svg': {
								width: 33,
								height: 24,
								marginLeft: 0,
								transition:
									'width 240ms cubic-bezier(.22,1,.36,1), height 240ms cubic-bezier(.22,1,.36,1), margin 240ms cubic-bezier(.22,1,.36,1)',
							},
							'& [data-account-nav-heading] button': {
								paddingLeft: 5,
								'& > :first-child': {
									transition:
										'width 240ms cubic-bezier(.22,1,.36,1), height 240ms cubic-bezier(.22,1,.36,1), font-size 240ms ease',
								},
								transition:
									'width 240ms cubic-bezier(.22,1,.36,1), min-height 240ms cubic-bezier(.22,1,.36,1), padding 240ms cubic-bezier(.22,1,.36,1), border-radius 240ms ease',
							},
							'& [data-account-nav] a': {
								paddingInline: 10,
								'& [data-icon]': { width: 16, height: 16 },
								whiteSpace: 'nowrap',
								minHeight: 34,
								boxSizing: 'border-box',
								transition:
									'padding 240ms cubic-bezier(.22,1,.36,1), width 240ms cubic-bezier(.22,1,.36,1), background-color 140ms ease, color 140ms ease',
								'&:hover': {
									transition:
										'padding 240ms cubic-bezier(.22,1,.36,1), width 240ms cubic-bezier(.22,1,.36,1)',
								},
							},
							'& [data-rail-label]': {
								transition:
									'opacity 140ms ease, transform 220ms cubic-bezier(.22,1,.36,1)',
							},
							'&[data-rail-compact]:not([data-rail-expanded]) [data-rail-mode-bar]':
								{ opacity: 0, visibility: 'hidden', pointerEvents: 'none' },
							'&[data-rail-compact]:not([data-rail-expanded]) [data-rail-label]':
								{
									opacity: 0,
									transform: 'translateX(-4px)',
									pointerEvents: 'none',
								},
							'@media(prefers-reduced-motion:reduce)': {
								transition: 'none',
								'& [data-rail-header], & [data-rail-switcher], & [data-account-nav-heading] button > :first-child, & [data-rail-label], & [data-rail-section], & [data-account-nav] a, & [data-account-nav] a:hover, & [data-account-nav-heading] button, & > div, & [data-rail-mark] > svg':
									{ transition: 'none' },
							},
							top: 'var(--desktop-toolbar-height, 0px)',
							height: 'calc(100dvh - var(--desktop-toolbar-height, 0px))',
							boxSizing: 'border-box',
							display: 'flex',
							flexDirection: 'column',
							fontSize: '0.9375rem',
							lineHeight: 1.5,
							background: `color-mix(in srgb, ${colors.background} 40%, ${colors.surface})`,
							'@media (prefers-color-scheme: dark)': {
								background: `color-mix(in srgb, ${colors.background} 60%, ${colors.surface})`,
							},
							borderRight: `1px solid ${colors.borderSubtle}`,
							zIndex: rail.compact && rail.expanded ? 40 : 10,
							'& [data-account-navigation]': {
								minHeight: 0,
								paddingTop: 0,
							},
							'& [data-account-nav]': { width: '100%', height: 'auto' },
							'& [data-account-nav] > div': {
								position: 'static',
								paddingTop: 0,
							},
							[accountManagementNarrowMq]: {
								'&[data-rail-compact]:not([data-rail-expanded]) [data-rail-label]':
									{ opacity: 1, transform: 'none', pointerEvents: 'auto' },
								width: '100%',
								overflow: 'visible',
								'& [data-rail-label]': {
									opacity: 1,
									transform: 'none',
									pointerEvents: 'auto',
								},
								position: 'relative',
								top: 0,
								height: 'auto',
								borderRight: 0,
								boxShadow: `0 4px 18px color-mix(in srgb, ${colors.text} 3%, transparent)`,
								'@media (prefers-color-scheme: dark)': {
									boxShadow: 'none',
									borderBottom: `1px solid ${colors.borderSubtle}`,
								},
								'& [data-account-navigation]': {
									overflow: 'visible',
									paddingTop: 0,
								},
							},
						}}
					>
						<div
							css={{
								width: 248,
								height: '100%',
								minHeight: 0,
								display: 'flex',
								flexDirection: 'column',
								flexShrink: 0,
								boxSizing: 'border-box',
								[accountManagementNarrowMq]: { width: '100%' },
							}}
						>
							<div
								data-rail-header
								css={{
									transition: 'padding 240ms cubic-bezier(.22,1,.36,1)',
									padding: '1rem',
									flexShrink: 0,
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
								}}
							>
								<BrandContextMenu>
									<SiteLink
										href="/"
										aria-label="Kody home"
										css={{
											display: 'inline-flex',
											alignItems: 'center',
											gap: '0.2rem',
											color: colors.text,
											textDecoration: 'none',
											font: `700 1.5rem/1 ${typography.fontFamilyDisplay}`,
											letterSpacing: '-0.01em',
										}}
									>
										<span
											data-rail-mark
											css={{
												display: 'flex',
												alignItems: 'center',
												justifyContent: 'center',
												width: 36,
												height: 28,
												flexShrink: 0,
											}}
										>
											<KodyMark size={24} />
										</span>
										<span data-rail-label>Kody</span>
									</SiteLink>
								</BrandContextMenu>
								<div
									data-rail-label
									css={{ display: 'flex', alignItems: 'center', gap: 4 }}
								>
									<CommandTrigger />
									<AccountMenu
										placement="sidebar"
										organizations={session.organizations ?? []}
										username={session.username}
										displayName={session.username || session.email}
										avatarUrl={session.avatarUrl}
									/>
								</div>
							</div>
							<ShellWorkspaceSwitcher navigation={navigation} />
							<div
								className="fade-y fade-size-xs"
								data-workspace-scroll
								css={{
									flex: 1,
									minHeight: 0,
									overflowY: 'auto',
									padding: '0 1rem 1rem',
									display: 'flex',
									flexDirection: 'column',
									gap: '1rem',
									'& > *': { flexShrink: 0 },
									[accountManagementNarrowMq]: {
										overflow: 'visible',
										maskImage: 'none',
										flex: 'none',
									},
								}}
							>
								{session.featureFlags['demo-indicator'] ? (
									<DemoIndicator />
								) : null}
								<ShellNavigation
									navigation={navigation}
									mobileFooter={
										<>
											{resources}
											{adminLink}
										</>
									}
									separateWorkspaceSwitcher
								/>
								<div css={{ [accountManagementNarrowMq]: { display: 'none' } }}>
									{resources}
								</div>
							</div>
							<div css={{ [accountManagementNarrowMq]: { display: 'none' } }}>
								{adminLink}
							</div>
							<div
								data-rail-mode-bar
								css={{
									padding: '8px',
									transition: 'opacity 140ms ease, visibility 140ms',
									flexShrink: 0,
									borderTop: `1px solid ${colors.borderSubtle}`,
									[accountManagementNarrowMq]: { display: 'none' },
								}}
							>
								<div
									role="group"
									aria-label="Sidebar mode"
									css={{
										opacity: 0.7,
										transition: 'opacity 180ms ease',
										'&:hover, &:focus-within': {
											opacity: 1,
											transitionDuration: '0ms',
										},
										'@media (hover: none)': { opacity: 1 },
										'@media (prefers-reduced-motion: reduce)': {
											transition: 'none',
										},
										display: 'grid',
										gridTemplateColumns:
											'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr)',
										gap: 2,
										width: '100%',
										boxSizing: 'border-box',
									}}
								>
									<button
										ref={rail.toggle}
										onClick={() => rail.setMode('compact')}
										aria-label="Hide sidebar"
										title="Keep sidebar compact"
										aria-pressed={rail.mode === 'compact'}
										css={sidebarModeButton}
									>
										<svg
											aria-hidden="true"
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.5"
										>
											<rect x="3" y="3" width="18" height="14" rx="3" />
											<path d="M9 3v18m8-13-4 4 4 4" />
										</svg>
										<span data-rail-label>Hide</span>
									</button>
									<button
										css={sidebarModeButton}
										onClick={() => rail.setMode('auto')}
										aria-label="Automatic sidebar"
										aria-pressed={rail.mode === 'auto'}
										title="Adjust sidebar to screen width"
									>
										<svg
											aria-hidden="true"
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.8"
										>
											<rect x="3" y="3" width="18" height="18" rx="3" />
											<path
												d="M8 3v18m3-5 3-8 3 8m-5-3h4"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
										Auto
									</button>
									<button
										onClick={() => rail.setMode('show')}
										aria-label="Keep sidebar open"
										aria-pressed={rail.mode === 'show'}
										title="Keep sidebar open until mobile"
										data-rail-label
										css={sidebarModeButton}
									>
										<svg
											aria-hidden="true"
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.8"
										>
											<rect x="5" y="10" width="14" height="11" rx="2" />
											<path d="M8 10V7a4 4 0 0 1 8 0v3" />
										</svg>
										Keep open
									</button>
								</div>
							</div>
						</div>
					</aside>
					<main
						id="main"
						tabIndex={-1}
						data-workspace-panel
						css={{
							isolation: 'isolate',
							zIndex: 0,
							minWidth: 0,
							position: 'relative',
							background: colors.background,
							'&::before': workspaceTextureCss,
							'@media (min-width: 601px) and (prefers-color-scheme: light)': {
								'&::after': {
									content: '""',
									position: 'absolute',
									insetBlock: 0,
									insetInlineStart:
										rail.compact && rail.expanded ? 248 - 52 : 0,
									transition:
										'inset-inline-start 240ms cubic-bezier(.22,1,.36,1)',
									'@media (prefers-reduced-motion: reduce)': {
										transition: 'none',
									},
									width: 24,
									zIndex: 2,
									pointerEvents: 'none',
									background: `linear-gradient(90deg, color-mix(in srgb, ${colors.text} 3%, transparent), transparent)`,
								},
							},
							fontSize: '0.875rem',
							lineHeight: 1.5,
							'--control-font-size': '0.875rem',
							'--control-line-height': '1.5',
							'--control-padding-y': '0.375rem',
							'--control-padding-x': '0.625rem',
							'--control-radius': '0.375rem',
							'@media (pointer: coarse)': {
								'--control-font-size': '1rem',
								'--control-min-height': '44px',
							},
							padding: fullPanel ? 0 : 'clamp(1rem, 3vw, 2.5rem)',
							display: fullPanel ? 'flex' : undefined,
						}}
					>
						{session.guest ? <GuestBanner guest={session.guest} /> : null}
						<Outlet />
					</main>
				</div>
			</WorkspaceLayoutContext>
		</WorkspaceUploads>
	)
}

const sidebarModeButton = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: 4,
	minWidth: 0,
	height: 28,
	padding: '0 6px',
	border: 0,
	borderRadius: 5,
	background: 'transparent',
	color: colors.text,
	cursor: 'pointer',
	whiteSpace: 'nowrap',
	fontSize: 12,
	'&:hover': { background: colors.primarySoftest, color: colors.text },
	'&[aria-pressed=true]': {
		color: colors.text,
		background: colors.primarySoft,
	},
} as const
