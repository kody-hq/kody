import { usePageInvalidation } from '../page-invalidation.ts'
import { useState, useEffect, useRef, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { type AccountFormerEmail } from '#universal/loader-data.ts'
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
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: ({
			kind,
			email,
			password,
		}: {
			kind: 'change' | 'release'
			email: string
			password: string
		}) =>
			(kind === 'change'
				? requestWebsiteEmailChange
				: requestWebsiteEmailRelease)({ data: { email, password } }),
		onMutate: () => invalidatePages,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})

	const [emailChangeStatus, setEmailChangeStatus] = useState<
		'idle' | 'sending'
	>('idle')
	const [emailChangeOpen, setEmailChangeOpen] = useState(false)
	const formerEmails = initialFormerEmails
	const [releaseEmail, setReleaseEmail] = useState('')
	const [releasePassword, setReleasePassword] = useState('')
	const [releaseStatus, setReleaseStatus] = useState<'idle' | 'sending'>('idle')
	const [releaseMessage, setReleaseMessage] = useState<string | null>(null)
	const [releaseTone, setReleaseTone] = useState<'error' | 'info'>('info')
	const [draftEmail, setDraftEmail] = useState(initialEmail)
	const [emailChangePassword, setEmailChangePassword] = useState('')
	const [emailChangeMessage, setEmailChangeMessage] = useState<string | null>(
		null,
	)
	const [emailChangeTone, setEmailChangeTone] = useState<'error' | 'info'>(
		'info',
	)

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
		setEmailChangeMessage(null)
	}

	async function requestFormerEmailRelease(nextEmail: string) {
		if (!releasePassword) {
			setReleaseEmail(nextEmail)
			setReleaseMessage('Current password is required to send a release link.')
			setReleaseTone('error')
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
		const nextEmail = email.trim().toLowerCase()
		if (!nextEmail || !releasePassword) {
			setReleaseMessage('Former email and current password are required.')
			setReleaseTone('error')
			return
		}

		setReleaseStatus('sending')
		setReleaseMessage(null)
		setReleaseTone('info')

		const submittedScope = scope.current
		try {
			const payload = await mutation.mutateAsync({
				kind: 'release',
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
			setReleaseMessage(
				payload.message ?? 'Verification email sent to that former address.',
			)
			setReleaseTone('info')
		} catch (error) {
			if (!submittedScope || scope.current !== submittedScope) return
			setReleaseMessage(
				error instanceof Error
					? error.message
					: 'Unable to send the release verification.',
			)
			setReleaseTone('error')
		} finally {
			if (submittedScope && scope.current === submittedScope)
				setReleaseStatus('idle')
		}
	}

	async function handleEmailChangeSubmit(
		event: FormEvent<HTMLFormElement>,
		currentEmail: string,
	) {
		event.preventDefault()
		const nextEmail = draftEmail.trim().toLowerCase()
		if (!nextEmail || !emailChangePassword) {
			setEmailChangeMessage('New email and current password are required.')
			setEmailChangeTone('error')
			return
		}
		if (nextEmail === currentEmail.trim().toLowerCase()) {
			setEmailChangeMessage('Enter a different email address.')
			setEmailChangeTone('error')
			return
		}

		setEmailChangeStatus('sending')
		setEmailChangeMessage(null)
		setEmailChangeTone('info')

		const submittedScope = scope.current
		try {
			const payload = await mutation.mutateAsync({
				kind: 'change',
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
			setEmailChangeMessage(
				payload.message ?? 'Verification email sent to your new address.',
			)
			setEmailChangeTone('info')
		} catch (error) {
			if (!submittedScope || scope.current !== submittedScope) return
			setEmailChangeMessage(
				error instanceof Error
					? error.message
					: 'Unable to send the email change verification.',
			)
			setEmailChangeTone('error')
		} finally {
			if (submittedScope && scope.current === submittedScope)
				setEmailChangeStatus('idle')
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
