/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useEffect, useState } from 'react'
import { type AccountPackagePublishCheckPayload } from '#universal/loader-data.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export type PublishCommitChecksState =
	| { status: 'idle' }
	| { status: 'running' }
	| { status: 'passed' }
	| {
			status: 'failed'
			failedChecks: Array<{ kind: string; message: string }>
	  }
	| { status: 'unavailable'; error: string }

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
	// Results are keyed by commit so a new commit reads as running without a
	// synchronous reset inside the effect.
	const [settled, setSettled] = useState<{
		key: string
		state: PublishCommitChecksState
	} | null>(null)
	const key = commit ? `${packageId}:${commit}` : null
	useEffect(() => {
		if (!commit || !key) return
		let current = true
		const settle = (state: PublishCommitChecksState) => {
			if (current) setSettled({ key, state })
		}
		check({ data: { packageId, commit } })
			.then((result) => {
				if (!result.ok) {
					settle({ status: 'unavailable', error: result.error })
				} else if (result.checksOk) {
					settle({ status: 'passed' })
				} else {
					settle({ status: 'failed', failedChecks: result.failedChecks })
				}
			})
			.catch((error: unknown) => {
				settle({
					status: 'unavailable',
					error: error instanceof Error ? error.message : String(error),
				})
			})
		return () => {
			current = false
		}
	}, [packageId, commit, key, check])
	if (!key) return { status: 'idle' }
	if (settled?.key !== key) return { status: 'running' }
	return settled.state
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
