/** @jsxImportSource @emotion/react */
import { type QueryKey } from '@tanstack/react-query'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { SiteLink } from '../components/site-link.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	type OrgCollaboratorsLoaderData,
	type OrgCollaboratorView,
} from '#universal/loader-data.ts'
import { orgGrantsPath, orgIdentity } from '#universal/org-pages.ts'
import { UserAvatar } from '../components/user-avatar.tsx'
function personLabel(person: OrgCollaboratorView) {
	return (
		person.displayName?.trim() ||
		(person.username ? `@${person.username}` : person.userId)
	)
}

export function OrgCollaboratorsPage({
	data,
}: {
	data: OrgCollaboratorsLoaderData
	queryKey: QueryKey
}) {
	return (
		<AccountManagementShell currentHref={`/@${data.org.slug}/-/collaborators`}>
			<AccountPageHeader
				title="Collaborators"
				description="People with grants on this organization who are not members."
				currentHref={`/@${data.org.slug}/-/collaborators`}
			/>
			{data?.ok ? (
				<AccountManagementPanel
					title="Outside collaborators"
					ariaLabel="Outside collaborators"
				>
					{data.collaborators.length === 0 ? (
						<p css={mutedCopyCss} data-testid="org-collaborators-empty">
							No outside collaborators. Grant package access to someone who is
							not a member, or review live grants on{' '}
							<SiteLink href={orgGrantsPath(data.org.slug)}>Grants</SiteLink>.
						</p>
					) : (
						<ul css={listCss} data-testid="org-collaborators">
							{data.collaborators.map((person) => {
								const identity = orgIdentity(
									{
										slug: person.username ?? person.userId,
										displayName: person.displayName,
										personal: false,
										avatarUrl: person.avatarUrl,
									},
									{ displayName: '', avatarUrl: null },
								)
								return (
									<li
										key={person.userId}
										data-testid="org-collaborator"
										css={rowItemCss}
									>
										<div css={rowCss}>
											<UserAvatar
												displayName={identity.avatarName}
												avatarUrl={person.avatarUrl}
												size={44}
												variant="well"
											/>
											<span css={rowTextCss}>
												<span css={rowNameCss}>{personLabel(person)}</span>
												<span css={rowDetailCss}>
													{person.username ? `@${person.username} · ` : ''}
													{person.grants.length} grant
													{person.grants.length === 1 ? '' : 's'}
												</span>
												{person.grants.length > 0 ? (
													<ul css={grantListCss}>
														{person.grants.map((grant) => (
															<li key={grant.id}>
																{grant.presetLabel ?? 'Custom'} on{' '}
																{grant.resourceLabel}
															</li>
														))}
													</ul>
												) : null}
											</span>
										</div>
									</li>
								)
							})}
						</ul>
					)}
				</AccountManagementPanel>
			) : null}
		</AccountManagementShell>
	)
}
const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.5,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const grantListCss = {
	listStyle: 'none',
	margin: `${spacing.xs} 0 0`,
	padding: 0,
	display: 'grid',
	gap: '0.2rem',
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const rowItemCss = {
	minWidth: 0,
}

const rowCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const rowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}
