/** @jsxImportSource @emotion/react */
import { useServerFn } from '@tanstack/react-start'
import { deletePasskey, renamePasskey } from '#start/server/security-mutations'
import {
	webauthnRegistrationOptions as webauthnRegistrationOptionsFn,
	webauthnRegistrationVerify,
} from '#start/server/auth-mutations'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	startRegistration,
	WebAuthnAbortService,
} from '@simplewebauthn/browser'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
	formatNullableTimestamp,
	formatTimestamp,
} from '../components/local-timestamp.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { useHydrated } from '../components/use-hydrated.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { passkeyMutationOptions } from '../passkey-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	accountInputCss,
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'

type PasskeyListItem = {
	id: string
	name: string
	deviceType: string
	backedUp: boolean
	createdAt: string
	lastUsedAt: string | null
}

export type AccountPasskeysPayload = {
	ok: true
	passkeys: Array<PasskeyListItem>
}

function describeDeviceType(deviceType: string) {
	return deviceType === 'multiDevice'
		? 'Synced passkey'
		: 'Device-bound passkey'
}

export function AccountPasskeysPage({
	queryKey,
	payload,
	currentHref,
}: {
	queryKey: QueryKey
	payload: AccountPasskeysPayload
	currentHref: string
}) {
	const webauthnRegistrationOptions = useServerFn(webauthnRegistrationOptionsFn)
	const [actionStatus, setActionStatus] = useState<'idle' | 'busy'>('idle')
	const passkeys = payload.passkeys
	const client = useQueryClient()
	const capture = useSubmitterScope()
	const rename = useMutation(
		passkeyMutationOptions(client, queryKey, renamePasskey),
	)
	const remove = useMutation(
		passkeyMutationOptions(client, queryKey, deletePasskey),
	)
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'error' | 'info'>('info')
	const [renamingPasskeyId, setRenamingPasskeyId] = useState<string | null>(
		null,
	)
	const [renameDraft, setRenameDraft] = useState('')
	const invalidatePages = usePageInvalidation(mutationResources, {
		refreshShell: true,
	})
	const registration = useMutation({
		gcTime: 0,
		mutationFn: async ({
			response,
		}: {
			response: Awaited<ReturnType<typeof startRegistration>>
			invalidate: () => Promise<void>
		}) => {
			const accepted = await webauthnRegistrationVerify({ data: { response } })
			if (!accepted.successful || !accepted.ok)
				throw new Error(accepted?.error || 'Unable to register the passkey.')
		},
		// A lost response can follow a committed registration. Reconcile either way.
		onSettled: (_data, _error, submission) => submission.invalidate(),
	})

	const lifetime = useRef<AbortController | null>(null)
	useEffect(() => {
		const controller = new AbortController()
		lifetime.current = controller
		return () => {
			controller.abort()
			WebAuthnAbortService.cancelCeremony()
		}
	}, [])

	async function handleRegisterPasskey() {
		setActionStatus('busy')
		setMessage(null)

		try {
			const optionsPayload = await webauthnRegistrationOptions({
				data: {},
				signal: lifetime.current?.signal,
			})
			if (!optionsPayload) return
			if (
				!optionsPayload.successful ||
				!optionsPayload?.ok ||
				!optionsPayload.options
			) {
				throw new Error(
					optionsPayload?.error || 'Unable to start passkey registration.',
				)
			}

			const registrationResponse = await startRegistration({
				optionsJSON: optionsPayload.options,
			})

			lifetime.current?.signal.throwIfAborted()
			await registration.mutateAsync({
				response: registrationResponse,
				invalidate: invalidatePages,
			})

			setMessage('Passkey registered.')
			setMessageTone('info')
		} catch (error) {
			setMessage(
				error instanceof Error && error.name === 'NotAllowedError'
					? 'Passkey registration was cancelled.'
					: error instanceof Error
						? error.message
						: 'Unable to register the passkey.',
			)
			setMessageTone('error')
		} finally {
			setActionStatus('idle')
		}
	}

	function beginRename(passkey: PasskeyListItem) {
		setRenamingPasskeyId(passkey.id)
		setRenameDraft(passkey.name)
		setMessage(null)
	}

	function cancelRename() {
		setRenamingPasskeyId(null)
		setRenameDraft('')
	}

	async function handleRenamePasskey(passkeyId: string) {
		const isCurrent = capture()
		setMessage(null)

		try {
			await rename.mutateAsync({
				passkeyId,
				name: renameDraft,
			})
			if (!isCurrent()) return
			setRenamingPasskeyId(null)
			setRenameDraft('')
			setMessage('Passkey renamed.')
			setMessageTone('info')
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to rename the passkey.',
			)
			setMessageTone('error')
		}
	}

	async function handleDeletePasskey(passkeyId: string) {
		const isCurrent = capture()
		setMessage(null)

		try {
			await remove.mutateAsync({ passkeyId })
			if (!isCurrent()) return
			if (renamingPasskeyId === passkeyId) {
				setRenamingPasskeyId(null)
				setRenameDraft('')
			}
			setMessage('Passkey deleted.')
			setMessageTone('info')
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to delete the passkey.',
			)
			setMessageTone('error')
		}
	}

	const hydrated = useHydrated()
	const isBusy =
		!hydrated || actionStatus === 'busy' || rename.isPending || remove.isPending

	return (
		<AccountManagementShell
			currentHref={currentHref}
			maxWidth={layoutMaxWidths.content}
			busy={false}
		>
			<AccountPageHeader
				title="Passkeys"
				description="Sign in with your device's screen lock, a hardware key, or a synced passkey instead of your password."
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}

			{
				<>
					<section css={cardCss}>
						<h2 css={cardTitleCss}>Register a passkey</h2>
						<p css={descriptionCss}>
							Your browser will prompt you to create a passkey with your device.
							Passkey sign-in skips the two-factor code because the passkey
							itself already satisfies multi-factor authentication.
						</p>
						<div>
							<button
								type="button"
								disabled={isBusy}
								css={primaryButtonCss}
								onClick={handleRegisterPasskey}
							>
								{isBusy ? 'Working...' : 'Register a passkey'}
							</button>
						</div>
					</section>

					{passkeys.length === 0 ? (
						<section css={cardCss}>
							<h2 css={cardTitleCss}>No passkeys yet</h2>
							<p css={descriptionCss}>
								Registered passkeys appear here. You can sign in with a passkey
								from the login page.
							</p>
						</section>
					) : (
						<section css={cardCss} aria-label="Registered passkeys">
							<h2 css={cardTitleCss}>Registered passkeys</h2>
							<ul
								css={{
									listStyle: 'none',
									padding: 0,
									margin: 0,
									display: 'grid',
									gap: spacing.md,
								}}
							>
								{passkeys.map((passkey) => {
									const isRenaming = renamingPasskeyId === passkey.id
									return (
										<li
											key={passkey.id}
											css={{
												display: 'flex',
												justifyContent: 'space-between',
												alignItems: 'flex-start',
												gap: spacing.md,
												flexWrap: 'wrap',
												paddingBottom: spacing.md,
												borderBottom: `1px solid ${colors.border}`,
											}}
										>
											<div
												css={{
													display: 'grid',
													gap: spacing.xs,
													flex: '1 1 16rem',
													minWidth: 0,
												}}
											>
												{isRenaming ? (
													<label
														css={{
															display: 'grid',
															gap: spacing.xs,
														}}
													>
														<span
															css={{
																fontSize: typography.fontSize.sm,
																color: colors.textMuted,
															}}
														>
															Nickname
														</span>
														<input
															data-field-ring
															type="text"
															value={renameDraft}
															maxLength={80}
															disabled={isBusy}
															aria-label="Passkey nickname"
															css={accountInputCss}
															onInput={(event) => {
																setRenameDraft(
																	(event.currentTarget as HTMLInputElement)
																		.value,
																)
															}}
														/>
													</label>
												) : (
													<span
														css={{
															fontWeight: typography.fontWeight.medium,
															color: colors.text,
														}}
													>
														{passkey.name}
													</span>
												)}
												<span
													css={{
														color: colors.textMuted,
														fontSize: typography.fontSize.sm,
													}}
												>
													{describeDeviceType(passkey.deviceType)}
												</span>
												<span
													css={{
														color: colors.textMuted,
														fontSize: typography.fontSize.sm,
													}}
												>
													Created {formatTimestamp(passkey.createdAt)}
												</span>
												<span
													css={{
														color: colors.textMuted,
														fontSize: typography.fontSize.sm,
													}}
												>
													Last used{' '}
													{formatNullableTimestamp(passkey.lastUsedAt, 'Never')}
												</span>
											</div>
											<div
												css={{
													display: 'flex',
													gap: spacing.sm,
													flexWrap: 'wrap',
												}}
											>
												{isRenaming ? (
													<>
														<button
															type="button"
															disabled={isBusy}
															css={primaryButtonCss}
															onClick={() => handleRenamePasskey(passkey.id)}
														>
															Save
														</button>
														<button
															type="button"
															disabled={isBusy}
															css={secondaryButtonCss}
															onClick={cancelRename}
														>
															Cancel
														</button>
													</>
												) : (
													<button
														type="button"
														disabled={isBusy}
														css={secondaryButtonCss}
														onClick={() => beginRename(passkey)}
													>
														Rename
													</button>
												)}
												<button
													type="button"
													disabled={isBusy}
													css={dangerButtonCss}
													onClick={() => handleDeletePasskey(passkey.id)}
												>
													Delete
												</button>
											</div>
										</li>
									)
								})}
							</ul>
						</section>
					)}
				</>
			}

			<p css={{ margin: 0 }}>
				<SiteLink href="/account" css={primaryLinkCss}>
					Back to account
				</SiteLink>
			</p>
		</AccountManagementShell>
	)
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })

const mutationResources = ['loadAccountSecurity', 'loadAccountPage'] as const
