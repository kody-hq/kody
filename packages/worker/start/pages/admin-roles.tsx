/** @jsxImportSource @emotion/react */
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { type AdminRolesLoaderData } from '#universal/loader-data.ts'
export function AdminRolesPage({
	payload: data,
	currentHref,
}: {
	payload: AdminRolesLoaderData
	currentHref: string
}) {
	const pending = false
	const message = null
	const status: string = 'ready'
	const roles = data.roles
	return (
		<AccountManagementShell currentHref={currentHref} busy={pending}>
			<AdminPageHeader
				title="Admin roles"
				description="Read-only view of roles and the permissions attached to each."
				currentHref={currentHref}
			/>
			{status === 'loading' ? (
				<p css={{ color: colors.textMuted, margin: 0 }}>Loading roles…</p>
			) : null}
			{message ? (
				<AccountManagementMessage tone={status === 'error' ? 'error' : 'info'}>
					{message}
				</AccountManagementMessage>
			) : null}
			<div css={{ display: 'grid', gap: spacing.lg }}>
				{roles.map((role) => (
					<AccountManagementPanel
						key={role.name}
						title={role.name}
						description={role.description || 'No description provided.'}
					>
						<ul
							css={{
								margin: 0,
								paddingLeft: spacing.lg,
								display: 'grid',
								gap: spacing.xs,
							}}
						>
							{role.permissions.map((permission) => (
								<li key={permission}>
									<code css={{ fontSize: typography.fontSize.sm }}>
										{permission}
									</code>
								</li>
							))}
						</ul>
					</AccountManagementPanel>
				))}
			</div>
		</AccountManagementShell>
	)
}
