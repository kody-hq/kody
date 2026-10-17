/** @jsxImportSource @emotion/react */
import {
	getHandleFormatError,
	handleFormatHint,
	suggestHandle,
} from '@kody-internal/shared/handle-rules.ts'
import { permanentHandleInputProps } from '#client/handle-field.ts'
import {
	usePendingInviteActions,
	renderPendingInviteActions,
	type PendingInviteActions,
} from './pending-invite-actions.tsx'
import { useState, type ReactNode } from 'react'
import { type CSSObject } from '@emotion/react'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { renderIcon } from '../components/icon.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter, useRouteContext } from '@tanstack/react-router'
import { createOrg, restoreOrganization } from '#start/server/org-organizations'
import { invalidateShellQueries } from '../shell-query.ts'
import { SiteLink } from '../components/site-link.tsx'
import { type AccountOrganizationsLoaderData } from '#universal/loader-data.ts'
import {
	orgIdentity,
	orgRoleLabel,
	orgOverviewPath,
	orderOrganizations,
	organizationsWithSignupFallback,
} from '#universal/org-pages.ts'
import {
	handlePermanentNote,
	handleUrlPreview,
} from '@kody-internal/shared/handle-permanence.ts'
import {
	AccountManagementShell,
	AccountManagementPanel,
	AccountPageHeader,
	accountInputCss,
	AccountManagementMessage,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	noticeCardCss,
} from './account-management-components.tsx'
import {
	getPillButtonCss,
	getGhostButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
export function OrganizationsPage({
	data,
}: {
	data: AccountOrganizationsLoaderData
}) {
	const { pageLocation } = useMatchedPageScope()
	const inviteActions = usePendingInviteActions()
	const restore = useOrganizationRestore()
	return (
		<AccountManagementShell currentHref={pageLocation.href}>
			<AccountPageHeader
				title="Organizations"
				description="Each organization has its own repositories, secrets, and members. Open one to work in it, or switch from your avatar menu. Deleted organizations you owned can be restored here for 30 days."
				currentHref={pageLocation.href}
				actions={
					<SiteLink
						href={routes.accountOrganizationsNew.href()}
						data-testid="account-organizations-create"
						css={getPillButtonCss({ size: 'sm' })}
					>
						{renderIcon('plus', { size: '1.05rem' })}Create organization
					</SiteLink>
				}
			/>
			<AccountManagementPanel
				title="Your organizations"
				ariaLabel="Your organizations"
			>
				{renderOrganizationList(data)}
			</AccountManagementPanel>
			{data.restorableOrganizations.length || restore.error ? (
				<AccountManagementPanel
					title="Recently deleted"
					ariaLabel="Recently deleted organizations"
					description="Organizations you owned that can be restored for 30 days after deletion. Handles stay reserved until the window ends."
				>
					{restore.error ? (
						<AccountManagementMessage tone="error">
							{restore.error.message}
						</AccountManagementMessage>
					) : null}
					<ul css={orgListCss} data-testid="restorable-organizations">
						{data.restorableOrganizations.map((org) =>
							renderOrgRow({
								key: org.slug,
								slug: org.slug,
								displayName: org.displayName,
								personal: false,
								viewer: data.viewer,
								detail: `Deleted ${formatTimestampDate(org.deletedAt)}`,
								pills: [{ label: 'Deleted', tone: 'quiet' }],
								testId: 'restorable-organization',
								trailing: (
									<button
										type="button"
										data-testid="restore-organization"
										aria-label={`Restore @${org.slug}`}
										disabled={restore.isPending}
										css={getPillButtonCss({ size: 'sm' })}
										onClick={() => restore.submit(org.slug)}
									>
										{restore.isPending &&
										restore.variables?.orgSlug === org.slug
											? 'Restoring…'
											: 'Restore'}
									</button>
								),
							}),
						)}
					</ul>
				</AccountManagementPanel>
			) : null}
			<AccountManagementPanel
				id="invites"
				title="Invites"
				description="Invites addressed to you and invite links you opened. They also wait on your Waiting page."
				ariaLabel="Invites"
			>
				{inviteActions.message ? (
					<AccountManagementMessage tone={inviteActions.tone}>
						{inviteActions.message}
					</AccountManagementMessage>
				) : null}
				{renderInvites(data.pendingInvites, inviteActions)}
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}
export function CreateOrganizationPage() {
	const { actorKey, pageLocation } = useMatchedPageScope()
	return <CreateOrganizationForm key={`${actorKey}:${pageLocation.href}`} />
}
function CreateOrganizationForm() {
	const client = useQueryClient(),
		router = useRouter(),
		{ actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const { pageLocation } = useMatchedPageScope()
	const draft = new URL(pageLocation.href, 'https://kody.local').searchParams
	const [displayName, setDisplayName] = useState(draft.get('displayName') ?? '')
	const [slug, setSlug] = useState(draft.get('slug') ?? '')
	const [slugEdited, setSlugEdited] = useState(Boolean(draft.get('slug')))
	const [confirming, setConfirming] = useState(false)
	const [clientError, setClientError] = useState<{
		message: string
		field: 'displayName' | 'slug'
	} | null>(null)
	const restore = useOrganizationRestore()
	const [restorableSlug, setRestorableSlug] = useState<string | null>(
		draft.get('restorableSlug'),
	)
	const [createError, setCreateError] = useState<string | null>(null)
	const formErrorId = 'create-organization-form-error'
	const mutation = useMutation({
		mutationFn: ({
			data,
		}: {
			data: { displayName: string; slug: string }
			actorKey: string | null
		}) => createOrg({ data }),
		onSuccess: async (_result, { actorKey }) => {
			await Promise.all([
				invalidateShellQueries(client, actorKey),
				client.invalidateQueries({
					queryKey: ['page', actorKey, 'loadOrganizations'],
				}),
			])
		},
	})
	const formError =
		clientError?.message ??
		createError ??
		mutation.error?.message ??
		draft.get('error')
	const slugInvalid =
		clientError?.field === 'slug' ||
		Boolean(
			formError &&
			!clientError &&
			/(handle|slug|taken|reserved)/i.test(formError),
		)

	return (
		<AccountManagementShell
			currentHref="/account/organizations/new"
			maxWidth="40rem"
		>
			<AccountPageHeader
				title="Create organization"
				description="An organization owns its own packages, secrets, and members, separate from your personal account."
				currentHref="/account/organizations/new"
			/>
			{formError ? (
				<AccountManagementMessage tone="error">
					<span id={formErrorId}>
						{clientError?.message ??
							createError ??
							mutation.error?.message ??
							draft.get('error')}
					</span>
				</AccountManagementMessage>
			) : null}
			{restore.error ? (
				<AccountManagementMessage tone="error">
					{restore.error.message}
				</AccountManagementMessage>
			) : null}
			{restorableSlug ? (
				<div css={accountActionsCss} data-testid="create-org-restore">
					<button
						type="button"
						disabled={restore.isPending || mutation.isPending}
						css={getPillButtonCss({ size: 'sm' })}
						onClick={() => restore.submit(restorableSlug)}
					>
						{restore.isPending ? 'Restoring…' : `Restore @${restorableSlug}`}
					</button>
				</div>
			) : null}
			<AccountManagementPanel title="Details">
				<form
					data-testid="create-organization-form"
					noValidate
					onSubmit={(event) => {
						event.preventDefault()
						if (mutation.isPending || restore.isPending) return
						const name = displayName.trim()
						if (!name || name.length > 80) {
							setClientError({
								message: 'Enter a name up to 80 characters.',
								field: 'displayName',
							})
							setConfirming(false)
							return
						}
						const error = getHandleFormatError(slug.trim(), {
							label: 'Handle',
						})
						if (error) {
							setClientError({ message: error, field: 'slug' })
							setConfirming(false)
							return
						}
						setClientError(null)
						if (!confirming) {
							setConfirming(true)
							return
						}
						const isCurrent = capture()
						mutation.mutate(
							{ data: { displayName, slug }, actorKey },
							{
								onSuccess: (result) => {
									if (!isCurrent()) return
									if (!result.ok) {
										setRestorableSlug(result.restorableSlug)
										setCreateError(result.error)
										setConfirming(false)
										return
									}
									void router.navigate({ href: `/@${result.slug}` })
								},
							},
						)
					}}
					css={formCss}
				>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Name</span>
						<input
							data-field-ring
							css={accountInputCss}
							name="displayName"
							aria-invalid={clientError?.field === 'displayName' || undefined}
							aria-describedby={
								clientError?.field === 'displayName' ? formErrorId : undefined
							}
							required
							maxLength={80}
							autoComplete="organization"
							value={displayName}
							onChange={(event) => {
								const name = event.currentTarget.value
								setDisplayName(name)
								setClientError(null)
								if (!slugEdited) {
									setRestorableSlug(null)
									setCreateError(null)
									setSlug(slugFromName(name))
									setConfirming(false)
								}
							}}
						/>
						<p css={accountFieldNoteCss}>
							Shown in the header and to members. You can change it later.
						</p>
					</label>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Handle</span>
						<span css={slugFieldCss}>
							<span aria-hidden="true" css={slugPrefixCss}>
								kody.codes/@
							</span>
							<input
								data-field-ring
								css={slugInputCss}
								aria-describedby={[
									'create-organization-slug-note',
									slugInvalid ? formErrorId : null,
								]
									.filter(Boolean)
									.join(' ')}
								aria-invalid={slugInvalid || undefined}
								name="slug"
								value={slug}
								onChange={(event) => {
									setClientError(null)
									setRestorableSlug(null)
									setCreateError(null)
									setSlugEdited(event.currentTarget.value.length > 0)
									setSlug(event.currentTarget.value.toLowerCase())
									setConfirming(false)
								}}
								{...permanentHandleInputProps()}
								autoComplete="off"
								required
							/>
						</span>
						<p id="create-organization-slug-note" css={accountFieldNoteCss}>
							{handleFormatHint} {handlePermanentNote} Your organization's URL
							will be{' '}
							<strong data-testid="create-organization-url-preview">
								{handleUrlPreview(slug || 'your-handle')}
							</strong>
							.
						</p>
					</label>
					{confirming ? (
						<p
							css={accountFieldNoteCss}
							role="status"
							data-testid="create-organization-confirm"
						>
							Your organization URL will be{' '}
							<strong>{handleUrlPreview(slug)}</strong>. This can't be changed.
							Create it?
						</p>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="submit"
							disabled={mutation.isPending}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{mutation.isPending
								? 'Creating…'
								: confirming
									? 'Yes, create organization'
									: 'Create organization'}
						</button>
						<SiteLink
							href="/account/organizations"
							css={getGhostButtonCss({ size: 'sm' })}
						>
							Cancel
						</SiteLink>
					</div>
				</form>
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}

function slugFromName(name: string) {
	return suggestHandle(name) ?? ''
}

type OrgViewer = { displayName: string; avatarUrl: string | null }

/**
 * One organization as a row: avatar, name, handle, and trailing pills. A row
 * with an `href` is a link card; without one it is a plain listing (invites
 * point at organizations the person cannot open yet).
 */
function renderOrgRow(input: {
	key: string
	slug: string
	displayName: string | null
	personal: boolean
	viewer: OrgViewer
	detail: ReactNode
	pills: Array<{ label: string; tone: 'accent' | 'quiet' }>
	href?: string
	testId: string
	trailing?: ReactNode
}) {
	const identity = orgIdentity(input, input.viewer)
	const detail = (
		<>
			{identity.hasName ? identity.handle : null}
			{identity.hasName && input.detail ? ' · ' : null}
			{input.detail}
		</>
	)
	const body = (
		<>
			<UserAvatar
				displayName={identity.avatarName}
				avatarUrl={identity.avatarUrl}
				size={44}
				variant="well"
			/>
			<span css={orgRowTextCss}>
				<span css={orgRowNameCss}>{identity.name}</span>
				{detail ? <span css={orgRowDetailCss}>{detail}</span> : null}
			</span>
			{input.pills.length > 0 ? (
				<span css={orgRowPillsCss}>
					{input.pills.map((pill) => (
						<span
							key={pill.label}
							css={pill.tone === 'accent' ? accentPillCss : quietPillCss}
						>
							{pill.label}
						</span>
					))}
				</span>
			) : null}
			{input.trailing ?? null}
		</>
	)
	return (
		<li key={input.key} data-testid={input.testId} css={orgRowItemCss}>
			{input.href ? (
				<SiteLink href={input.href} css={[orgRowCss, orgRowLinkCss]}>
					{body}
					<span aria-hidden="true" css={orgRowChevronCss}>
						{renderIcon('chevron-right', { size: '1.1rem' })}
					</span>
				</SiteLink>
			) : (
				<div css={orgRowCss}>{body}</div>
			)}
		</li>
	)
}

function renderOrganizationList(data: AccountOrganizationsLoaderData) {
	const organizations = orderOrganizations(
		organizationsWithSignupFallback({
			organizations: data.organizations,
			username: data.username,
		}),
	)
	return (
		<ul css={orgListCss} data-testid="account-organizations">
			{organizations.map((org) =>
				renderOrgRow({
					key: org.slug,
					slug: org.slug,
					displayName: org.displayName,
					personal: org.personal,
					viewer: data.viewer,
					detail: orgRoleLabel(org.role),
					pills: [],
					// Each org opens its overview: a team org's home (which
					// links Settings, Members, and its sections), the signup
					// org's workspace overview.
					href: org.personal
						? orgOverviewPath(org.slug)
						: routes.profile.href({ username: org.slug }),
					testId: 'account-organization',
				}),
			)}
		</ul>
	)
}

function renderInvites(
	invites: AccountOrganizationsLoaderData['pendingInvites'],
	actions: PendingInviteActions,
) {
	if (invites.length === 0) {
		return (
			<div css={emptyStateCss} data-testid="invites-empty">
				<span aria-hidden="true" css={emptyIconCss}>
					{renderIcon('inbox', { size: '1.5rem' })}
				</span>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<p css={emptyTitleCss}>No invites waiting</p>
					<p css={mutedCopyCss}>
						When someone invites you to an organization, team, or package, it
						shows up here.
					</p>
				</div>
			</div>
		)
	}
	return (
		<ul css={orgListCss} data-testid="invites-list">
			{invites.map((invite) =>
				renderOrgRow({
					key: `${invite.source}:${invite.id}`,
					slug: invite.orgSlug,
					displayName: invite.orgDisplayName,
					personal: invite.orgPersonal,
					viewer: { displayName: '', avatarUrl: null },
					detail: (
						<>
							{invite.label} · Expires {formatTimestampDate(invite.expiresAt)}
						</>
					),
					pills: [],
					testId: 'pending-invite',
					trailing: renderPendingInviteActions(invite, actions),
				}),
			)}
		</ul>
	)
}

const orgListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const orgRowItemCss: CSSObject = {
	minWidth: 0,
}

const orgRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	textDecoration: 'none',
}

const orgRowLinkCss: CSSObject = {
	transition: `border-color ${transitions.fast}, transform ${transitions.fast}`,
	'&:active': { transform: 'scale(0.995)' },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted, color: colors.text },
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { transform: 'none' },
	},
}

const orgRowTextCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const orgRowNameCss: CSSObject = {
	fontWeight: 650,
	fontSize: '1rem',
	lineHeight: 1.25,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const orgRowDetailCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	lineHeight: 1.3,
	overflowWrap: 'anywhere' as const,
}

const orgRowPillsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'flex-end',
	gap: spacing.xs,
	flexShrink: 0,
}

const pillBaseCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	fontSize: '0.8rem',
	fontWeight: 600,
	lineHeight: 1.4,
	borderRadius: radius.full,
	padding: '0.1rem 0.6rem',
	whiteSpace: 'nowrap' as const,
}

const accentPillCss: CSSObject = {
	...pillBaseCss,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const quietPillCss: CSSObject = {
	...pillBaseCss,
	color: colors.textMuted,
	boxShadow: `inset 0 0 0 1px ${colors.border}`,
}

const orgRowChevronCss: CSSObject = {
	display: 'inline-flex',
	flexShrink: 0,
	color: colors.textMuted,
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
}

const slugFieldCss: CSSObject = {
	display: 'flex',
	alignItems: 'stretch',
	minWidth: 0,
}

const slugPrefixCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	paddingInline: '0.85rem',
	borderRadius: '12px 0 0 12px',
	border: `1.5px solid ${colors.fieldBorder}`,
	borderRight: 'none',
	backgroundColor: colors.background,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
}

const slugInputCss: CSSObject = {
	...accountInputCss,
	flex: '1 1 auto',
	minWidth: 0,
	borderTopLeftRadius: 0,
	borderBottomLeftRadius: 0,
}

const mutedCopyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

const emptyStateCss: CSSObject = {
	...noticeCardCss,
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
}

const emptyIconCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	width: '3rem',
	height: '3rem',
	borderRadius: radius.full,
	border: `1px dashed ${colors.border}`,
	color: colors.textMuted,
}

