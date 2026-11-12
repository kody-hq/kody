/** @jsxImportSource @emotion/react */
import { WorkspaceEmptyFolder } from '../workspace-empty-folder.tsx'
import { WorkspaceFileStatus } from '../workspace-file-status.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { renderIcon } from '../../components/icon.tsx'
import { LoadingIndicator } from '../../components/loading-indicator.tsx'
import { useEffect, useState } from 'react'
import { zipDirectory } from '#universal/zip-directory.ts'

const control = {
	...getGhostButtonCss(),
	display: 'inline-flex',
	alignItems: 'center',
	gap: 6,
	minHeight: 28,
	padding: '4px 7px',
	borderRadius: 5,
	fontSize: 12,
	whiteSpace: 'nowrap',
	textDecoration: 'none',
	flexShrink: 0,
} as const

type Entry = ReturnType<typeof zipDirectory>[number]
const size = (bytes: number) =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1024 ** 2
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 ** 2).toFixed(1)} MB`
export default function ZipFileViewer({
	src,
	download,
}: {
	src: string
	download: string
}) {
	const [entries, setEntries] = useState<Entry[] | null>(null)
	const [error, setError] = useState('')
	const [folder, setFolder] = useState('')
	useEffect(() => {
		const controller = new AbortController()
		void fetch(src, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error('Could not load this archive.')
				const files = zipDirectory(await response.arrayBuffer())
				if (!controller.signal.aborted) setEntries(files)
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setError(
						cause instanceof Error
							? cause.message
							: 'Could not read this archive.',
					)
			})
		return () => controller.abort()
	}, [src])
	if (error)
		return (
			<WorkspaceFileStatus
				message={error}
				action={{ label: 'Download ZIP', href: download }}
			/>
		)
	if (!entries) return <LoadingIndicator label="Loading archive…" />
	const rows = new Map<
		string,
		{ name: string; folder: boolean; bytes: number }
	>()
	for (const entry of entries) {
		if (!entry.name.startsWith(folder)) continue
		const tail = entry.name.slice(folder.length)
		if (!tail) continue
		const slash = tail.indexOf('/')
		const directory = slash >= 0
		const name = directory ? tail.slice(0, slash + 1) : tail
		const key = (directory ? 'folder:' : 'file:') + name
		const existing = rows.get(key)
		if (existing) existing.bytes += entry.bytes
		else rows.set(key, { name, folder: directory, bytes: entry.bytes })
	}
	const parts = folder.split('/').filter(Boolean)
	return (
		<section
			aria-label="Archive contents"
			css={{
				flex: 1,
				minHeight: 0,
				overflow: 'auto',
				color: colors.text,
				background: colors.background,
				padding: '0 16px 16px',
			}}
		>
			<nav
				aria-label="Archive folders"
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					position: 'sticky',
					top: 0,
					zIndex: 1,
					minHeight: 44,
					background: colors.background,
					borderBottom: `1px solid ${colors.border}`,
					marginInline: -16,
					paddingInline: 12,
					overflowX: 'auto',
				}}
			>
				<button
					css={control}
					aria-label="Up one level"
					disabled={!folder}
					onClick={() =>
						setFolder(
							parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : ''),
						)
					}
				>
					{renderIcon('chevron-up', { size: '14px' })}
				</button>
				<button
					css={control}
					aria-current={!folder ? 'page' : undefined}
					onClick={() => setFolder('')}
				>
					Archive
				</button>
				{parts.map((part, index) => (
					<span
						key={index}
						css={{
							display: 'inline-flex',
							alignItems: 'center',
							gap: 2,
							flexShrink: 0,
						}}
					>
						<span aria-hidden css={{ color: colors.textMuted }}>
							{renderIcon('chevron-right', { size: '12px' })}
						</span>
						<button
							css={{
								...control,
								display: 'block',
								maxWidth: 180,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
							}}
							title={part}
							aria-current={index === parts.length - 1 ? 'page' : undefined}
							onClick={() =>
								setFolder(parts.slice(0, index + 1).join('/') + '/')
							}
						>
							{part}
						</button>
					</span>
				))}
				<a href={download} css={{ ...control, marginLeft: 'auto' }}>
					Download ZIP
				</a>
			</nav>
			{rows.size ? (
				<table
					css={{
						width: '100%',
						borderCollapse: 'collapse',
						tableLayout: 'fixed',
						fontSize: 13,
						textAlign: 'left',
						'th,td': {
							padding: '0 8px',
							height: 38,
							borderBottom: `1px solid ${colors.borderSubtle}`,
						},
						th: {
							color: colors.textMuted,
							fontSize: 11,
							fontWeight: 500,
							height: 32,
						},
						'tbody tr:hover': { background: colors.primarySoftest },
						'td:last-child': {
							color: colors.textMuted,
							fontVariantNumeric: 'tabular-nums',
							fontSize: 12,
						},
						'th:last-child,td:last-child': {
							textAlign: 'right',
							width: 'clamp(60px, 20%, 110px)',
						},
						button: {
							color: 'inherit',
							cursor: 'pointer',
							background: 'none',
							border: 0,
							padding: 0,
							width: '100%',
							minHeight: 38,
							display: 'flex',
							alignItems: 'center',
							gap: 10,
							textAlign: 'left',
							font: 'inherit',
							'&:focus-visible': {
								outline: `2px solid ${colors.primary}`,
								outlineOffset: -2,
								borderRadius: 4,
							},
						},
					}}
				>
					<thead>
						<tr>
							<th scope="col">Name</th>
							<th scope="col">Size</th>
						</tr>
					</thead>
					<tbody>
						{[...rows.values()]
							.sort(
								(a, b) =>
									Number(b.folder) - Number(a.folder) ||
									a.name.localeCompare(b.name),
							)
							.map((row) => (
								<tr key={(row.folder ? 'folder:' : 'file:') + row.name}>
									<td>
										{row.folder ? (
											<button
												onClick={() => setFolder(folder + row.name)}
												aria-label={`Open folder ${row.name.slice(0, -1)}`}
											>
												<span
													aria-hidden
													css={{ color: colors.textMuted, display: 'flex' }}
												>
													{renderIcon('folder', { size: '16px' })}
												</span>
												<span
													title={row.name.slice(0, -1)}
													css={{
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
													}}
												>
													{row.name.slice(0, -1)}
												</span>
												<span
													aria-hidden
													css={{ marginLeft: 'auto', color: colors.textMuted }}
												>
													{renderIcon('chevron-right', { size: '12px' })}
												</span>
											</button>
										) : (
											<span
												css={{
													display: 'flex',
													alignItems: 'center',
													gap: 10,
													minWidth: 0,
												}}
											>
												<span
													aria-hidden
													css={{
														color: colors.textMuted,
														display: 'flex',
														flexShrink: 0,
													}}
												>
													{renderIcon('file', { size: '16px' })}
												</span>
												<span
													css={{
														overflow: 'hidden',
														textOverflow: 'ellipsis',
														whiteSpace: 'nowrap',
													}}
												>
													{row.name}
												</span>
											</span>
										)}
									</td>
									<td>{size(row.bytes)}</td>
								</tr>
							))}
					</tbody>
				</table>
			) : folder ? (
				<WorkspaceEmptyFolder />
			) : (
				<WorkspaceFileStatus message="This archive is empty." />
			)}
		</section>
	)
}
