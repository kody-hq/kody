import { useEffect, useState } from 'react'
import { useRouteContext } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { type PackageRepoForkAction } from '#universal/package-repo-actions.ts'
import { installCommunityPackage } from '#start/server/community-mutations'
import {
	type CommunityInstallApiPayload,
	type CommunityInstallOutcome,
} from './community-types.ts'
import { usePageInvalidation } from './page-invalidation.ts'
import { useSubmitterScope } from './use-submitter-scope.ts'

const resources = [
	'loadPackage',
	'loadPackageFiles',
	'loadCommunity',
	'loadProfile',
	'loadOnboarding',
	'loadAccountPage',
	'loadUsagePage',
] as const

export function usePackageInstall(fork: PackageRepoForkAction | null) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const reconcile = usePageInvalidation(resources)
	const [confirmed, setConfirmed] = useState(false)
	const [installMessage, setMessage] = useState<string | null>(null)
	const [installOutcome, setOutcome] = useState<CommunityInstallOutcome | null>(
		null,
	)
	useEffect(() => {
		setConfirmed(false)
		setMessage(null)
		setOutcome(null)
	}, [fork?.listingId, actorKey])
	useEffect(() => {
		if (!confirmed) return
		const disarm = (event: MouseEvent) => {
			if (
				event.target instanceof Element &&
				!event.target.closest('[data-community-install]')
			)
				setConfirmed(false)
		}
		document.addEventListener('click', disarm)
		return () => document.removeEventListener('click', disarm)
	}, [confirmed])
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: async (listingId: string) => {
			const result = (await installCommunityPackage({
				data: { listingId, acknowledged: true },
			})) as CommunityInstallApiPayload
			if (
				!result.ok ||
				!result.status ||
				!result.targetName ||
				!result.agentPrompt
			)
				throw new Error(
					result.error ?? 'Unable to install this public package.',
				)
			return {
				status: result.status,
				targetName: result.targetName,
				agentPrompt: result.agentPrompt,
				packageId: result.packageId ?? null,
				failedChecks: result.failedChecks ?? [],
			}
		},
		onMutate: () => ({ reconcile }),
		onSettled: (_data, _error, _variables, context) => context?.reconcile(),
	})
	async function install() {
		if (!fork || !fork.loggedIn || mutation.isPending || installOutcome) return
		if (!confirmed) {
			setConfirmed(true)
			return
		}
		const isCurrent = capture()
		setConfirmed(false)
		setMessage(null)
		try {
			const outcome = await mutation.mutateAsync(fork.listingId)
			if (isCurrent()) setOutcome(outcome)
		} catch (error) {
			if (isCurrent())
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to install this public package.',
				)
		}
	}
	return {
		installMessage,
		installOutcome,
		context: {
			busy: mutation.isPending,
			confirmed,
			onInstall: () => void install(),
			onDisarm: () => setConfirmed(false),
		},
	}
}
