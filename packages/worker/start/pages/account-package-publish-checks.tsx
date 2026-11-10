/** @jsxImportSource @emotion/react */
import { restoreActor } from 'xstate/persist'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { useCallback, useEffect, useState } from 'react'
import { useActor } from '@xstate/react'
import type { CSSObject } from '@emotion/react'
import {
	publishCommitCheckState,
	type PublishCheckAttempt,
	type PublishCommitChecksState as CommitChecksState,
} from '#client/routes/publish-commit-check-state.ts'
import type { AccountPackagePublishCheckPayload } from '#universal/loader-data.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
export type PublishCommitChecksState = CommitChecksState

type CheckPublishCommit = (input: {
	data: { packageId: string; commit: string }
}) => Promise<AccountPackagePublishCheckPayload>

/**
 * Run the authoring publish checks for the commit this page would promote.
 * `commit: null` (nothing to publish, or already promoted) skips the run.
 */
export function usePublishCommitChecks(input: {
	packageId: string
	commit: string | null
	check: CheckPublishCommit
}): PublishCommitChecksState {
	const { packageId, commit, check } = input
	const key = commit ? `${packageId}:${commit}` : null
	const [attemptSnapshot, , attemptActor] = useActor(
		useState(() =>
			restoreActor(
				publishCommitCheckState,
				publishCommitCheckState.getPersistedSnapshot(
					(() => {
						const initialView = key
							? { status: 'running', key }
							: { status: 'idle' }
						return publishCommitCheckState.resolveState({
							value: initialView.status,
							context: uiContext(initialView),
						})
					})(),
				),
			),
		)[0],
	)
	const attempt = uiState<PublishCheckAttempt>(attemptSnapshot)
	const transition = useCallback(
		(event: Parameters<typeof attemptActor.send>[0]) =>
			sendUiEvent(attemptActor, event),
		[attemptActor],
	)

	useEffect(() => {
		const requestId = {}

		if (!commit || !key) {
			transition({
				...({
					type: 'CLEAR_COMMIT',
					data: uiContext({ status: 'idle' }).data,
				} as Parameters<typeof attemptActor.send>[0]),
				requestId: requestId,
			})
			return
		}
		transition({
			...({
				type: 'CHECK_COMMIT',
				data: uiContext({ status: 'running', key }).data,
			} as Parameters<typeof attemptActor.send>[0]),
			requestId: requestId,
		})
		let current = true
		const settle = (
			state: Exclude<PublishCommitChecksState, { status: 'idle' }>,
		) => {
			if (current)
				transition({
					...({
						type:
							state.status === 'passed'
								? 'CHECK_PASSED'
								: state.status === 'failed'
									? 'CHECK_FAILED'
									: 'CHECK_UNAVAILABLE',
						data: uiContext({ ...state, key }).data,
					} as Parameters<typeof attemptActor.send>[0]),
					requestId: requestId,
				})
		}
		check({ data: { packageId, commit } })
			.then((result) => {
				if (!result.ok) settle({ status: 'unavailable', error: result.error })
				else if (result.checksOk) settle({ status: 'passed' })
				else settle({ status: 'failed', failedChecks: result.failedChecks })
			})
			.catch((error: unknown) =>
				settle({
					status: 'unavailable',
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		return () => {
			current = false
		}
	}, [packageId, commit, key, check, transition])
	if (!key) return { status: 'idle' }
	if (attempt.status === 'idle' || attempt.key !== key)
		return { status: 'running' }
	if (attempt.status === 'failed')
		return { status: 'failed', failedChecks: attempt.failedChecks }
	if (attempt.status === 'unavailable')
		return { status: 'unavailable', error: attempt.error }
	return { status: attempt.status }
}

export function PublishChecksPanel(props: {
	state: PublishCommitChecksState
	locked: boolean
}) {
	const { state } = props
	const action = props.locked ? 'Promote' : 'Publish'
	switch (state.status) {
		case 'idle':
			return null
		case 'running':
			return (
				<p
					data-testid="approve-publish-checks-running"
					role="status"
					aria-live="polite"
					css={{ margin: 0, color: colors.textMuted }}
				>
					Running publish checks on this commit. {action} turns on when they
					pass.
				</p>
			)
		case 'passed':
			return (
				<p
					data-testid="approve-publish-checks-passed"
					role="status"
					aria-live="polite"
					css={{ margin: 0, color: colors.textMuted }}
				>
					Publish checks passed for this commit.
				</p>
			)
		case 'unavailable':
			return (
				<p
					data-testid="approve-publish-checks-unavailable"
					role="status"
					css={{ ...noticeCss, borderColor: colors.warning }}
				>
					Could not run publish checks here: {state.error} {action} runs them
					again before anything is published.
				</p>
			)
		case 'failed':
			return (
				<section
					data-testid="approve-publish-checks-failed"
					role="alert"
					css={{ ...noticeCss, borderColor: colors.error }}
				>
					<h3 css={failedTitleCss}>Publish checks failed for this commit</h3>
					<p css={{ margin: 0, color: colors.text }}>
						This commit cannot be published, so {action} is off. Fix the
						package, push a new commit, and approve that one.
					</p>
					<ul css={failedListCss}>
						{state.failedChecks.map((check, index) => (
							<li key={`${check.kind}-${index}`}>
								<span css={kindCss}>{check.kind}</span>
								<pre css={messageCss}>{check.message}</pre>
							</li>
						))}
					</ul>
				</section>
			)
		default: {
			const exhaustive: never = state
			throw new Error(`Unknown publish check state: ${String(exhaustive)}`)
		}
	}
}

const noticeCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	margin: 0,
	padding: spacing.sm,
	borderRadius: '0.55rem',
	border: `1px solid ${colors.border}`,
	color: colors.text,
}

const failedTitleCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.error,
}

const failedListCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const kindCss: CSSObject = {
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.04em',
	color: colors.textMuted,
}

const messageCss: CSSObject = {
	margin: 0,
	padding: spacing.sm,
	overflowX: 'auto' as const,
	borderRadius: '0.45rem',
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	font: `400 0.78rem/1.45 ${typography.fontFamilyMono}`,
	whiteSpace: 'pre-wrap' as const,
	color: colors.text,
}
