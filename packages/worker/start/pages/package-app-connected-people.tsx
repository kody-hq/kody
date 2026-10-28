/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { revokePackageAppConnectedPerson } from '#start/server/package-app-connected-people'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	packageAppConnectedPeopleHref,
	packageAppConnectedPeoplePageCount,
	packageAppConnectedPersonName,
	type PackageAppConnectedPeopleLoaderData,
	type PackageAppConnectedPersonView,
} from '#universal/package-app-connected-people.ts'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { detailArticleCss } from '../components/community-detail-sections.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	PackageRepoTabPanel,
	renderPackageRepoChrome,
} from '../components/package-repo-nav.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	TimestampValue,
} from './account-management-components.tsx'
import {
	listCss,
	mutedCopyCss,
	rowActionsCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
} from './package-collaborators-parts.tsx'

export function PackageAppConnectedPeopleRoute({
	payload,
	actorKey,
}: {
	payload: Extract<PackageAppConnectedPeopleLoaderData, { ok: true }>
	actorKey: string | null
}) {
	const { shell, view } = payload
	const { username, kodyId } = shell
	const invalidate = usePageInvalidation('permissions')
	const captureSubmitter = useSubmitterScope()
	const [armed, setArmed] = useState<string | null>(null)
	const [revoked, setRevoked] = useState<ReadonlySet<string>>(() => new Set())
	const [message, setMessage] = useState<{
		tone: 'info' | 'error'
		text: string
	} | null>(null)
	const mutation = useMutation({
		mutationKey: ['packageAppConnectedPeople', actorKey, username, kodyId],
		retry: false,
		mutationFn: (person: PackageAppConnectedPersonView) =>
			revokePackageAppConnectedPerson({
				data: { username, kodyId, grantId: person.grantId },
			}),
		onMutate: () => invalidate,
		onSettled: (_result, _error, _input, reconcile) => reconcile?.(),
	})
	const busy = mutation.isPending ? mutation.variables?.grantId : null
	const people = view.people.filter((person) => !revoked.has(person.grantId))
	const total = Math.max(0, view.total - (view.people.length - people.length))
	const pageCount = packageAppConnectedPeoplePageCount(view)

	async function revoke(person: PackageAppConnectedPersonView) {
		const name = packageAppConnectedPersonName(person)
		const isCurrent = captureSubmitter()
		setMessage(null)
		try {
			await mutation.mutateAsync(person)
			if (!isCurrent()) return
			setRevoked((current) => new Set(current).add(person.grantId))
			setMessage({
				tone: 'info',
				text: `${name} is signed out of this app. They can sign in again and approve it.`,
			})
		} catch (error) {
			if (!isCurrent()) return
			setMessage({
				tone: 'error',
				text:
					error instanceof Error
						? error.message
						: `Could not sign out ${name}.`,
			})
		}
	}

	function renderPerson(person: PackageAppConnectedPersonView) {
		const name = packageAppConnectedPersonName(person)
		const handle = person.username ? `@${person.username}` : null
		const isArmed = armed === person.grantId
		return (
			<li
				key={person.grantId}
				data-testid="package-app-connected-person"
				css={rowCss}
			>
				<UserAvatar
					displayName={name}
					avatarUrl={person.avatarUrl}
					size={44}
					variant="well"
				/>
				<span css={personTextCss}>
					<span css={rowNameCss}>
						{person.profileHref ? (
							<SiteLink href={person.profileHref}>{name}</SiteLink>
						) : (
							name
						)}
					</span>
					<span css={rowDetailCss}>
						{handle && handle !== name ? `${handle} · ` : ''}
						Last used{' '}
						<TimestampValue value={person.lastUsedAt} fallback="never" />
						{' · '}
						Connected <TimestampValue value={person.connectedAt} />
					</span>
					<ul css={allowsCss} aria-label={`What ${name} approved`}>
						{person.allows.map((allow) => (
							<li key={allow}>{allow}</li>
						))}
					</ul>
				</span>
				<span css={rowActionsCss}>
					<button
						type="button"
						disabled={busy != null}
						css={getDangerPillCss({ size: 'sm' })}
						aria-label={
							isArmed
								? `Confirm sign out ${name}`
								: `Sign out ${name} from this app`
						}
						onBlur={() => setArmed(null)}
						onClick={() => {
							if (!isArmed) {
								setArmed(person.grantId)
								return
							}
							setArmed(null)
							void revoke(person)
						}}
					>
						{renderIcon('user-cross', { size: '1.05rem' })}
						{busy === person.grantId
							? 'Signing out…'
							: isArmed
								? 'Confirm sign out'
								: 'Sign out'}
					</button>
				</span>
			</li>
		)
	}

	function renderPager() {
		const outOfRange = view.page > pageCount
		if (pageCount <= 1 && !outOfRange) return null
		const pageHref = (page: number) =>
			packageAppConnectedPeopleHref({ username, kodyId, page })
		return (
			<nav
				aria-label="Connected people pages"
				data-testid="package-app-connected-people-pager"
				css={pagerCss}
			>
				{view.page > 1 ? (
					<SiteLink
						href={pageHref(Math.min(view.page - 1, pageCount))}
						css={getGhostButtonCss({ size: 'sm' })}
					>
						Newer
					</SiteLink>
				) : null}
				{outOfRange ? null : (
					<span css={mutedCopyCss}>
						Page {view.page} of {pageCount}
					</span>
				)}
				{view.page < pageCount ? (
					<SiteLink
						href={pageHref(view.page + 1)}
						css={getGhostButtonCss({ size: 'sm' })}
					>
						Older
					</SiteLink>
				) : null}
			</nav>
		)
	}

	return (
		<article
			css={detailArticleCss}
			data-testid="package-app-connected-people"
			aria-busy={busy != null || undefined}
		>
			{renderPackageRepoChrome({
				username,
				kodyId,
				isPrivate: shell.isPrivate,
				isListed: shell.isListed,
				viewerIsOwner: shell.viewerIsOwner,
				viewerCanManage: shell.viewerCanManage,
				viewerCanManageAccess: shell.viewerCanManageAccess,
				viewerCanSeeConnectedPeople: true,
				active: 'connected-people',
				filesHref: getPackageTreeHref({
					username,
					kodyId,
					listingId: shell.listingId,
					ref: shell.defaultBranch || fallbackDefaultBranchName,
				}),
				description: shell.description,
				ownerProfilePublic: shell.ownerProfilePublic,
				iconUrl: resolvePackageListIconUrl({
					username,
					kodyId,
					listingId: shell.listingId,
					listingIconCommit: null,
					publishedCommit: shell.publishedCommit,
				}),
				iconName: kodyId,
			})}
			<PackageRepoTabPanel>
				{message ? (
					<AccountManagementMessage tone={message.tone}>
						{message.text}
					</AccountManagementMessage>
				) : null}
				<AccountManagementPanel
					title={`Signed in with Kody (${total})`}
					description="People who approved this app with Sign in with Kody, most recently used first. Signing someone out ends their access on their next call, the same as when they revoke it from Account > Connected apps. Their own credentials stay in their account."
				>
					{people.length === 0 ? (
						<p
							css={mutedCopyCss}
							data-testid="package-app-connected-people-empty"
						>
							{total === 0
								? 'Nobody has signed in to this app with Kody yet.'
								: 'Nobody else on this page.'}
						</p>
					) : (
						<ul css={listCss} data-testid="package-app-connected-people-list">
							{people.map(renderPerson)}
						</ul>
					)}
					{renderPager()}
				</AccountManagementPanel>
			</PackageRepoTabPanel>
		</article>
	)
}

const personTextCss: CSSObject = {
	...rowTextCss,
	gap: spacing.xs,
}

const allowsCss: CSSObject = {
	margin: 0,
	paddingLeft: '1.1rem',
	display: 'grid',
	gap: '0.1rem',
	fontSize: typography.fontSize.sm,
	color: colors.text,
}

const pagerCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.md,
	marginTop: spacing.md,
}
