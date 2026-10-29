/** @jsxImportSource @emotion/react */
import { useMemo, useState } from 'react'
import { SkillReadAcknowledgement } from '../components/skill-read-acknowledgement.tsx'
import { SkillMetricsPanel } from './skill-metrics.tsx'
import { type loadSkillsPage } from '#start/server/skills'
import { colors } from '#universal/styles/tokens.ts'
import {
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { AccountSectionTabs } from './account-section-tabs.tsx'
import { PackageFilesExplorer } from '../components/package-files-explorer.tsx'
import { renderIcon } from '../components/icon.tsx'
import { SkillHistory } from './skill-history.tsx'

type SkillsData = Awaited<ReturnType<typeof loadSkillsPage>>
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	type RecordTableColumn,
	type RecordTableRow,
} from './record-table.tsx'
const skillColumns: Array<RecordTableColumn> = [
	{ key: 'name', label: 'Skill', primary: true },
	{ key: 'description', label: 'Description', sortable: false },
	{
		key: 'package',
		label: 'Package',
		filter: (_value, filter, row) => row.values?.packageId === filter,
	},
	{
		key: 'reads',
		label: 'Reads · 30d',
		align: 'end',
		searchable: false,
		filter: (value, filter) =>
			filter === 'read' ? Number(value) > 0 : Number(value) === 0,
	},
	{ key: 'recent', label: 'Last read (UTC)', searchable: false },
]
export type SkillsSearch = {
	page: number
	pageSize: number
	desc?: boolean
	sort: 'name' | 'reads' | 'recent' | 'package'
	package: string
	activity: 'all' | 'read' | 'unread'
	q: string
	view: 'all' | 'packages'
	skill?: string
	file?: string
}

