/** @jsxImportSource @emotion/react */
import { WorkspaceFileStatus } from '../workspace-file-status.tsx'
import { useRef, useState, type RefObject } from 'react'
import { colors } from '#universal/styles/tokens.ts'
import { videoTime, type FileThread } from '#universal/file-collaboration.ts'
import { CommentIcon } from '../file-comments.tsx'

const button = {
	background: 'transparent',
	border: 0,
	borderRadius: 5,
	padding: '5px 8px',
	color: 'inherit',
	cursor: 'pointer',
	font: 'inherit',
	minHeight: 28,
	whiteSpace: 'nowrap' as const,
	'&:not(:disabled):hover': { background: colors.borderSubtle },
	'&:focus-visible': { outline: `2px solid ${colors.primary}` },
	'&:disabled': { opacity: 0.45, cursor: 'default' },
}

export function VideoCommentPlayer({
	video,
	audio = false,
	src,
	download,
	name,
	threads,
	activeId,
	onSelect,
	onComment,
}: {
	video: RefObject<HTMLMediaElement | null>
	audio?: boolean
	src: string
	download: string
	name: string
	threads: FileThread[]
	activeId: string | null
	onSelect: (thread: FileThread) => void
	onComment?: (timeMs: number) => void
}) {
	const Media = audio ? 'audio' : 'video'
	const player = useRef<HTMLDivElement>(null)
	const [time, setTime] = useState(0)
	const [duration, setDuration] = useState(0)
	const [showMarkers, setShowMarkers] = useState(true)
	const [playing, setPlaying] = useState(false)
	const [muted, setMuted] = useState(false)
	const [error, setError] = useState('')
	const [failed, setFailed] = useState(false)
	function togglePlayback() {
		const element = video.current
		if (!element) return
		if (element.paused) {
			setError('')
			void element.play().catch(() => setError('Could not start playback.'))
		} else element.pause()
	}
	const markers = new Map<number, FileThread[]>()
	for (const thread of threads) {
		if (
			!duration ||
			(thread.anchor.kind !== 'video' && thread.anchor.kind !== 'audio') ||
			thread.anchor.timeMs > duration
		)
			continue
		const timeMs = thread.anchor.timeMs
		const group = markers.get(timeMs) ?? []
		group.push(thread)
		markers.set(timeMs, group)
	}
	if (failed)
		return (
			<WorkspaceFileStatus
				message="Could not play this file."
				action={{ label: 'Download', href: download }}
			/>
		)
	return (
		<div
			ref={player}
			css={{
				'&:fullscreen': {
					display: 'flex',
					flexDirection: 'column',
					'& video': { flex: 1, minHeight: 0, maxHeight: 'none' },
				},
				borderBottom: `1px solid ${colors.border}`,
				overflow: 'hidden',
				background: colors.surface,
			}}
		>
			{/* oxlint-disable-next-line jsx-a11y/media-has-caption -- Uploaded video may not include captions. */}
			<Media
				ref={(element) => {
					video.current = element
				}}
				aria-label={name}
				src={src}
				playsInline={!audio}
				preload="metadata"
				onError={() => setFailed(true)}
				onPlay={() => setPlaying(true)}
				onPause={() => setPlaying(false)}
				onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
				onTimeUpdate={(event) =>
					setTime(Math.round(event.currentTarget.currentTime * 1000))
				}
				onDurationChange={(event) => {
					const seconds = event.currentTarget.duration
					setDuration(Number.isFinite(seconds) ? Math.floor(seconds * 1000) : 0)
				}}
				css={{
					display: audio ? 'none' : 'block',
					width: '100%',
					maxHeight: '65vh',
					aspectRatio: '16 / 9',
					objectFit: 'contain',
					background: '#101114',
				}}
			/>
			<div css={{ padding: '8px 12px 10px' }}>
				<div
					css={{
						position: 'relative',
						display: 'grid',
						marginInline: 7,
						paddingTop: 24,
					}}
				>
					<input
						type="range"
						aria-label={audio ? 'Audio progress' : 'Video progress'}
						aria-valuetext={`${videoTime(time, true)} of ${videoTime(duration, true)}`}
						min={0}
						max={duration || 1}
						step={1}
						value={Math.min(time, duration)}
						disabled={!duration}
						onChange={(event) => {
							const next = event.currentTarget.valueAsNumber
							if (video.current) video.current.currentTime = next / 1000
							setTime(next)
						}}
						onKeyDown={(event) => {
							if (
								!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
									event.key,
								)
							)
								return
							event.preventDefault()
							const forward =
								event.key === 'ArrowRight' || event.key === 'ArrowUp'
							const next = Math.max(
								0,
								Math.min(duration, time + (forward ? 5000 : -5000)),
							)
							if (video.current) video.current.currentTime = next / 1000
							setTime(next)
						}}
						css={{
							width: 'calc(100% + 14px)',
							margin: '0 -7px',
							height: 20,
							accentColor: colors.primary,
							cursor: 'pointer',
						}}
					/>
					{showMarkers &&
						[...markers.entries()]
							.sort(([a], [b]) => a - b)
							.map(([at, group]) => {
								const index = group.findIndex(
									(thread) => thread.id === activeId,
								)
								const thread = group[(index + 1) % group.length]!
								const label = `Jump to ${group.length === 1 ? 'comment' : `${group.length} comments`} at ${videoTime(at, true)}`
								return (
									<button
										key={at}
										type="button"
										aria-label={label}
										aria-pressed={index >= 0}
										title={label}
										onClick={() => {
											if (document.fullscreenElement === player.current)
												void document.exitFullscreen().catch(() => {})
											onSelect(thread)
										}}
										css={{
											...button,
											position: 'absolute',
											top: 0,
											left: `${(at / duration) * 100}%`,
											transform: 'translateX(-50%)',
											width: 22,
											height: 20,
											minHeight: 0,
											padding: 0,
											zIndex: index >= 0 ? 1 : undefined,
											'&:hover, &:focus-visible': { zIndex: 2 },
											display: 'grid',
											placeItems: 'center',
											color: index >= 0 ? colors.primary : colors.textMuted,
										}}
									>
										<CommentIcon />
									</button>
								)
							})}
				</div>
				<div
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: 5,
						flexWrap: 'wrap',
						fontSize: 12,
					}}
				>
					<button
						type="button"
						css={button}
						disabled={!duration}
						onClick={togglePlayback}
						aria-label={playing ? 'Pause' : 'Play'}
						title={playing ? 'Pause' : 'Play'}
					>
						<svg
							aria-hidden="true"
							width="15"
							height="15"
							viewBox="0 0 16 16"
							fill="currentColor"
							css={{ display: 'block' }}
						>
							<path
								d={playing ? 'M4 3h3v10H4zm5 0h3v10H9z' : 'M5 3l8 5-8 5z'}
							/>
						</svg>
					</button>
					<span
						css={{
							color: colors.textMuted,
							fontVariantNumeric: 'tabular-nums',
						}}
					>
						{videoTime(time)} / {videoTime(duration)}
					</span>
					<div css={{ flex: 1 }} />
					<button
						type="button"
						css={button}
						onClick={() => {
							if (video.current) video.current.muted = !video.current.muted
						}}
					>
						{muted ? 'Unmute' : 'Mute'}
					</button>
					{markers.size > 0 && (
						<button
							type="button"
							css={button}
							onClick={() => setShowMarkers((value) => !value)}
						>
							{showMarkers ? 'Hide markers' : 'Show markers'}
						</button>
					)}
					{onComment && (
						<button
							type="button"
							css={{
								...button,
								display: 'inline-flex',
								gap: 6,
								alignItems: 'center',
								color: colors.primary,
								background: colors.primarySoft,
								fontWeight: 600,
							}}
							disabled={!duration}
							onClick={() => {
								const element = video.current
								if (!element) return
								element.pause()
								if (document.fullscreenElement === player.current)
									void document.exitFullscreen().catch(() => {})
								onComment(
									Math.min(duration, Math.round(element.currentTime * 1000)),
								)
							}}
						>
							<CommentIcon /> Comment at {videoTime(time, true)}
						</button>
					)}
					{!audio && (
						<button
							type="button"
							css={button}
							onClick={() => {
								const action = document.fullscreenElement
									? document.exitFullscreen()
									: player.current?.requestFullscreen?.()
								void action?.catch(() =>
									setError('Could not change fullscreen mode.'),
								)
							}}
						>
							Fullscreen
						</button>
					)}
				</div>
				{error && (
					<p
						role="status"
						css={{ color: colors.danger, margin: '6px 8px 0', fontSize: 12 }}
					>
						{error}
					</p>
				)}
			</div>
		</div>
	)
}
