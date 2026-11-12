/** @jsxImportSource @emotion/react */
import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { saveFile } from '#start/server/files'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { detectFileMediaType } from '#universal/file-viewers.ts'
import { fileByteLimit, fileMediaTypeSchema } from '#universal/files.ts'
import { colors } from '#universal/styles/tokens.ts'
import { uploadFetch } from './upload-fetch.ts'
import { LoadingIndicator } from './loading-indicator.tsx'

type Status =
	| 'queued'
	| 'preparing'
	| 'uploading'
	| 'saving'
	| 'complete'
	| 'failed'
	| 'canceled'
export type UploadJob = {
	id: string
	writeId: string
	org: string
	parentId?: string
	destination: string
	embed: boolean
	file?: File
	name: string
	size: number
	status: Status
	progress: number
	error?: string
}
type Destination = {
	org: string
	parentId?: string
	destination: string
	embed?: boolean
}
const Context = createContext<{
	jobs: UploadJob[]
	enqueue: (files: File[], destination: Destination) => void
	consumeEmbeds: (ids: string[]) => void
} | null>(null)
export function useWorkspaceUploads() {
	const value = useContext(Context)
	if (!value) throw new Error('Upload provider missing')
	return value
}
const activeStatus = (status: Status) =>
	['queued', 'preparing', 'uploading', 'saving'].includes(status)
