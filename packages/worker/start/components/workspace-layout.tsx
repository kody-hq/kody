/** @jsxImportSource @emotion/react */
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
import { KodyMark } from './kody-mark.tsx'
import { AccountMenu } from './org-switcher.tsx'
import { SiteLink } from './site-link.tsx'
import { renderIcon } from './icon.tsx'
import { colors, typography } from '#universal/styles/tokens.ts'

export function WorkspaceLayout() {
	const { session } = useShellData()
	const matches = useMatches()
	const navigation = workspaceLayoutNavigation(matches, session)
	if (!navigation || !session) return <Outlet />
	return (
		<WorkspaceLayoutContext value={true}>
			<div
				data-workspace-layout
				css={{
					display: 'grid',
					gridTemplateColumns: '248px minmax(0, 1fr)',
					minHeight: '100dvh',
					width: '100%',
					[accountManagementNarrowMq]: {
						gridTemplateColumns: 'minmax(0, 1fr)',
						gridTemplateRows: 'auto 1fr',
					},
				}}
			>
				<aside
					aria-label="Workspace navigation"
					css={{
						position: 'sticky',
						top: 0,
						height: '100dvh',
						boxSizing: 'border-box',
						display: 'flex',
						flexDirection: 'column',
						background: `color-mix(in srgb, ${colors.background} 60%, ${colors.surface})`,
						boxShadow: `4px 0 18px color-mix(in srgb, ${colors.text} 3%, transparent)`,
						'@media (prefers-color-scheme: dark)': {
							boxShadow: 'none',
							borderRight: `1px solid ${colors.borderSubtle}`,
						},
						zIndex: 1,
						'& [data-account-navigation]': {
							minHeight: 0,
							paddingTop: 0,
						},
						'& [data-account-nav]': { width: '100%', height: 'auto' },
						'& [data-account-nav] > div': { position: 'static', paddingTop: 0 },
						[accountManagementNarrowMq]: {
							position: 'relative',
							height: 'auto',
							boxShadow: `0 4px 18px color-mix(in srgb, ${colors.text} 3%, transparent)`,
							'@media (prefers-color-scheme: dark)': {
								boxShadow: 'none',
								borderRight: 0,
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
									gap: '0.6rem',
									color: colors.text,
									textDecoration: 'none',
									font: `700 1.5rem/1 ${typography.fontFamilyDisplay}`,
									letterSpacing: '-0.01em',
								}}
							>
								<KodyMark size={28} />
								Kody
							</SiteLink>
						</BrandContextMenu>
						<AccountMenu
							placement="sidebar"
							organizations={session.organizations ?? []}
							username={session.username}
							displayName={session.username || session.email}
							avatarUrl={session.avatarUrl}
						/>
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
						{session.featureFlags['demo-indicator'] ? <DemoIndicator /> : null}
						<ShellNavigation
							navigation={navigation}
							separateWorkspaceSwitcher
						/>
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
								<span aria-hidden="true">
									{renderIcon('book', { size: '1rem' })}
								</span>
								Documentation
							</SiteLink>
						</nav>
					</div>
					{session.roles.includes('admin') ? (
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
									display: 'block',
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
								Admin
							</SiteLink>
						</div>
					) : null}
				</aside>
				<main
					id="main"
					tabIndex={-1}
					data-workspace-panel
					css={{
						minWidth: 0,
						background: colors.background,
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
						padding: 'clamp(1rem, 3vw, 2.5rem)',
					}}
				>
					<Outlet />
				</main>
			</div>
		</WorkspaceLayoutContext>
	)
}
