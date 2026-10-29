/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useServerFn } from '@tanstack/react-start'
import { useRouter, useRouteContext } from '@tanstack/react-router'
import { createPageQuery } from '../page-query.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	loadSkillHistory,
	restoreSkillVersion,
} from '#start/server/skill-history'
import { colors } from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'
import { SkillReadAcknowledgement } from '../components/skill-read-acknowledgement.tsx'

type History = Awaited<ReturnType<typeof loadSkillHistory>>

const historyQuery = createPageQuery('loadSkillHistory', loadSkillHistory, {
	staleTime: 0,
	gcTime: 0,
	freshAuthorization: true,
})

export function SkillHistory(props: {
	orgSlug: string
	skill: string
	onRestored: () => void
}) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	return (
		<SkillHistoryView
			key={`${actorKey}:${props.orgSlug}:${props.skill}`}
			{...props}
		/>
	)
}

function SkillHistoryView({
	orgSlug,
	skill,
	onRestored,
}: {
	orgSlug: string
	skill: string
	onRestored: () => void
}) {
	const router = useRouter()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const restoreVersion = useServerFn(restoreSkillVersion)
	const [selection, setSelection] = useState<{
		commit?: string
		compare?: string
		path?: string
	}>({})
	const [mutationError, setError] = useState('')
	const [showChanges, setShowChanges] = useState(false)
	const [confirm, setConfirm] = useState(false)
	const [restoring, setRestoring] = useState(false)
	const [notice, setNotice] = useState<{
		message: string
		approvalUrl: string | null
	} | null>(null)
	const read = useQuery({
		...historyQuery(actorKey, { orgSlug, skill, ...selection }),
		placeholderData: keepPreviousData,
		retry: false,
	})
	const loading = read.isFetching || read.isPlaceholderData
	const result = read.isError ? undefined : read.data
	const error =
		mutationError ||
		(read.error
			? 'Unable to load this skill version. You may no longer have access.'
			: '')
	function select(next: typeof selection) {
		setSelection(next)
		setConfirm(false)
		setNotice(null)
		setError('')
	}
	const versionLabel = (version: History['versions'][number]) =>
		`${version.commit.slice(0, 8)}${version.commit === result?.currentCommit ? ' (current)' : ''}${version.createdAt ? ` · ${new Date(version.createdAt).toLocaleString()}` : ''}${version.publishedBy ? ` · @${version.publishedBy}` : ''}`
	const controlStyle = {
		padding: '0.4rem 0.55rem',
		border: `1px solid ${colors.border}`,
		borderRadius: '0.35rem',
		color: colors.text,
		background: colors.surface,
		maxWidth: '100%' as const,
	}
	async function restore() {
		if (!result || loading) return
		const isCurrent = capture()
		setRestoring(true)
		setError('')
		try {
			const restored = await restoreVersion({
				data: {
					orgSlug,
					skill,
					commit: result.commit,
					expectedCommit: result.currentCommit,
				},
			})
			if (!isCurrent()) return
			setNotice(restored)
			if (restored.ok) {
				await router.invalidate({ sync: true })
				onRestored()
			}
		} catch (error) {
			if (!isCurrent()) return
			setError(
				error instanceof Error ? error.message : 'Unable to restore skill.',
			)
		} finally {
			if (isCurrent()) {
				setRestoring(false)
				setConfirm(false)
			}
		}
	}
	return (
		<section
			aria-label="Skill history"
			aria-busy={loading || restoring}
			css={{
				display: 'flex',
				flexDirection: 'column',
				minHeight: 0,
				flex: 1,
				gap: '0.75rem',
			}}
		>
			{error ? (
				<p role="alert">
					{error}{' '}
					{read.isError ? (
						<button type="button" onClick={() => void read.refetch()}>
							Retry
						</button>
					) : null}
				</p>
			) : null}
			{loading && !result ? <p role="status">Loading history…</p> : null}
			{notice ? (
				<p role="status">
					{notice.message}{' '}
					{notice.approvalUrl ? (
						<SiteLink href={notice.approvalUrl}>Review publish</SiteLink>
					) : null}
				</p>
			) : null}
			{result ? (
				<>
					<SkillReadAcknowledgement
						orgSlug={orgSlug}
						identity={`${skill}:${result.commit}:${result.path}`}
						receipt={result.content?.receipt ?? null}
					/>
					{showChanges && result.compare ? (
						<SkillReadAcknowledgement
							orgSlug={orgSlug}
							identity={`${skill}:${result.compare}:${result.path}`}
							receipt={result.previous?.receipt ?? null}
						/>
					) : null}

					<div
						css={{
							display: 'flex',
							flexWrap: 'wrap',
							alignItems: 'center',
							gap: '0.75rem',
						}}
					>
						<label>
							Version{' '}
							<select
								aria-label="Skill version"
								disabled={loading || restoring}
								value={result.commit}
								onChange={(event) => select({ commit: event.target.value })}
								css={controlStyle}
							>
								{result.versions.map((version) => (
									<option key={version.commit} value={version.commit}>
										{versionLabel(version)}
									</option>
								))}
							</select>
						</label>
						<label>
							<input
								type="checkbox"
								checked={showChanges}
								onChange={(event) => setShowChanges(event.target.checked)}
							/>{' '}
							Show changes
						</label>
						{showChanges ? (
							<label>
								Compare with{' '}
								<select
									aria-label="Compare skill version"
									disabled={loading || restoring}
									value={result.compare ?? ''}
									onChange={(event) =>
										select({
											...selection,
											commit: result.commit,
											compare: event.target.value,
											path: undefined,
										})
									}
									css={controlStyle}
								>
									<option value="" disabled>
										No earlier version
									</option>
									{result.versions
										.filter((version) => version.commit !== result.commit)
										.map((version) => (
											<option key={version.commit} value={version.commit}>
												{versionLabel(version)}
											</option>
										))}
								</select>
							</label>
						) : null}
						{result.canRestore && result.commit !== result.currentCommit ? (
							<button
								type="button"
								disabled={loading || restoring}
								css={controlStyle}
								onClick={() => setConfirm(true)}
							>
								Restore this version
							</button>
						) : null}
					</div>
					{confirm ? (
						<div role="group" aria-label="Confirm skill restore">
							<p>
								Restore this skill and its supporting files from{' '}
								{result.commit.slice(0, 8)}? This publishes a new revision and
								leaves other skills unchanged.
							</p>
							<button
								type="button"
								disabled={loading || restoring}
								onClick={() => void restore()}
								css={controlStyle}
							>
								{restoring ? 'Restoring…' : 'Restore and publish'}
							</button>{' '}
							<button
								type="button"
								disabled={restoring}
								onClick={() => setConfirm(false)}
								css={controlStyle}
							>
								Cancel
							</button>
						</div>
					) : null}
					<label>
						File{' '}
						<select
							aria-label="Skill history file"
							disabled={loading || restoring}
							value={result.path}
							onChange={(event) =>
								select({
									commit: result.commit,
									compare: result.compare ?? undefined,
									path: event.target.value,
								})
							}
							css={controlStyle}
						>
							{result.files.map((file) => (
								<option key={file.path} value={file.path}>
									{file.path}
									{showChanges && file.status !== 'unchanged'
										? ` (${file.status})`
										: ''}
								</option>
							))}
						</select>
					</label>
					{!error ? (
						<div
							css={{
								overflow: 'auto',
								minHeight: 0,
								border: `1px solid ${colors.border}`,
								borderRadius: '0.5rem',
								flex: 1,
							}}
						>
							{showChanges ? (
								result.diffUnavailable ? (
									<p css={{ padding: '1rem' }}>
										These files have too many changes to compare here. Turn off
										Show changes to read each version.
									</p>
								) : result.binary ? (
									<p css={{ padding: '1rem' }}>
										Binary file,{' '}
										{
											result.files.find((file) => file.path === result.path)
												?.status
										}
										.
									</p>
								) : (
									<pre
										aria-label="Skill file changes"
										css={{
											margin: 0,
											padding: '1rem',
											whiteSpace: 'pre-wrap',
											overflowWrap: 'anywhere',
											fontSize: '0.8rem',
										}}
									>
										{result.changes.map((change, index) => (
											<span
												key={index}
												css={{
													display: 'block',
													background: change.added
														? '#167a3430'
														: change.removed
															? '#c3282830'
															: 'transparent',
												}}
											>
												{change.value
													.split('\n')
													.map((line, lineIndex, lines) =>
														lineIndex === lines.length - 1 && !line ? null : (
															<span key={lineIndex} css={{ display: 'block' }}>
																{change.added
																	? '+ '
																	: change.removed
																		? '- '
																		: '  '}
																{line}
															</span>
														),
													)}
											</span>
										))}
									</pre>
								)
							) : result.content?.text !== null && result.content ? (
								<pre
									aria-label="Historical skill file"
									css={{
										margin: 0,
										padding: '1rem',
										whiteSpace: 'pre-wrap',
										overflowWrap: 'anywhere',
										fontSize: '0.8rem',
									}}
								>
									{result.content.text}
								</pre>
							) : result.content?.blob ? (
								<p css={{ padding: '1rem' }}>
									<a
										href={`data:${result.content.mimeType};base64,${result.content.blob}`}
										download={result.path.split('/').at(-1)}
									>
										Download {result.path}
									</a>
								</p>
							) : (
								<p css={{ padding: '1rem' }}>
									This file is absent in the selected version.
								</p>
							)}
						</div>
					) : null}
				</>
			) : null}
		</section>
	)
}