const emptyTitleCss: CSSObject = {
	margin: 0,
	fontWeight: 650,
	color: colors.text,
}

function useOrganizationRestore() {
	const client = useQueryClient(),
		router = useRouter()
	const { actorKey } = useMatchedPageScope()
	const capture = useSubmitterScope()
	const mutation = useMutation({
		gcTime: 0,
		retry: false,
		mutationFn: ({ orgSlug }: { orgSlug: string; actorKey: string | null }) =>
			restoreOrganization({ data: { orgSlug } }),
		onSettled: async (_data, _error, input) => {
			await Promise.allSettled([
				invalidateShellQueries(client, input.actorKey),
				client.invalidateQueries({
					queryKey: ['page', input.actorKey, 'loadOrganizations'],
				}),
			])
		},
	})
	return {
		...mutation,
		error: mutation.variables?.actorKey === actorKey ? mutation.error : null,
		isPending: mutation.variables?.actorKey === actorKey && mutation.isPending,
		submit: (orgSlug: string) => {
			if (mutation.isPending) return
			const isCurrent = capture()
			mutation.mutate(
				{ orgSlug, actorKey },
				{
					onSuccess: (result) => {
						if (isCurrent()) void router.navigate({ href: `/@${result.slug}` })
					},
				},
			)
		},
	}
}
