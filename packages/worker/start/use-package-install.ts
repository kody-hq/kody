import { useEffect, useRef, useState } from 'react'
import { useRouteContext } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type PackageRepoForkAction } from '#universal/package-repo-actions.ts'
import {
	forkReadablePackage,
	installCommunityPackage,
} from '#start/server/community-mutations'
import { communityForkStateQuery } from './community-fork-state-query.ts'
import {
	type CommunityInstallApiPayload,
	type CommunityInstallOutcome,
} from './community-types.ts'
import { usePageInvalidation } from './page-invalidation.ts'
import { useSubmitterScope } from './use-submitter-scope.ts'
import { useCommunityInstallOrg } from './use-community-install-org.ts'

const resources = [
	'loadPackage',
	'loadPackageFiles',
	'loadCommunity',
	'loadProfile',
	'loadOnboarding',
	'loadAccountPage',
	'loadUsagePage',
] as const

/**
 * Live fork state for the viewer; see `communityForkStateQuery` for when it
 * refetches. Also refetches on a bfcache restore (back/forward without a
 * remount).
 */
function useCommunityForkState(
	fork: PackageRepoForkAction | null,
	org: string | null,
) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const query = useQuery(
		communityForkStateQuery({
			actorKey,
			listingId: fork?.listingId ?? null,
			org,
			enabled: Boolean(fork?.loggedIn && fork.listingId),
		}),
	)
	const { refetch } = query
	useEffect(() => {
		if (!fork?.loggedIn) return
		// Back/forward can restore this page from bfcache without a remount.
		const onPageShow = (event: PageTransitionEvent) => {
			if (event.persisted) void refetch()
		}
		window.addEventListener('pageshow', onPageShow)
		return () => window.removeEventListener('pageshow', onPageShow)
	}, [fork?.loggedIn, refetch])
	return query
}

export function usePackageInstall(fork: PackageRepoForkAction | null) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const reconcile = usePageInvalidation(resources)
	const { org, picker: orgPicker } = useCommunityInstallOrg(
		Boolean(fork?.loggedIn),
	)
	const forkStateQuery = useCommunityForkState(fork, org)
	const liveForkState = forkStateQuery.data ?? null
	const [confirmed, setConfirmed] = useState(false)
	const [installMessage, setMessage] = useState<string | null>(null)
	const [installOutcome, setOutcome] = useState<CommunityInstallOutcome | null>(
		null,
	)
	useEffect(() => {
		setConfirmed(false)
		setMessage(null)
		setOutcome(null)
	}, [fork?.listingId, actorKey, org])
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
		mutationFn: async (input: {
			fork: PackageRepoForkAction
			org: string | null
		}) => {
			const { fork: target, org: targetOrg } = input
			const result = (
				target.source
					? await forkReadablePackage({
							data: { ...target.source, org: targetOrg },
						})
					: await installCommunityPackage({
							data: {
								listingId: target.listingId ?? '',
								org: targetOrg,
								acknowledged: true,
							},
						})
			) as CommunityInstallApiPayload
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
				alreadyInstalled: result.alreadyInstalled === true,
			}
		},
		onMutate: () => ({ reconcile, refetchForkState: forkStateQuery.refetch }),
		onSettled: (_data, _error, _variables, context) => {
			void context?.refetchForkState()
			return context?.reconcile()
		},
	})
	// When the live read finds a fork the page data does not show yet (it
	// finished after this page loaded), refresh the page so the full fork
	// controls (setup prompt, outdated badge) render.
	const reconciledFor = useRef<string | null>(null)
	const liveDone =
		liveForkState &&
		(liveForkState.state === 'installed' ||
			liveForkState.state === 'adaptation_required')
			? liveForkState
			: null
	useEffect(() => {
		if (!liveDone || fork?.viewerInstall) return
		const key = `${org ?? 'personal'}:${fork?.listingId}:${liveDone.targetName}:${liveDone.state}`
		if (reconciledFor.current === key) return
		reconciledFor.current = key
		void reconcile()
	}, [liveDone, fork?.viewerInstall, fork?.listingId, org, reconcile])
	const existingFork =
		fork?.viewerInstall || !liveDone
			? null
			: { targetName: liveDone.targetName, href: liveDone.href }
	const inProgress =
		!fork?.viewerInstall && liveForkState?.state === 'in_progress'
			? { startedAt: liveForkState.startedAt }
			: null
	async function install() {
		if (
			!fork ||
			!fork.loggedIn ||
			mutation.isPending ||
			installOutcome ||
			existingFork ||
			inProgress
		)
			return
		if (!confirmed) {
			setConfirmed(true)
			return
		}
		const isCurrent = capture()
		setConfirmed(false)
		setMessage(null)
		try {
			const outcome = await mutation.mutateAsync({ fork, org })
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
		org,
		installMessage,
		installOutcome,
		context: {
			busy: mutation.isPending,
			confirmed,
			existingFork,
			inProgress,
			onInstall: () => void install(),
			onDisarm: () => setConfirmed(false),
			orgPicker,
		},
	}
}
