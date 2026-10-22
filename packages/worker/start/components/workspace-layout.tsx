/** @jsxImportSource @emotion/react */
import { Outlet, useMatches } from '@tanstack/react-router'
import { useShellData } from '../routes/__root.tsx'
import { workspaceLayoutNavigation } from '../workspace-layout-policy.ts'
import { WorkspaceLayoutContext } from '../workspace-layout-context.ts'
import { ShellNavigation } from '../pages/account-management-components.tsx'
import { accountManagementNarrowMq } from '../pages/account-management-link-nav.tsx'
import { DemoIndicator } from './demo-indicator.tsx'
import { AccountMenu } from './org-switcher.tsx'
import { SiteLink } from './site-link.tsx'
import { renderIcon } from './icon.tsx'
import { publicAsset } from '../public-assets.ts'
import { colors } from '#universal/styles/tokens.ts'

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
						padding: '1rem',
						gap: '1rem',
						borderRight: `1px solid ${colors.border}`,
						background: colors.background,
						'& [data-account-navigation]': {
							minHeight: 0,
							overflowY: 'auto',
							flex: 1,
							paddingTop: 0,
						},
						'& [data-account-nav]': { width: '100%', height: 'auto' },
						'& [data-account-nav] > div': { position: 'static', paddingTop: 0 },
						[accountManagementNarrowMq]: {
							position: 'relative',
							height: 'auto',
							borderRight: 0,
							borderBottom: `1px solid ${colors.border}`,
							gap: '0.5rem',
							'& [data-account-navigation]': {
								overflow: 'visible',
								paddingTop: 0,
							},
						},
					}}
				>
					<div
						css={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
						}}
					>
						<SiteLink
							href="/"
							aria-label="Kody home"
							css={{
								display: 'flex',
								alignItems: 'center',
								gap: '0.5rem',
								color: colors.text,
								textDecoration: 'none',
								fontWeight: 750,
								fontSize: '1.2rem',
							}}
						>
							<img
								src={publicAsset('/images/kody-mark.png')}
								alt=""
								width={30}
								height={30}
							/>
							Kody
						</SiteLink>
						<AccountMenu
							placement="sidebar"
							organizations={session.organizations ?? []}
							username={session.username}
							displayName={session.username || session.email}
							avatarUrl={session.avatarUrl}
						/>
					</div>
					{session.featureFlags['demo-indicator'] ? <DemoIndicator /> : null}
					<ShellNavigation navigation={navigation} />
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
						{session.roles.includes('admin') ? (
							<SiteLink href="/admin/users">Admin</SiteLink>
						) : null}
					</nav>
				</aside>
				<main
					id="main"
					tabIndex={-1}
					data-workspace-panel
					css={{
						minWidth: 0,
						background: colors.surface,
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
						viewTransitionName: 'page',
						padding: 'clamp(1rem, 3vw, 2.5rem)',
					}}
				>
					<Outlet />
				</main>
			</div>
		</WorkspaceLayoutContext>
	)
}
