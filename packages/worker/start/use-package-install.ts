import { useEffect, useRef, useState } from 'react'
import { useRouteContext } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CommunityForkState } from '#universal/community-public-types.ts'
import type { PackageRepoForkAction } from '#universal/package-repo-actions.ts'
import {
	forkReadablePackage,
	installCommunityPackage,
} from '#start/server/community-mutations'
import { communityForkStateQuery } from './community-fork-state-query.ts'
import {
	CommunityInstallInProgressError,
	communityInstallOutcomeFromLiveFork,
	resolveCommunityInstallResult,
} from './community-install-result.ts'
import type { CommunityInstallOutcome } from './community-types.ts'
import { usePageInvalidation } from './page-invalidation.ts'
import { useSubmitterScope } from './use-submitter-scope.ts'
import { useCommunityInstallOrg } from './use-community-install-org.ts'
import {
	type ForkTargetChoice,
	forkOrgForSlug,
	pressFork,
} from './fork-target.ts'

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
	const {
		org,
		picker: orgPicker,
		loadOwners,
	} = useCommunityInstallOrg(Boolean(fork?.loggedIn))
	const forkStateQuery = useCommunityForkState(fork, org)
	const liveForkState = forkStateQuery.data ?? null
	const [forkTarget, setForkTarget] = useState<ForkTargetChoice | null>(null)
	const pressing = useRef(false)
	// A fork into another org moves `?org=` there; keep its outcome on screen.
	const carryOutcome = useRef<{ org: string | null } | null>(null)
	const [installMessage, setMessage] = useState<string | null>(null)
	const [installOutcome, setOutcome] = useState<CommunityInstallOutcome | null>(
		null,
	)
	useEffect(() => {
		const carried = carryOutcome.current
		carryOutcome.current = null
		if (carried && carried.org === org) return
		setForkTarget(null)
		setMessage(null)
		setOutcome(null)
	}, [fork?.listingId, actorKey, org])
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: async (input: {
			fork: PackageRepoForkAction
			org: string | null
		}) => {
			const { fork: target, org: targetOrg } = input
			const result = target.source
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
			// Start may resolve undefined after a committed fork (lost RPC
			// envelope). Reconcile through live fork state instead of a false
			// failure — see docs/contributing/tanstack-start.md Writes.
			return resolveCommunityInstallResult({
				result,
				loadForkState: async () => {
					const refreshed = await forkStateQuery.refetch()
					return (refreshed.data ?? { state: 'none' }) as CommunityForkState
				},
			})
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
	function canFork() {
		return Boolean(
			fork?.loggedIn &&
			!mutation.isPending &&
			!installOutcome &&
			!existingFork &&
			!inProgress &&
			!forkTarget &&
			!pressing.current,
		)
	}
	async function runFork(targetOrg: string | null, targetSlug?: string) {
		if (!fork) return
		const isCurrent = capture()
		setMessage(null)
		try {
			const outcome = await mutation.mutateAsync({ fork, org: targetOrg })
			if (!isCurrent()) return
			setOutcome(outcome)
			if (targetOrg !== org && targetSlug && orgPicker) {
				carryOutcome.current = { org: targetOrg }
				orgPicker.onSelect(targetSlug)
			}
		} catch (error) {
			if (!isCurrent()) return
			// Reconcile before offering retry: a lost Start envelope after a
			// committed write must become success / in-progress UI, never a
			// second Fork click that could create a duplicate.
			if (error instanceof CommunityInstallInProgressError) {
				setMessage(null)
				return
			}
			const refreshed = await forkStateQuery.refetch()
			const live = refreshed.data
			if (
				live &&
				(live.state === 'installed' || live.state === 'adaptation_required')
			) {
				setMessage(null)
				setOutcome(communityInstallOutcomeFromLiveFork(live))
				return
			}
			if (live?.state === 'in_progress') {
				setMessage(null)
				return
			}
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to install this public package.',
			)
		}
	}
	async function install() {
		if (!canFork()) return
		const isCurrent = capture()
		pressing.current = true
		setMessage(null)
		try {
			await pressFork({
				loadOwners,
				currentOrg: org,
				fork: async (targetOrg) => {
					if (isCurrent()) await runFork(targetOrg)
				},
				choose: (choice) => {
					if (isCurrent()) setForkTarget(choice)
				},
			})
		} catch (error) {
			if (isCurrent())
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to load the orgs you can fork into.',
				)
		} finally {
			pressing.current = false
		}
	}
	function chooseForkTarget(slug: string) {
		const choice = forkTarget
		setForkTarget(null)
		if (!choice || mutation.isPending) return
		void runFork(forkOrgForSlug(choice.owners, slug), slug)
	}
	return {
		org,
		installMessage,
		installOutcome,
		context: {
			busy: mutation.isPending,
			existingFork,
			inProgress,
			choosesForkTarget: orgPicker != null,
			forkTarget,
			onInstall: () => void install(),
			onChooseForkTarget: chooseForkTarget,
			onDismissForkTarget: () => setForkTarget(null),
		},
	}
}