const action = {
	border: 0,
	background: 'transparent',
	color: colors.text,
	cursor: 'pointer',
	padding: '4px 7px',
	borderRadius: 4,
	'&:hover': { background: colors.borderSubtle },
}
export function WorkspaceUploads({ children }: { children: ReactNode }) {
	const [jobs, setJobs] = useState<UploadJob[]>([]),
		[open, setOpen] = useState(true)
	const active = useRef(new Map<string, AbortController>())
	const router = useRouter(),
		query = useQueryClient()
	const patch = (id: string, changes: Partial<UploadJob>) =>
		setJobs((items) =>
			items.map((job) => (job.id === id ? { ...job, ...changes } : job)),
		)
	useEffect(() => {
		for (const job of jobs) {
			if (active.current.size >= 2) break
			if (job.status !== 'queued' || active.current.has(job.id)) continue
			const controller = new AbortController()
			active.current.set(job.id, controller)
			patch(job.id, { status: 'preparing', error: undefined })
			void (async () => {
				try {
					if (!job.file) throw new Error('Choose this file again.')
					if (job.size > fileByteLimit)
						throw new Error('File exceeds the 16 MiB limit.')
					const bytes = new Uint8Array(await job.file.arrayBuffer())
					controller.signal.throwIfAborted()
					const mime = fileMediaTypeSchema.safeParse(job.file.type)
					const type = detectFileMediaType(
						job.name,
						mime.success ? mime.data : 'application/octet-stream',
					)
					let content: string | undefined
					if (
						type.startsWith('text/') ||
						/\.(json|ya?ml|xml|[cm]?[jt]sx?|css)$/i.test(job.name)
					) {
						try {
							content = new TextDecoder('utf-8', {
								fatal: true,
								ignoreBOM: true,
							}).decode(bytes)
						} catch {
							/* Preserve original bytes. */
						}
					}
					patch(job.id, { status: 'uploading', progress: 0 })
					const result = await saveFile({
						data: {
							orgSlug: job.org,
							input: {
								file_id: job.id,
								write_id: job.writeId,
								name: job.name,
								parent_id: job.parentId,
								media_type: type,
								encoding: content === undefined ? 'base64' : 'utf8',
								content: content ?? bytesToBase64(bytes),
							},
						},
						signal: controller.signal,
						fetch: uploadFetch(
							(fraction) =>
								!controller.signal.aborted &&
								patch(job.id, {
									progress: fraction,
									status: fraction >= 1 ? 'saving' : 'uploading',
								}),
						),
					})
					if (!result.ok)
						throw new Error(
							'message' in result ? result.message : 'Could not upload file.',
						)
					patch(job.id, { status: 'complete', progress: 1, file: undefined })
					void query.invalidateQueries({
						predicate: (q) =>
							q.queryKey[0] === 'page' && q.queryKey[2] === 'loadFilesPage',
					})
					void router.invalidate().catch(() => {})
				} catch (error) {
					patch(job.id, {
						status: controller.signal.aborted ? 'canceled' : 'failed',
						error:
							error instanceof Error ? error.message : 'Could not upload file.',
					})
				} finally {
					active.current.delete(job.id)
					setJobs((items) => [...items])
				}
			})()
		}
	}, [jobs, query, router])
	useEffect(
		() => () => {
			for (const controller of active.current.values()) controller.abort()
		},
		[],
	)
	const running = jobs.filter((job) => activeStatus(job.status)).length
	const failed = jobs.filter((job) => job.status === 'failed').length
	const complete = jobs.filter((job) => job.status === 'complete').length
	const canClear = jobs.some(
		(job) =>
			job.status === 'canceled' || (job.status === 'complete' && !job.embed),
	)
	const title = running
		? `${running} uploading`
		: failed
			? `${failed} upload${failed === 1 ? '' : 's'} failed`
			: complete
				? 'Uploads complete'
				: 'Uploads canceled'
	useEffect(() => {
		if (!running) return
		const warn = (event: BeforeUnloadEvent) => event.preventDefault()
		window.addEventListener('beforeunload', warn)
		return () => window.removeEventListener('beforeunload', warn)
	}, [running])
	const cancel = (id: string) => {
		active.current.get(id)?.abort()
		patch(id, { status: 'canceled' })
	}
	return (
		<Context
			value={{
				jobs,
				enqueue: (files, destination) => {
					setOpen(true)
					setJobs((items) => [
						...items,
						...files.map((file) => ({
							id: crypto.randomUUID(),
							writeId: crypto.randomUUID(),
							org: destination.org,
							parentId: destination.parentId,
							destination: destination.destination,
							embed: !!destination.embed,
							file,
							name: file.name,
							size: file.size,
							status: 'queued' as const,
							progress: 0,
						})),
					])
				},
				consumeEmbeds: (ids) =>
					setJobs((items) =>
						items.map((job) =>
							ids.includes(job.id) ? { ...job, embed: false } : job,
						),
					),
			}}
		>
			{children}
			{!!jobs.length && (
				<section
					aria-label="Uploads"
					css={{
						position: 'fixed',
						right: 16,
						bottom: 'max(16px, env(safe-area-inset-bottom))',
						width: 'min(360px, calc(100vw - 32px))',
						zIndex: 80,
						background: colors.surface,
						border: `1px solid ${colors.border}`,
						borderRadius: 10,
						boxShadow: '0 4px 24px #00000012',
						overflow: 'hidden',
						fontSize: 12,
						color: colors.text,
					}}
				>
					<div
						css={{
							display: 'flex',
							alignItems: 'center',
							gap: 6,
							padding: '9px 10px',
						}}
					>
						<button
							type="button"
							css={{
								...action,
								flex: 1,
								minHeight: 30,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: 8,
								fontWeight: 600,
							}}
							aria-label={open ? 'Minimize uploads' : 'Show uploads'}
							aria-expanded={open}
							onClick={() => setOpen(!open)}
						>
							<span role="status">{title}</span>
							<svg
								aria-hidden="true"
								width="14"
								height="14"
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d={open ? 'm4 6 4 4 4-4' : 'm4 10 4-4 4 4'} />
							</svg>
						</button>
						{!running && canClear && (
							<button
								type="button"
								css={action}
								onClick={() =>
									setJobs((items) =>
										items.filter(
											(job) =>
												job.status !== 'canceled' &&
												(job.status !== 'complete' || job.embed),
										),
									)
								}
							>
								Clear
							</button>
						)}
					</div>
					{open && (
						<div
							css={{
								maxHeight: 'min(320px, 50dvh)',
								overflow: 'auto',
								borderTop: `1px solid ${colors.borderSubtle}`,
							}}
						>
							{jobs.map((job) => (
								<div
									key={job.id}
									css={{
										padding: '10px 12px',
										'& + &': { borderTop: `1px solid ${colors.borderSubtle}` },
									}}
								>
									<div css={{ display: 'flex', gap: 8, alignItems: 'center' }}>
										<div css={{ minWidth: 0, flex: 1 }}>
											<div
												css={{
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap',
													fontWeight: 550,
												}}
												title={job.name}
											>
												{job.name}
											</div>
											<div css={{ fontSize: 11, color: colors.textMuted }}>
												{job.destination} ·{' '}
												{job.status === 'uploading'
													? `${Math.round(job.progress * 100)}%`
													: job.status === 'failed'
														? 'Failed'
														: job.status === 'complete'
															? 'Uploaded'
															: job.status === 'preparing'
																? 'Preparing'
																: job.status === 'saving'
																	? 'Saving'
																	: job.status === 'canceled'
																		? 'Canceled'
																		: 'Queued'}
											</div>
										</div>
										{['preparing', 'saving'].includes(job.status) && (
											<LoadingIndicator
												inline
												label={
													job.status === 'saving'
														? 'Saving upload'
														: 'Preparing upload'
												}
											/>
										)}
										{activeStatus(job.status) && (
											<button
												css={action}
												aria-label={`Cancel ${job.name}`}
												onClick={() => cancel(job.id)}
											>
												×
											</button>
										)}
										{job.status === 'failed' &&
											job.file &&
											job.size <= fileByteLimit && (
												<button
													css={action}
													onClick={() =>
														patch(job.id, {
															status: 'queued',
															progress: 0,
															error: undefined,
														})
													}
												>
													Retry
												</button>
											)}
										{job.status === 'complete' && (
											<a
												css={{ ...action, textDecoration: 'none' }}
												href={`/@${job.org}/-/files?file=${job.id}`}
												onClick={(event) => {
													if (
														event.button === 0 &&
														!event.metaKey &&
														!event.ctrlKey &&
														!event.shiftKey &&
														!event.altKey
													) {
														event.preventDefault()
														void router.navigate({
															href: `/@${job.org}/-/files?file=${job.id}`,
														})
													}
												}}
											>
												Open
											</a>
										)}
									</div>
									{job.status === 'failed' && job.error && (
										<p
											css={{
												margin: '5px 0 0',
												color: colors.danger,
												overflowWrap: 'anywhere',
											}}
										>
											{job.error}
										</p>
									)}
									{job.status === 'uploading' && (
										<progress
											aria-label={`Uploading ${job.name}`}
											value={job.progress}
											max={1}
											css={{
												width: '100%',
												height: 4,
												marginTop: 6,
												accentColor: colors.primary,
											}}
										/>
									)}
								</div>
							))}
						</div>
					)}
				</section>
			)}
		</Context>
	)
}
