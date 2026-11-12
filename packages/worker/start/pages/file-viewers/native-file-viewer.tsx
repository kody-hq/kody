/** @jsxImportSource @emotion/react */
import { WorkspaceFileStatus } from '../workspace-file-status.tsx'
import { useState } from 'react'
export default function NativeFileViewer({
	kind,
	src,
	name,
	download,
	inline = false,
}: {
	kind: 'pdf' | 'video' | 'audio'
	src: string
	name: string
	download: string
	inline?: boolean
}) {
	const [error, setError] = useState(false)
	if (error)
		return (
			<WorkspaceFileStatus
				message="Could not play this file."
				action={{ label: 'Download', href: download }}
			/>
		)
	if (kind === 'pdf')
		return (
			<iframe
				title={name}
				src={src + '#toolbar=1'}
				css={{
					display: 'block',
					width: '100%',
					height: inline ? 420 : '100%',
					minHeight: inline ? 420 : 0,
					flex: 1,
					border: 0,
					background: 'white',
				}}
			/>
		)
	// Uploaded media may have no captions; native controls expose any embedded tracks.
	if (kind === 'video')
		return (
			// oxlint-disable-next-line jsx-a11y/media-has-caption
			<video
				aria-label={name}
				src={src}
				controls
				playsInline
				preload="metadata"
				onError={() => setError(true)}
				css={{
					display: 'block',
					width: '100%',
					height: inline ? 360 : '100%',
					minHeight: 0,
					flex: 1,
					objectFit: 'contain',
					background: '#151515',
				}}
			/>
		)
	return (
		<div
			css={{ display: 'grid', placeItems: 'center', minHeight: 180, flex: 1 }}
		>
			{/* oxlint-disable-next-line jsx-a11y/media-has-caption -- Uploaded media may not contain captions. */}
			<audio
				aria-label={name}
				src={src}
				controls
				preload="metadata"
				onError={() => setError(true)}
				css={{ width: 'min(100%, 600px)' }}
			/>
		</div>
	)
}