export function SkillsPage({
	data,
	search,
	currentHref,
	onSearch,
	onFilter,
}: {
	data: SkillsData
	search: SkillsSearch
	currentHref: string
	onSearch: (query: string) => void
	onFilter: (patch: Partial<SkillsSearch>) => void
}) {
	const [filesOpen, setFilesOpen] = useState(false)
	const [historySkill, setHistorySkill] = useState<string | null>(null)
	const [draft, setDraft] = useState({ source: search.q, value: search.q })
	if (draft.source !== search.q) setDraft({ source: search.q, value: search.q })
	const query = draft.source === search.q ? draft.value : search.q
	const href = (patch: Partial<SkillsSearch>) => {
		const next = { ...search, ...patch }
		const params = new URLSearchParams()
		if (next.page > 1) params.set('page', String(next.page))
		if (next.pageSize !== 25) params.set('pageSize', String(next.pageSize))
		if (next.desc !== undefined) params.set('desc', String(next.desc))
		if (next.q) params.set('q', next.q)
		if (next.sort !== 'name') params.set('sort', next.sort)
		if (next.package) params.set('package', next.package)
		if (next.activity !== 'all') params.set('activity', next.activity)
		if (next.view === 'packages') params.set('view', next.view)
		if (next.skill) params.set('skill', next.skill)
		if (next.file) params.set('file', next.file)
		return (
			new URL(currentHref, 'https://kody.local').pathname +
			(params.size ? `?${params}` : '')
		)
	}
	const rows = useMemo<Array<RecordTableRow>>(() => {
		const activity = new Map(
			data.metrics.skillActivity.map((entry) => [entry.uri, entry]),
		)
		return data.skills.map((skill) => {
			const metrics = activity.get(skill.uri)
			return {
				id: skill.uri,
				values: {
					name: skill.name,
					description: skill.description,
					package: skill.packageName,
					packageId: skill.packageId,
					reads: metrics?.reads ?? 0,
					recent: metrics?.lastRead ?? '',
				},
				cells: {
					name: skill.name,
					description: (
						<span
							title={skill.description}
							css={{
								display: '-webkit-box',
								WebkitLineClamp: 2,
								WebkitBoxOrient: 'vertical',
								overflow: 'hidden',
								maxWidth: '30rem',
								color: colors.textMuted,
							}}
						>
							{skill.description}
						</span>
					),
					package: skill.packageName,
					reads: metrics?.reads ?? 0,
					recent: metrics?.lastRead
						? new Date(metrics.lastRead).toLocaleString('en-US', {
								timeZone: 'UTC',
							})
						: 'No reads',
				},
			}
		})
	}, [data.skills, data.metrics.skillActivity])
	const packages = [
		...new Map(
			data.skills.map((skill) => [skill.packageId, skill.packageName]),
		).entries(),
	].sort((a, b) => a[1].localeCompare(b[1]))
	if (data.selected && data.file && data.content) {
		const selected = data.selected
		const file = data.file
		const content = data.content
		const text = 'text' in content ? (content.text ?? null) : null
		const image = /^image\/(png|jpeg|gif|webp)$/.test(content.mimeType)
		const blob = 'blob' in content ? content.blob : null
		const mediaHref =
			blob && image ? `data:${content.mimeType};base64,${blob}` : null
		const rawHref = blob ? `data:application/octet-stream;base64,${blob}` : null
		return (
			<AccountManagementShell layout="list" currentHref={currentHref}>
				<div
					css={{
						display: 'flex',
						flexDirection: 'column',
						gap: '0.75rem',
						minWidth: 0,
						'@media (min-width: 901px)': {
							height: 'calc(100dvh - 5rem)',
							minHeight: '30rem',
						},
					}}
				>
					<header
						css={{ display: 'flex', alignItems: 'start', gap: '0.65rem' }}
					>
						<SiteLink
							href={href({ skill: undefined, file: undefined })}
							aria-label="Back to skills"
							title="Back to skills"
							css={{
								display: 'inline-flex',
								padding: '0.3rem',
								color: colors.text,
							}}
						>
							{renderIcon('arrow-left', { size: '16' })}
						</SiteLink>
						<div css={{ minWidth: 0, flex: 1 }}>
							<div
								css={{
									display: 'flex',
									flexWrap: 'wrap',
									gap: '0.5rem 1rem',
									alignItems: 'baseline',
								}}
							>
								<h1 css={{ fontSize: '1.15rem', lineHeight: 1.3, margin: 0 }}>
									{selected.name}
								</h1>
								<SiteLink
									href={`/${selected.packageName}`}
									css={{ fontSize: '0.8rem', color: colors.textMuted }}
								>
									{selected.packageName}
								</SiteLink>
								<span
									title={selected.commit}
									css={{ fontSize: '0.75rem', color: colors.textMuted }}
								>
									{selected.commit.slice(0, 8)}
								</span>
							</div>
							<p
								css={{
									fontSize: '0.85rem',
									color: colors.textMuted,
									margin: '0.25rem 0 0',
								}}
							>
								{selected.description}
							</p>
						</div>
						{selected.files.length > 1 && historySkill !== selected.uri ? (
							<button
								type="button"
								aria-label="Toggle skill files"
								aria-expanded={filesOpen}
								title="Show or hide supporting files"
								onClick={() => setFilesOpen((open) => !open)}
								css={{
									display: 'inline-flex',
									alignItems: 'center',
									gap: '0.35rem',
									padding: '0.3rem 0.5rem',
									fontSize: '0.75rem',
									border: `1px solid ${colors.border}`,
									borderRadius: '0.35rem',
									background: filesOpen
										? colors.primarySoftest
										: colors.surface,
									color: colors.text,
									cursor: 'pointer',
									whiteSpace: 'nowrap',
								}}
							>
								{renderIcon('folder', { size: '14' })}Files (
								{selected.files.length})
							</button>
						) : null}
						<button
							type="button"
							aria-expanded={historySkill === selected.uri}
							onClick={() =>
								setHistorySkill(
									historySkill === selected.uri ? null : selected.uri,
								)
							}
							css={{
								padding: '0.3rem 0.5rem',
								border: `1px solid ${colors.border}`,
								borderRadius: '0.35rem',
								color: colors.text,
								background: colors.surface,
								cursor: 'pointer',
							}}
						>
							History
						</button>
					</header>
					{historySkill !== selected.uri ? (
						<SkillReadAcknowledgement
							identity={`${file.uri}:${selected.commit}`}
							orgSlug={data.orgSlug}
							receipt={data.readReceipt}
						/>
					) : null}
					{historySkill === selected.uri ? (
						<SkillHistory
							key={selected.uri}
							orgSlug={data.orgSlug}
							skill={selected.uri}
							onRestored={() => setHistorySkill(null)}
						/>
					) : (
						<PackageFilesExplorer
							hideExplorer={!filesOpen || selected.files.length <= 1}
							embedded
							fillHeight
							fileHref={(path) => {
								const target = selected.files.find((file) => file.path === path)
								return target ? href({ file: target.uri }) : '#'
							}}
							data={{
								ok: true,
								title: selected.name,
								backHref: href({ skill: undefined, file: undefined }),
								backLabel: 'Skills',
								filesBasePath: '',
								selectedPath: file.path,
								kind: 'file',
								paths: selected.files.map((file) => file.path),
								children: [],
								content: text,
								contentPath: file.path,
								contentKind:
									text !== null
										? /\.md$/i.test(file.path)
											? 'markdown'
											: 'code'
										: image
											? 'image'
											: 'binary',
								language: data.highlighted?.lang ?? null,
								contentHighlighted: data.highlighted,
								contentFences: data.fences,
								contentByteLength: file.size,
								mediaHref,
								rawHref,
							}}
						/>
					)}
				</div>
			</AccountManagementShell>
		)
	}
	return (
		<AccountManagementShell layout="list" currentHref={currentHref}>
			<AccountPageHeader title="Skills" currentHref={currentHref} />
			<div css={{ display: 'grid', gap: '0.75rem' }}>
				<SkillMetricsPanel
					metrics={data.metrics}
					href={href({ skill: undefined, file: undefined }).split('?')[0]!}
				/>
				<AccountSectionTabs
					label="Skills"
					tabs={[
						{
							label: 'All skills',
							href: href({ view: 'all', page: 1 }),
							active: search.view === 'all',
						},
						{
							label: 'By package',
							href: href({ view: 'packages', page: 1 }),
							active: search.view === 'packages',
						},
					]}
				/>
				<RecordTable
					mode="none"
					dense
					ariaLabel="Skills"
					columns={skillColumns}
					rows={rows.map((row) => ({
						...row,
						href: href({ skill: row.id, file: undefined }),
					}))}
					rowGroup={
						search.view === 'packages'
							? (row) => String(row.values?.package)
							: undefined
					}
					emptyLabel={
						data.skills.length
							? 'No skills match these filters.'
							: 'No published skills are available in this workspace.'
					}
					dataControls={{
						visibilityKey: 'skills',
						defaultHidden: ['recent'],
						state: {
							globalFilter: query.trim(),
							columnFilters: [
								...(search.package
									? [{ id: 'package', value: search.package }]
									: []),
								...(search.activity !== 'all'
									? [{ id: 'reads', value: search.activity }]
									: []),
							],
							sorting: [
								...(search.view === 'packages' && search.sort !== 'package'
									? [{ id: 'package', desc: false }]
									: []),
								{
									id: search.sort,
									desc:
										search.desc ??
										(search.sort === 'reads' || search.sort === 'recent'),
								},
							],
							pagination: {
								pageIndex: search.page - 1,
								pageSize: search.pageSize,
							},
						},
						onStateChange: (patch) => {
							const sorting = patch.sorting?.at(-1)
							onFilter({
								...(patch.pagination
									? {
											page: patch.pagination.pageIndex + 1,
											pageSize: patch.pagination.pageSize,
										}
									: {}),
								...(sorting
									? {
											sort: sorting.id as SkillsSearch['sort'],
											desc: sorting.desc,
										}
									: {}),
							})
						},
					}}
					toolbar={
						<>
							<RecordTableSearch
								label="Search skills"
								placeholder="Search skills or packages"
								value={query}
								onInput={(value) => {
									setDraft({ source: search.q, value })
									onSearch(value)
								}}
							/>
							<RecordTableSelect
								label="Sort skills"
								value={search.sort}
								onChange={(value) =>
									onFilter({
										sort: value as SkillsSearch['sort'],
										desc: undefined,
										page: 1,
									})
								}
							>
								<option value="name">Name</option>
								<option value="reads">Most read</option>
								<option value="recent">Recently read</option>
								<option value="package">Package</option>
							</RecordTableSelect>
							<RecordTableSelect
								label="Filter by package"
								value={search.package}
								onChange={(value) => onFilter({ package: value, page: 1 })}
							>
								<option value="">All packages</option>
								{packages.map(([id, name]) => (
									<option key={id} value={id}>
										{name}
									</option>
								))}
							</RecordTableSelect>
							<RecordTableSelect
								label="Filter by read activity"
								value={search.activity}
								onChange={(value) =>
									onFilter({
										activity: value as SkillsSearch['activity'],
										page: 1,
									})
								}
							>
								<option value="all">All reads · 30d</option>
								<option value="read">Read · 30d</option>
								<option value="unread">Unread · 30d</option>
							</RecordTableSelect>
							{search.package || search.activity !== 'all' || query ? (
								<button
									type="button"
									onClick={() =>
										onFilter({ package: '', activity: 'all', q: '', page: 1 })
									}
								>
									Clear filters
								</button>
							) : null}
						</>
					}
				/>
			</div>
		</AccountManagementShell>
	)
}
