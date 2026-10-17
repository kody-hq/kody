/** @jsxImportSource @emotion/react */
import { listenForAvatarFileDrop } from '#client/listen-for-avatar-file-drop.ts'
import { type AccountPagePayloads } from '#client/routes/account-page-data.ts'
import {
	interpretAccountProfileSave,
	readProfileFormValues,
} from '#client/routes/account-profile-save.ts'
import { shouldShowOnboardingChecklist } from '#universal/onboarding-checklist.ts'
import { toast } from '#client/toast.ts'
import { saveProfile, updateAvatar } from '#start/server/account-mutations'
import { type ProfileVisibility } from '#universal/loader-data.ts'
import {
	getGhostButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	useIsMutating,
	useMutation,
	useMutationState,
	useQueryClient,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import {
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	type FormEvent,
} from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { usePendingProfile } from './account-profile-query.ts'
import {
	settleAccountMutation,
	profileResources,
} from './account-mutation-settlement.ts'
import { AccountAvatarEditor } from './account-avatar-editor.tsx'
import { avatarMutationOptions } from './account-avatar-query.ts'
import { useAccountConnections } from './account-connections-panel.tsx'
import { AccountConvertPersonalOrgPanel } from './account-convert-personal-org-panel.tsx'
import { AccountDeletePanel } from './account-delete-panel.tsx'
import { useAccountEmailClaims } from './account-email-claims.ts'
import { AccountFormerEmailsPanel } from './account-former-emails-panel.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { AccountPasswordPanel } from './account-password-panel.tsx'
import { AccountProfilePanel } from './account-profile-panel.tsx'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from './email-verification-prompt.tsx'
import { renderOnboardingBanner } from './onboarding-banner.tsx'

export function AccountPage({
	payloads,
	currentHref,
	view,
}: {
	view: 'profile' | 'security' | 'data'
	payloads: AccountPagePayloads
	currentHref: string
}) {
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const captureAccountSubmitter = useSubmitterScope()
	useEffect(() => {
		setAvatarPreview(undefined)
		setAvatarStatus('idle')
		setEditorFile(null)
		return () => {
			releaseOptimisticAvatar()
		}
	}, [actorKey, currentHref])
	const invalidatePages = usePageInvalidation(mutationResources, {
		refreshShell: true,
	})
	const pendingProfile = usePendingProfile(actorKey)
	const initial = { ...payloads.accountProfile, ...pendingProfile }
	const [resendMessage, setResendMessage] = useState<string | null>(null)
	const [resendTone, setResendTone] = useState<'error' | 'info'>('info')
	const { email, emailVerified, username } = initial
	const emailVerificationDelivery = initial.emailVerificationDelivery ?? null
	const savedDisplayName = initial.displayName
	const savedBio = initial.bio ?? ''
	const savedProfileVisibility = initial.profileVisibility
	const [displayNameEdit, setDraftDisplayName] = useState<string>()
	const [bioEdit, setDraftBio] = useState<string>()
	const [visibilityEdit, setDraftProfileVisibility] =
		useState<ProfileVisibility>()
	const draftDisplayName = displayNameEdit ?? savedDisplayName
	const draftBio = bioEdit ?? savedBio
	const draftProfileVisibility = visibilityEdit ?? savedProfileVisibility
	const [avatarPreview, setAvatarPreview] = useState<string | null>()
	const avatarUrl =
		avatarPreview === undefined ? initial.avatarUrl : avatarPreview
	const [avatarEditorStatus, setAvatarStatus] = useState<
		'idle' | 'editing' | 'uploading' | 'removing'
	>('idle')
	const pendingAvatars = useMutationState({
		filters: { mutationKey: ['avatar', actorKey], status: 'pending' },
		select: (mutation) =>
			mutation.state.variables as { file?: File } | undefined,
	})
	const avatarStatus =
		pendingAvatars.length > 0
			? pendingAvatars[0]?.file
				? 'uploading'
				: 'removing'
			: avatarEditorStatus
	const [editorFile, setEditorFile] = useState<File | null>(null)
	const [avatarDropActive, setAvatarDropActive] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'error' | 'info'>('info')
	const optimisticAvatar = useRef<string | null>(null)
	const accountConnections = useAccountConnections(
		payloads.accountConnections,
		currentHref,
	)
	const accountEmailClaims = useAccountEmailClaims(
		initial.email,
		initial.formerEmails ?? [],
	)
	const needsOnboarding = payloads.onboarding?.needsOnboarding === true
	const onboardingChecklist = payloads.onboarding?.checklist ?? null

	function releaseOptimisticAvatar() {
		if (!optimisticAvatar.current) return
		URL.revokeObjectURL(optimisticAvatar.current)
		optimisticAvatar.current = null
	}

	function openAvatarEditor(file: File) {
		if (avatarStatus !== 'idle' && avatarStatus !== 'editing') return
		setEditorFile(file)
		setAvatarStatus('editing')
		setMessage(null)
		setMessageTone('info')
	}

	const onDroppedFile = useEffectEvent((file: File) => openAvatarEditor(file))
	useEffect(() => {
		const controller = new AbortController()
		listenForAvatarFileDrop({
			signal: controller.signal,
			onDragActiveChange: setAvatarDropActive,
			onImageFile: onDroppedFile,
		})
		return () => {
			controller.abort()
			if (optimisticAvatar.current)
				URL.revokeObjectURL(optimisticAvatar.current)
			optimisticAvatar.current = null
		}
	}, [])

	function closeAvatarEditor() {
		setEditorFile(null)
		if (avatarStatus === 'editing') setAvatarStatus('idle')
	}

	function setAvatarEditorBusy(busy: boolean) {
		if (busy) {
			setAvatarStatus('uploading')
		} else if (editorFile) {
			setAvatarStatus('editing')
		}
	}

	function uploadPreparedAvatar(prepared: File) {
		const isCurrent = captureAccountSubmitter()
		setEditorFile(null)
		releaseOptimisticAvatar()
		optimisticAvatar.current = URL.createObjectURL(prepared)
		setAvatarPreview(optimisticAvatar.current)
		setAvatarStatus('idle')

		avatarMutation.mutate(
			{ actorKey, href: currentHref, username, file: prepared },
			{
				onSuccess: () => {
					if (isCurrent()) toast.success('Avatar updated.')
				},
				onError: (error) =>
					isCurrent() &&
					toast.error(
						error instanceof Error ? error.message : 'Unable to upload avatar.',
					),
				onSettled: () => {
					if (!isCurrent()) return
					releaseOptimisticAvatar()
					setAvatarPreview(undefined)
					setAvatarStatus('idle')
				},
			},
		)
	}

	function handleAvatarSelected(event: FormEvent<HTMLElement>) {
		const input = event.currentTarget
		if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return
		try {
			openAvatarEditor(input.files[0])
		} finally {
			input.value = ''
		}
	}

	function handleRemoveAvatar() {
		const isCurrent = captureAccountSubmitter()
		releaseOptimisticAvatar()
		setAvatarPreview(null)
		setAvatarStatus('idle')

		avatarMutation.mutate(
			{ actorKey, href: currentHref, username },
			{
				onSuccess: () => {
					if (isCurrent()) toast.success('Avatar removed.')
				},
				onError: (error) =>
					isCurrent() &&
					toast.error(
						error instanceof Error ? error.message : 'Unable to remove avatar.',
					),
				onSettled: () => {
					if (!isCurrent()) return
					setAvatarPreview(undefined)
					setAvatarStatus('idle')
				},
			},
		)
	}

	const resendMutation = useMutation({
		gcTime: 0,
		mutationFn: requestResendVerification,
		onMutate: () => invalidatePages,
		onSettled: (_data, _error, _variables, reconcile) => reconcile?.(),
	})
	async function handleResendVerification() {
		const isCurrent = captureAccountSubmitter()
		setResendMessage(null)
		setResendTone('info')
		try {
			const result = await resendMutation.mutateAsync()
			if (!isCurrent()) return
			setResendTone(result.ok ? 'info' : 'error')
			setResendMessage(result.message)
		} catch {
			if (!isCurrent()) return
			setResendTone('error')
			setResendMessage('Unable to send the verification email.')
		}
	}

	const avatarMutation = useMutation({
		mutationKey: ['avatar', actorKey],
		...avatarMutationOptions(queryClient, async ({ file }) => {
			const data = new FormData()
			if (file) data.set('avatar', file)
			else data.set('remove', 'true')
			return updateAvatar({ data })
		}),
	})

	const isSaving = useIsMutating({ mutationKey: ['profile', actorKey] }) > 0
	const captureProfileSubmitter = useSubmitterScope()
	const profileMutation = useMutation({
		gcTime: 0,
		mutationKey: ['profile', actorKey],
		mutationFn: saveProfile,
		onMutate: () => ({ actorKey }),
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : 'Unable to save profile.',
			)
		},
		onSettled: (_data, _error, _input, submitted) =>
			submitted
				? settleAccountMutation(
						queryClient,
						submitted.actorKey,
						profileResources,
						{ shell: true },
					)
				: undefined,
	})

	function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (queryClient.isMutating({ mutationKey: ['profile', actorKey] })) return
		const submitted = readProfileFormValues(event.currentTarget, {
			displayName: draftDisplayName,
			bio: draftBio,
			profileVisibility: draftProfileVisibility,
		})
		setDraftDisplayName(submitted.displayName)
		setDraftBio(submitted.bio)
		setDraftProfileVisibility(submitted.profileVisibility)
		const profileFieldsChanged =
			submitted.displayName !== savedDisplayName ||
			submitted.bio !== savedBio ||
			submitted.profileVisibility !== savedProfileVisibility
		setMessage(null)
		setMessageTone('info')
		const isCurrent = captureProfileSubmitter()
		profileMutation.mutate(
			{ data: submitted },
			{
				onSuccess: (payload) => {
					if (!isCurrent()) return
					const result = interpretAccountProfileSave({
						profileFieldsChanged,
						responseOk: true,
						payload,
					})
					if (result.status === 'saved') {
						setDraftDisplayName((edit) =>
							edit === submitted.displayName ? undefined : edit,
						)
						setDraftBio((edit) => (edit === submitted.bio ? undefined : edit))
						setDraftProfileVisibility((edit) =>
							edit === submitted.profileVisibility ? undefined : edit,
						)
						setMessage(result.message)
					} else if (result.status === 'error') {
						setMessage(result.message)
						setMessageTone('error')
					}
				},
				onError: (error) => {
					if (!isCurrent()) return
					setMessage(
						error instanceof Error ? error.message : 'Unable to save profile.',
					)
					setMessageTone('error')
				},
			},
		)
	}

	const emailClaims = accountEmailClaims.snapshot
	const isSendingEmailChange = emailClaims.emailChangeStatus === 'sending'
	const normalizedDraftEmail = emailClaims.draftEmail.trim().toLowerCase()
	const profileUnchanged =
		draftDisplayName === savedDisplayName &&
		draftBio === savedBio &&
		draftProfileVisibility === savedProfileVisibility

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				title={
					view === 'profile'
						? 'Account settings'
						: view === 'security'
							? 'Security'
							: 'Data & deletion'
				}
				description={
					view === 'profile'
						? 'Sign-in email and the display name, bio, and visibility for your public profile.'
						: view === 'security'
							? 'Your password, second sign-in step, the accounts you can sign in with, and emails you used before.'
							: 'Take a copy of your account data, or delete the account.'
				}
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}

			{view === 'profile' ? (
				<>
					{!emailVerified
						? renderEmailVerificationPrompt({
								description:
									'Check your inbox for the verification link. MCP access and email features stay locked until this account email is verified.',
								delivery: emailVerificationDelivery,
								resendStatus: resendMutation.isPending ? 'sending' : 'idle',
								resendMessage,
								resendTone,
								onResend: () => {
									void handleResendVerification()
								},
								secondaryHref: '/pending-verification',
								secondaryLabel: 'Verification page',
							})
						: null}
					{emailVerified &&
					(needsOnboarding ||
						shouldShowOnboardingChecklist(onboardingChecklist))
						? renderOnboardingBanner({ checklist: onboardingChecklist })
						: null}
					<AccountProfilePanel
						{...{
							email,
							emailVerified,
							username,
							draftDisplayName,
							draftBio,
							draftProfileVisibility,
							draftEmail: emailClaims.draftEmail,
							emailChangePassword: emailClaims.emailChangePassword,
							avatarUrl,
							avatarStatus,
							isSaving,
							isSendingEmailChange,
							profileUnchanged,
							normalizedDraftEmail,
							emailChangeMessage: emailClaims.emailChangeMessage,
							emailChangeTone: emailClaims.emailChangeTone,
							emailChangeOpen: emailClaims.emailChangeOpen,
							onProfileSubmit: handleProfileSubmit,
							onEmailChangeSubmit: (event) => {
								void accountEmailClaims.handleEmailChangeSubmit(event, email)
							},
							onAvatarSelected: handleAvatarSelected,
							onRemoveAvatar: () => void handleRemoveAvatar(),
							onDraftDisplayNameChange: (value) => {
								setDraftDisplayName(value)
							},
							onDraftBioChange: (value) => {
								setDraftBio(value)
							},
							onDraftProfileVisibilityChange: (value) => {
								setDraftProfileVisibility(value)
							},
							onDraftEmailInput: accountEmailClaims.updateDraftEmail,
							onEmailChangeToggle: accountEmailClaims.handleEmailChangeToggle,
							onEmailChangePasswordInput:
								accountEmailClaims.updateEmailChangePassword,
						}}
					/>
					<AccountConvertPersonalOrgPanel key={actorKey} username={username} />
				</>
			) : null}
			{view === 'security' ? (
				<>
					<AccountPasswordPanel
						hasUsablePassword={accountConnections.hasUsablePassword}
						onPasswordSet={() => {
							accountConnections.markHasUsablePassword()
						}}
					/>
					{accountConnections.render()}
					{emailVerified
						? AccountFormerEmailsPanel({
								formerEmails: emailClaims.formerEmails,
								releaseEmail: emailClaims.releaseEmail,
								releasePassword: emailClaims.releasePassword,
								releaseStatus: emailClaims.releaseStatus,
								releaseMessage: emailClaims.releaseMessage,
								releaseTone: emailClaims.releaseTone,
								onReleaseEmailInput: accountEmailClaims.updateReleaseEmail,
								onReleasePasswordInput:
									accountEmailClaims.updateReleasePassword,
								onReleaseSubmit:
									accountEmailClaims.handleFormerEmailReleaseSubmit,
								onUseAgainAsLogin: accountEmailClaims.useFormerEmailAsLogin,
								onReleaseListed: (listedEmail) => {
									void accountEmailClaims.requestFormerEmailRelease(listedEmail)
								},
							})
						: null}
				</>
			) : null}
			{view === 'data' ? (
				<>
					<AccountManagementPanel
						title="Your data"
						description="Download a portable JSON export of your Kody account data for backup or migration. Secret values are never included; secret entries export metadata such as names, hosts, and allowlists only."
					>
						<div>
							<SiteLink
								href="/account/export.json"
								download="kody-account-export.json"
								css={compactGhostButtonCss}
							>
								Download account export
							</SiteLink>
						</div>
					</AccountManagementPanel>
					<AccountManagementPanel
						title="Delete account"
						description="Permanently delete this Kody account and every isolated store attached to it. This cannot be undone."
					>
						<AccountDeletePanel
							hasUsablePassword={accountConnections.hasUsablePassword}
						/>
					</AccountManagementPanel>
				</>
			) : null}

			{editorFile ? (
				<AccountAvatarEditor
					file={editorFile}
					onCancel={closeAvatarEditor}
					onBusyChange={setAvatarEditorBusy}
					onApply={(prepared) => {
						void uploadPreparedAvatar(prepared)
					}}
				/>
			) : null}
			{avatarDropActive ? (
				<div
					role="status"
					data-testid="account-avatar-drop-overlay"
					css={{
						position: 'fixed',
						inset: 0,
						zIndex: 2000,
						display: 'grid',
						placeItems: 'center',
						backgroundColor:
							'color-mix(in srgb, var(--color-background) 72%, transparent)',
						pointerEvents: 'none',
					}}
				>
					<p
						css={{
							margin: 0,
							padding: `${spacing.md} ${spacing.lg}`,
							border: `2px dashed ${colors.primary}`,
							borderRadius: radius.lg,
							backgroundColor: colors.surface,
							color: colors.text,
							fontWeight: typography.fontWeight.semibold,
						}}
					>
						Drop to set your avatar
					</p>
				</div>
			) : null}
			<p css={{ margin: 0 }}>
				<SiteLink href="/privacy" css={mutedLinkCss}>
					Privacy
				</SiteLink>
				{' · '}
				<SiteLink href="/terms" css={mutedLinkCss}>
					Terms
				</SiteLink>
			</p>
		</AccountManagementShell>
	)
}

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

const mutationResources = [
	'loadAccountPage',
	'loadProfile',
	'loadCommunity',
	'loadPackage',
] as const
