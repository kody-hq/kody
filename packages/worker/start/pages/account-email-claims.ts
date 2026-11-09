import { useActorRef } from '@xstate/react'
import { submissionGateState } from '#client/routes/submission-gate-state.ts'
import { createUiFeedback, type UiFeedback } from '#client/ui-feedback.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useState, useEffect, useRef, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import type { AccountFormerEmail } from '#universal/loader-data.ts'
import {
	requestWebsiteEmailChange,
	requestWebsiteEmailRelease,
} from '#start/server/auth-mutations'
export function useAccountEmailClaims(
	initialEmail: string,
	initialFormerEmails: Array<AccountFormerEmail>,
) {
	const invalidatePages = usePageInvalidation(mutationResources, {
		refreshShell: true,
	})
	const { actorKey, pageLocation } = useMatchedPageScope()
	const href = pageLocation.href
	const scope = useRef<object | null>(null)
	useEffect(() => {
		scope.current = {}
		return () => {
			scope.current = null
		}
	}, [actorKey, href])
	const lifecycle = {
		gcTime: 0,
		onMutate: () => invalidatePages,
		onSettled: (
			_data: unknown,
			_error: Error | null,
			_input: unknown,
			reconcile: (() => Promise<void>) | undefined,
		) => reconcile?.(),
	}
	const releaseMutation = useMutation({
		...lifecycle,
		mutationFn: (data: { email: string; password: string }) =>
			requestWebsiteEmailRelease({ data }),
	})
	const changeMutation = useMutation({
		...lifecycle,
		mutationFn: (data: { email: string; password: string }) =>
			requestWebsiteEmailChange({ data }),
	})
	const runReleaseActor = useActorRef(submissionGateState)
	const runChangeActor = useActorRef(submissionGateState)
	const releaseStatus: 'idle' | 'sending' = releaseMutation.isPending
		? 'sending'
		: 'idle'
	const emailChangeStatus: 'idle' | 'sending' = changeMutation.isPending
		? 'sending'
		: 'idle'

	const [emailChangeOpen, setEmailChangeOpen] = useState(false)
	const formerEmails = initialFormerEmails
	const [releaseEmail, setReleaseEmail] = useState('')
	const [releasePassword, setReleasePassword] = useState('')
	const [releaseFeedback, setReleaseFeedback] = useState<UiFeedback | null>(
		null,
	)
	const releaseMessage = releaseFeedback?.message ?? null
	const releaseTone = releaseFeedback?.tone ?? 'info'

	const [draftEmail, setDraftEmail] = useState(initialEmail)
	const [emailChangePassword, setEmailChangePassword] = useState('')
	const [emailChangeFeedback, setEmailChangeFeedback] =
		useState<UiFeedback | null>(null)
	const emailChangeMessage = emailChangeFeedback?.message ?? null
	const emailChangeTone = emailChangeFeedback?.tone ?? 'info'

	function applyCurrentEmail(email: string) {
		setDraftEmail(email)
	}

	function updateDraftEmail(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setDraftEmail(event.currentTarget.value)
	}

	function handleEmailChangeToggle(event: FormEvent<HTMLDetailsElement>) {
		if (!(event.currentTarget instanceof HTMLDetailsElement)) return
		if (emailChangeOpen === event.currentTarget.open) return
		setEmailChangeOpen(event.currentTarget.open)
	}

	function updateEmailChangePassword(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setEmailChangePassword(event.currentTarget.value)
	}

	function updateReleaseEmail(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setReleaseEmail(event.currentTarget.value)
	}

	function updateReleasePassword(event: FormEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setReleasePassword(event.currentTarget.value)
	}

	function useFormerEmailAsLogin(nextEmail: string) {
		setDraftEmail(nextEmail)
		setEmailChangeOpen(true)
		setEmailChangeFeedback(createUiFeedback(null))
	}

	async function requestFormerEmailRelease(nextEmail: string) {
		if (!releasePassword) {
			setReleaseEmail(nextEmail)
			setReleaseFeedback(
				createUiFeedback(
					'Current password is required to send a release link.',
					'error',
				),
			)
			return
		}
		setReleaseEmail(nextEmail)
		await submitFormerEmailRelease(nextEmail)
	}

	async function handleFormerEmailReleaseSubmit(
		event: FormEvent<HTMLFormElement>,
	) {
		event.preventDefault()
		await submitFormerEmailRelease()
	}

	async function submitFormerEmailRelease(email = releaseEmail) {
		if (!runReleaseActor.getSnapshot().can({ type: 'SUBMIT' })) return
		runReleaseActor.send({ type: 'SUBMIT' })
		try {
			return await (async () => {
				const nextEmail = email.trim().toLowerCase()
				if (!nextEmail || !releasePassword) {
					setReleaseFeedback(
						createUiFeedback(
							'Former email and current password are required.',
							'error',
						),
					)
					return
				}

				setReleaseFeedback(createUiFeedback(null, 'info'))

				const submittedScope = scope.current
				try {
					const payload = await releaseMutation.mutateAsync({
						email: nextEmail,
						password: releasePassword,
					})
					if (!submittedScope || scope.current !== submittedScope) return
					if (!payload.successful || !payload.ok) {
						throw new Error(
							payload?.error || 'Unable to send the release verification.',
						)
					}
					setReleasePassword('')
					setReleaseFeedback(
						createUiFeedback(
							payload.message ??
								'Verification email sent to that former address.',
							'info',
						),
					)
				} catch (error) {
					if (!submittedScope || scope.current !== submittedScope) return
					setReleaseFeedback(
						createUiFeedback(
							error instanceof Error
								? error.message
								: 'Unable to send the release verification.',
							'error',
						),
					)
				}
			})()
		} finally {
			runReleaseActor.send({ type: 'SETTLED' })
		}
	}

	async function handleEmailChangeSubmit(
		event: FormEvent<HTMLFormElement>,
		currentEmail: string,
	) {
		event.preventDefault()
		if (!runChangeActor.getSnapshot().can({ type: 'SUBMIT' })) return
		runChangeActor.send({ type: 'SUBMIT' })
		try {
			return await (async () => {
				const nextEmail = draftEmail.trim().toLowerCase()
				if (!nextEmail || !emailChangePassword) {
					setEmailChangeFeedback(
						createUiFeedback(
							'New email and current password are required.',
							'error',
						),
					)
					return
				}
				if (nextEmail === currentEmail.trim().toLowerCase()) {
					setEmailChangeFeedback(
						createUiFeedback('Enter a different email address.', 'error'),
					)
					return
				}

				setEmailChangeFeedback(createUiFeedback(null, 'info'))

				const submittedScope = scope.current
				try {
					const payload = await changeMutation.mutateAsync({
						email: nextEmail,
						password: emailChangePassword,
					})
					if (!submittedScope || scope.current !== submittedScope) return
					if (!payload.successful || !payload.ok) {
						throw new Error(
							payload?.error || 'Unable to send the email change verification.',
						)
					}
					setEmailChangePassword('')
					setEmailChangeFeedback(
						createUiFeedback(
							payload.message ?? 'Verification email sent to your new address.',
							'info',
						),
					)
				} catch (error) {
					if (!submittedScope || scope.current !== submittedScope) return
					setEmailChangeFeedback(
						createUiFeedback(
							error instanceof Error
								? error.message
								: 'Unable to send the email change verification.',
							'error',
						),
					)
				}
			})()
		} finally {
			runChangeActor.send({ type: 'SETTLED' })
		}
	}

	return {
		applyCurrentEmail,
		updateDraftEmail,
		handleEmailChangeToggle,
		updateEmailChangePassword,
		updateReleaseEmail,
		updateReleasePassword,
		useFormerEmailAsLogin,
		requestFormerEmailRelease,
		handleFormerEmailReleaseSubmit,
		handleEmailChangeSubmit,
		get snapshot() {
			return {
				emailChangeStatus,
				emailChangeOpen,
				formerEmails,
				releaseEmail,
				releasePassword,
				releaseStatus,
				releaseMessage,
				releaseTone,
				draftEmail,
				emailChangePassword,
				emailChangeMessage,
				emailChangeTone,
			}
		},
	}
}

const mutationResources = ['loadAccountPage'] as const
