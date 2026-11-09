import { useEffect, useRef, useState } from 'react'
import { useRouteContext } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CommunityForkState } from '#universal/community-public-types.ts'
import type { PackageRepoForkAction } from '#universal/package-repo-actions.ts'
import {
	forkReadablePackage,
	installCommunityPackage,
	loadCommunityForkState,
} from '#start/server/community-mutations'
import {
	communityForkStateQuery,
	communityForkStateQueryKey,
} from './community-fork-state-query.ts'
import {
	CommunityInstallInProgressError,
	CommunityInstallLostEnvelopeError,
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
	const queryClient = useQueryClient()
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
	// After a lost Start envelope, keep Fork closed until live state or
	// page reconcile proves the install — never invite a duplicate click.
	const [holdForkRetry, setHoldForkRetry] = useState(false)
	useEffect(() => {
		const carried = carryOutcome.current
		carryOutcome.current = null
		if (carried && carried.org === org) return
		setForkTarget(null)
		setMessage(null)
		setOutcome(null)
		setHoldForkRetry(false)
	}, [fork?.listingId, actorKey, org])

	function seedForkState(
		listingId: string,
		targetOrg: string | null,
		state: CommunityForkState,
	) {
		queryClient.setQueryData(
			communityForkStateQueryKey(actorKey, listingId, targetOrg),
			state,
		)
	}

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
			// envelope). Reconcile through live fork state for the *target*
			// org (page ?org= may still be personal) — see
			// docs/contributing/tanstack-start.md Writes. Readable-package
			// forks have no listingId; skip the community fork-state read.
			const listingId = target.listingId?.trim() || null
			return resolveCommunityInstallResult({
				result,
				loadForkState: async () => {
					if (!listingId) return { state: 'none' as const }
					const live = (await loadCommunityForkState({
						data: { listingId, org: targetOrg },
					})) as CommunityForkState
					seedForkState(listingId, targetOrg, live)
					return live
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
	useEffect(() => {
		if (
			liveDone ||
			fork?.viewerInstall ||
			liveForkState?.state === 'in_progress'
		)
			setHoldForkRetry(false)
	}, [liveDone, fork?.viewerInstall, liveForkState?.state])
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
			!holdForkRetry &&
			!forkTarget &&
			!pressing.current,
		)
	}
	async function runFork(targetOrg: string | null, targetSlug?: string) {
		if (!fork) return
		const target = fork
		const listingId = target.listingId?.trim() || null
		const isCurrent = capture()
		setMessage(null)
		function carryToTargetOrg() {
			if (targetOrg !== org && targetSlug && orgPicker) {
				carryOutcome.current = { org: targetOrg }
				orgPicker.onSelect(targetSlug)
			}
		}
		function holdInProgress(
			live: Extract<CommunityForkState, { state: 'in_progress' }>,
		) {
			setMessage(null)
			setHoldForkRetry(true)
			if (listingId) seedForkState(listingId, targetOrg, live)
			carryToTargetOrg()
			void reconcile()
		}
		function releaseWithLostEnvelopeNotice() {
			setHoldForkRetry(false)
			setMessage(
				'The install response was lost. Check whether the fork already exists before trying again.',
			)
		}
		async function applyLiveForkState(
			live: CommunityForkState,
		): Promise<boolean> {
			// Always seed the query cache — even if this submitter is stale —
			// so a committed installed / in_progress row settles and Fork
			// cannot reopen for a duplicate. Imperative UI updates stay gated.
			// Do not clear holdForkRetry on stale: that would reopen Fork before
			// the seeded live state is observed; the live-state effect clears
			// the hold once installed / in_progress lands in the query.
			if (listingId) seedForkState(listingId, targetOrg, live)
			if (!isCurrent()) return true
			if (live.state === 'installed' || live.state === 'adaptation_required') {
				setMessage(null)
				setOutcome(communityInstallOutcomeFromLiveFork(live))
				setHoldForkRetry(false)
				carryToTargetOrg()
				return true
			}
			if (live.state === 'in_progress') {
				holdInProgress(live)
				return true
			}
			return false
		}
		try {
			const outcome = await mutation.mutateAsync({
				fork: target,
				org: targetOrg,
			})
			if (!isCurrent()) return
			setOutcome(outcome)
			setHoldForkRetry(false)
			carryToTargetOrg()
		} catch (error) {
			if (!isCurrent()) return
			// Reconcile before offering retry: a lost Start envelope after a
			// committed write must become success / in-progress UI, never a
			// second Fork click that could create a duplicate.
			if (error instanceof CommunityInstallInProgressError) {
				holdInProgress({
					state: 'in_progress',
					startedAt: new Date().toISOString(),
				})
				return
			}
			if (error instanceof CommunityInstallLostEnvelopeError) {
				// Hold only while we reconcile once more; if still none, release
				// with a notice so Fork is not stuck as a spinner forever.
				setHoldForkRetry(true)
				setMessage(null)
				await reconcile()
				if (!isCurrent()) return
				if (!listingId) {
					releaseWithLostEnvelopeNotice()
					return
				}
				try {
					const live = (await loadCommunityForkState({
						data: { listingId, org: targetOrg },
					})) as CommunityForkState
					if (await applyLiveForkState(live)) return
				} catch {
					// Fall through to the notice.
				}
				if (!isCurrent()) return
				releaseWithLostEnvelopeNotice()
				return
			}
			if (!listingId) {
				// Readable-package forks have no community listing fork-state.
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to install this public package.',
				)
				return
			}
			let live: CommunityForkState
			try {
				live = (await loadCommunityForkState({
					data: { listingId, org: targetOrg },
				})) as CommunityForkState
			} catch {
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to install this public package.',
				)
				return
			}
			if (await applyLiveForkState(live)) return
			if (!isCurrent()) return
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
			busy: mutation.isPending || (holdForkRetry && !installMessage),
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
