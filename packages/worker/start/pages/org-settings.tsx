/** @jsxImportSource @emotion/react */
import {
	updateOrganizationProfile,
	deleteOrganization,
	removeOrganizationPhoto,
	saveOrganizationAvatar,
} from '#start/server/org-settings-mutations'
import { type CSSObject } from '@emotion/react'
import { useRef, useState } from 'react'
import {
	hashKey,
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useRouteContext, useRouter } from '@tanstack/react-router'
import {
	handlePermanentNote,
	handleUrlPreview,
} from '@kody-internal/shared/handle-permanence.ts'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { orgIdentity } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { orgSettingsMutationOptions } from '../org-settings-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import { renderIcon } from '../components/icon.tsx'
import { AccountAvatarEditor } from './account-avatar-editor.tsx'
import { OrgSettingsCustomDomains } from './org-settings-custom-domains.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'

type OrgSettingsProps = {
	data: OrgSettingsLoaderData
	queryKey: QueryKey
}

export function OrgSettingsPage(props: OrgSettingsProps) {
	return <OrgSettingsEditor key={hashKey(props.queryKey)} {...props} />
}

function OrgSettingsEditor({ data, queryKey }: OrgSettingsProps) {
	const client = useQueryClient()
	const router = useRouter()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const [draftName, setDraftName] = useState(data.org.displayName ?? '')
	const [avatarFile, setAvatarFile] = useState<File | null>(null)
	const [confirmation, setConfirmation] = useState('')
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const dialog = useRef<HTMLDialogElement>(null)
	const identity = orgIdentity(data.org, { displayName: '', avatarUrl: null })
	const profile = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			updateOrganizationProfile,
		),
	)
	const avatar = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			saveOrganizationAvatar,
		),
	)
	const removePhoto = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			removeOrganizationPhoto,
		),
	)
	const deletion = useMutation(
		orgSettingsMutationOptions(client, queryKey, actorKey, deleteOrganization),
	)
	const isPending =
		profile.isPending ||
		avatar.isPending ||
		removePhoto.isPending ||
		deletion.isPending
	async function submit<T>(
		run: () => Promise<T>,
		accepted: (result: T) => void | Promise<void>,
		allowed = data.canManage,
	) {
		if (isPending || !allowed) return
		const isCurrent = capture()
		setMessage(null)
		try {
			const result = await run()
			if (!isCurrent()) return
			setAvatarFile(null)
			await accepted(result)
		} catch (error) {
			if (isCurrent())
				setMessage({
					text:
						error instanceof Error ? error.message : 'Unable to save settings.',
					tone: 'error',
				})
		}
	}
	function saved(text: string) {
		setMessage({ text, tone: 'info' })
	}
	function uploadAvatar(file: File) {
		const form = new FormData()
		form.set('orgSlug', data.org.slug)
		form.set('avatar', file)
		return submit(
			() => avatar.mutateAsync(form),
			() => saved('Avatar updated.'),
		)
	}
	const closeDialog = () => {
		dialog.current?.close()
		setConfirmation('')
	}
	return (
		<AccountManagementShell currentHref={`/@${data.org.slug}/-/settings`}>
			<AccountPageHeader
				title="Settings"
				description="The organization's name, handle, and photo."
				currentHref={`/@${data.org.slug}/-/settings`}
			/>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			{data.org.personal ? (
				<AccountManagementPanel title="Identity">
					<p css={mutedCopyCss}>
						This is your personal organization. Your name, photo, and handle
						come from your{' '}
						<SiteLink href={routes.account.href()} css={inlineLinkCss}>
							account profile
						</SiteLink>
						. To delete your account, use{' '}
						<SiteLink href={routes.accountData.href()} css={inlineLinkCss}>
							Account → Data &amp; deletion
						</SiteLink>
						.
					</p>
				</AccountManagementPanel>
			) : (
				<>
					<AccountManagementPanel title="Profile">
						<div css={identityRowCss} data-testid="org-settings-identity">
							<UserAvatar
								displayName={identity.avatarName}
								avatarUrl={identity.avatarUrl}
								size={44}
								variant="well"
							/>
							<span css={identityTextCss}>
								<span css={identityNameCss}>{identity.name}</span>
								<span css={identityDetailCss}>{identity.handle}</span>
							</span>
						</div>
						{data.canManage ? (
							<div css={avatarActionsCss}>
								<label css={getGhostButtonCss({ size: 'sm' })}>
									{renderIcon('photo', { size: '1.05rem' })}
									{identity.avatarUrl ? 'Change photo' : 'Add photo'}
									<input
										type="file"
										accept="image/png,image/jpeg,image/webp"
										hidden
										disabled={isPending}
										onChange={(event) => {
											const file = event.currentTarget.files?.[0]
											event.currentTarget.value = ''
											if (file) setAvatarFile(file)
										}}
									/>
								</label>
								{identity.avatarUrl ? (
									<button
										type="button"
										css={getGhostButtonCss({ size: 'sm' })}
										disabled={isPending}
										onClick={() =>
											void submit(
												() =>
													removePhoto.mutateAsync({ orgSlug: data.org.slug }),
												() => saved('Avatar removed.'),
											)
										}
									>
										Remove photo
									</button>
								) : null}
							</div>
						) : null}
						{avatarFile ? (
							<AccountAvatarEditor
								file={avatarFile}
								onCancel={() => setAvatarFile(null)}
								onApply={(file) => void uploadAvatar(file)}
								onBusyChange={() => undefined}
							/>
						) : null}
						{data.canManage ? (
							<form
								css={formCss}
								onSubmit={(event) => {
									event.preventDefault()
									void submit(
										() =>
											profile.mutateAsync({
												orgSlug: data.org.slug,
												displayName: draftName,
											}),
										() => saved('Settings saved.'),
									)
								}}
							>
								<label css={accountFieldCss}>
									<span css={accountFieldLabelCss}>Name</span>
									<input
										name="displayName"
										required
										maxLength={80}
										value={draftName}
										data-field-ring
										css={accountInputCss}
										onChange={(event) =>
											setDraftName(event.currentTarget.value)
										}
									/>
								</label>
								<div css={accountFieldCss}>
									<span css={accountFieldLabelCss}>Handle</span>
									<p
										aria-describedby="org-settings-handle-note"
										css={handleValueCss}
									>
										{handleUrlPreview(data.org.slug)}
									</p>
									<p id="org-settings-handle-note" css={accountFieldNoteCss}>
										{handlePermanentNote} Change the name above to change how
										the organization appears.
									</p>
								</div>
								<div css={accountActionsCss}>
									<button
										type="submit"
										disabled={isPending}
										css={getPillButtonCss({ size: 'sm' })}
									>
										{profile.isPending ? 'Saving…' : 'Save changes'}
									</button>
								</div>
							</form>
						) : (
							<p css={mutedCopyCss}>
								Only an owner can change this organization's profile.
							</p>
						)}
					</AccountManagementPanel>
					<OrgSettingsCustomDomains
						key={data.org.slug}
						data={data}
						queryKey={queryKey}
						onMessage={(text, tone) => setMessage({ text, tone })}
					/>
					{data.canDelete ? (
						<AccountManagementPanel title="Delete organization">
							<p css={accountFieldNoteCss}>
								This soft-deletes the organization. Members lose access
								immediately. Owners can restore it for 30 days from Account →
								Organizations.
							</p>
							<div css={accountActionsCss}>
								<button
									type="button"
									data-testid="delete-org"
									css={getDangerPillCss({ size: 'sm' })}
									onClick={() => {
										setConfirmation('')
										dialog.current?.showModal()
									}}
								>
									{renderIcon('warning-triangle', { size: '1.05rem' })}Delete
									organization
								</button>
							</div>
							<dialog
								ref={dialog}
								aria-labelledby="delete-org-title"
								data-testid="delete-org-dialog"
								css={deleteDialogCss}
								onCancel={(event) => {
									event.preventDefault()
									closeDialog()
								}}
								onClick={(event) => {
									if (event.target === event.currentTarget) closeDialog()
								}}
							>
								<form
									method="dialog"
									css={deleteDialogFormCss}
									onSubmit={(event) => {
										event.preventDefault()
										void submit(
											() =>
												deletion.mutateAsync({
													orgSlug: data.org.slug,
													confirmation,
												}),
											async (result) => {
												dialog.current?.close()
												await router.navigate({ href: result.redirectTo })
											},
											data.canDelete,
										)
									}}
								>
									<h3 id="delete-org-title" css={deleteDialogTitleCss}>
										Delete @{data.org.slug}?
									</h3>
									<p css={accountFieldNoteCss}>
										Type <strong>{data.org.slug}</strong> or{' '}
										<strong>DELETE</strong> to confirm.
									</p>
									<label css={accountFieldCss}>
										<span css={accountFieldLabelCss}>Confirmation</span>
										<input
											value={confirmation}
											data-field-ring
											autoComplete="off"
											css={accountInputCss}
											onChange={(event) =>
												setConfirmation(event.currentTarget.value)
											}
										/>
									</label>
									<div css={accountActionsCss}>
										<button
											type="submit"
											disabled={
												(confirmation !== data.org.slug &&
													confirmation !== 'DELETE') ||
												isPending
											}
											css={getDangerPillCss({ size: 'sm' })}
										>
											{isPending ? 'Deleting…' : 'Delete organization'}
										</button>
										<button
											type="button"
											css={getGhostButtonCss({ size: 'sm' })}
											onClick={closeDialog}
										>
											Cancel
										</button>
									</div>
								</form>
							</dialog>
						</AccountManagementPanel>
					) : null}
				</>
			)}
		</AccountManagementShell>
	)
}

const mutedCopyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

const inlineLinkCss: CSSObject = {
	color: colors.primaryText,
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
	marginTop: spacing.md,
}

const identityRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
}

const identityTextCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
}

const identityNameCss: CSSObject = {
	fontWeight: 650,
}

const handleValueCss: CSSObject = {
	margin: 0,
	fontFamily: typography.fontFamilyMono,
	color: colors.text,
}

const identityDetailCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const avatarActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	marginTop: spacing.md,
}

const deleteDialogCss: CSSObject = {
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: spacing.lg,
	maxWidth: '28rem',
	width: 'calc(100% - 2rem)',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'rgba(15, 18, 16, 0.45)',
	},
}

const deleteDialogFormCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
}

const deleteDialogTitleCss: CSSObject = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 700,
}
