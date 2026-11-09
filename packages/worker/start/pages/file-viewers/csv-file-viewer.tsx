/** @jsxImportSource @emotion/react */
import { FileAnchorMarker } from '../file-anchor-markers.tsx'
import { parseCsvPreview } from '#universal/csv-preview.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { WorkspaceFileStatus } from '../workspace-file-status.tsx'
const hover = colors.borderSubtle
export function CsvPreview({ content }: { content: string }) {
	const rows = parseCsvPreview(content)
	if (!rows)
		return (
			<pre
				css={{
					margin: 0,
					padding: '12px 16px',
					fontFamily: typography.fontFamilyMono,
					fontSize: typography.fontSize.sm,
					whiteSpace: 'pre-wrap',
					overflowWrap: 'anywhere',
				}}
			>
				{content}
			</pre>
		)
	const [header, ...body] = rows
	if (!header) return <WorkspaceFileStatus message="This CSV is empty." />
	return (
		<div
			css={{
				overflow: 'auto',
				maxHeight: '60vh',
				border: `1px solid ${colors.border}`,
				borderRadius: 6,
			}}
		>
			<table
				aria-label="CSV preview"
				css={{
					width: '100%',
					borderSpacing: 0,
					fontSize: typography.fontSize.xs,
					'& th, & td': {
						textAlign: 'start',
						padding: '5px 9px',
						whiteSpace: 'pre-wrap',
						borderBottom: `1px solid ${colors.borderSubtle}`,
					},
					'& th': { position: 'sticky', top: 0, background: colors.background },
					'& tr:last-child td': { borderBottom: 0 },
					'& tbody tr:hover': { background: hover },
				}}
			>
				<thead>
					<tr>
						{header.map((cell, i) => (
							<th key={i} scope="col" data-csv-row={0} data-csv-column={i}>
								{cell}
								<FileAnchorMarker
									label="Open header comment"
									matches={(anchor) =>
										anchor.kind === 'csv' &&
										anchor.row === 0 &&
										anchor.column === i
									}
								/>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((cells, i) => (
						<tr key={i}>
							{cells.map((cell, j) => (
								<td key={j} data-csv-row={i + 1} data-csv-column={j}>
									{cell}
									<FileAnchorMarker
										label="Open cell comment"
										matches={(anchor) =>
											anchor.kind === 'csv' &&
											anchor.row === i + 1 &&
											anchor.column === j
										}
									/>
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
