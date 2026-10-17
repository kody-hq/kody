/** @jsxImportSource @emotion/react */
import { publicAsset } from '../../public-assets.ts'
import { useEffect, useRef, useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { AppsSharing } from './apps-sharing.tsx'
import { AppsIntake, type Brief } from './apps-intake.tsx'
import {
	AppsHeroScene,
	AppsReturnScene,
	tomorrowBrief,
} from './apps-scenes.tsx'
import { FeatureRelated } from './feature-related.tsx'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'
const initialBrief: Brief = {
	id: 0,
	name: 'Autumn launch',
	kind: 'Website',
	deadline: 'October 28',
	copy: 'A product page for the new collection.',
}
export function AppsFeature() {
	const [draft, setDraft] = useState({ ...initialBrief })
	const [records, setRecords] = useState<Brief[]>([{ ...initialBrief }])
	const [view, setView] = useState<'form' | 'records' | 'detail'>('form')
	const [opened, setOpened] = useState<Brief | undefined>()
	const [saved, setSaved] = useState(false)
	const [nextId, setNextId] = useState(1)
	const [promptShot, setPromptShot] = useState(0)
	const [saveShot, setSaveShot] = useState(0)
	const [flyingName, setFlyingName] = useState(initialBrief.name)
	const savedBriefHeading = useRef<HTMLHeadingElement>(null)
	useEffect(() => {
		if (view === 'detail') savedBriefHeading.current?.focus()
	}, [view, opened])
	function save() {
		if (!draft.name.trim()) return
		const savedDraft = { ...draft, name: draft.name.trim() }
		setDraft(savedDraft)
		const exists = records.some((record) => record.id === draft.id)
		setRecords(
			exists
				? records.map((record) =>
						record.id === draft.id ? savedDraft : record,
					)
				: [...records, savedDraft],
		)
		setOpened(savedDraft)
		setSaved(true)
		setFlyingName(savedDraft.name)
		setSaveShot((value) => value + 1)
		setView('detail')
	}
	function showForm() {
		setView('form')
		setPromptShot((value) => value + 1)
	}
	function showRecords() {
		setView('records')
		setPromptShot((value) => value + 1)
	}
	function newBrief() {
		setNextId((value) => value + 1)
		setDraft({
			id: nextId,
			name: '',
			kind: 'Website',
			deadline: 'No deadline',
			copy: '',
		})
		setView('form')
	}
	function recordList() {
		return records.map((record) => (
			<button
				key={record.id}
				className="ia-record"
				type="button"
				onClick={() => {
					setOpened({ ...record })
					setDraft({ ...record })
					setView('detail')
				}}
			>
				<span>
					<strong>{record.name}</strong>
					<small>
						{record.kind} · {record.deadline}
					</small>
				</span>
				<span>Open brief ↗</span>
			</button>
		))
	}
	return (
		<div className="study apps">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset('/images/lantern/kody-primitives-orb-apps.webp')}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Give your work
						<br />
						<em>a place to happen.</em>
					</h1>
					<p className="lead">
						Ask your agent for a tool that fits the job. Kody hosts the app,
						keeps its data, and connects it to the packages you already use.
					</p>
					<SiteLink className="action" href="/onboarding">
						Build an app
					</SiteLink>
				</div>
				<div>
					<span className="example">
						Interactive demo, saved only in this page session
					</span>
					<AppsHeroScene
						promptShot={promptShot}
						saveShot={saveShot}
						count={records.length}
						flyingName={flyingName}
						formPressed={view === 'form'}
						recordsPressed={view === 'records'}
						onShowForm={showForm}
						onShowRecords={showRecords}
					>
						{view === 'form' ? (
							<AppsIntake
								draft={draft}
								onSave={save}
								onChange={(next) => {
									setDraft(next)
								}}
							/>
						) : view === 'records' ? (
							<div className="pw-apx-records">
								<h3>Saved briefs</h3>
								{recordList()}
							</div>
						) : (
							<div className="pw-apx-detail">
								<h3
									ref={savedBriefHeading}
									id="saved-brief-heading"
									tabIndex={-1}
								>
									{draft.name}
								</h3>
								<p>
									{draft.kind} · {draft.deadline}
								</p>
								<p>{draft.copy}</p>
								<p role="status">
									{saved ? 'Saved in this demo' : 'Example brief'}
								</p>
								<div className="pw-apx-actions">
									<button
										type="button"
										className="run"
										onClick={() => {
											setView('form')
											setPromptShot((value) => value + 1)
										}}
									>
										Edit brief
									</button>
									<button
										type="button"
										className="run"
										onClick={() => {
											setPromptShot((value) => value + 1)
											newBrief()
										}}
									>
										New brief
									</button>
								</div>
							</div>
						)}
					</AppsHeroScene>
					<p className="visually-hidden" aria-live="polite">
						{saveShot > 0
							? `${flyingName} saved. ${records.length} in Saved briefs.`
							: ''}
					</p>
				</div>
			</div>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Open it.
							<br />
							Do the thing.
							<br />
							Come back tomorrow.
						</h2>
						<p>
							A brief to collect. A project to update. A small calculator you
							use every week. Give the work a screen of its own, with data that
							stays with the package.
						</p>
						<SiteLink href="/docs/package-apps">How app data works ↗</SiteLink>
					</div>
					<div className="ia-return-scene">
						<AppsReturnScene records={records} openedId={opened?.id} />
						<p className="visually-hidden">
							{`Tomorrow, ${records.map((record) => record.name).join(', ')} ${records.length === 1 ? 'is' : 'are'} still saved, and ${tomorrowBrief.name} was added.`}
						</p>
						<div className="ia-saved-head">
							<h3>Saved briefs</h3>
							<span>Page-session demo</span>
						</div>
						<div>{recordList()}</div>
						<p className="ia-note" role="status">
							{saved
								? 'Saved only in this page session.'
								: 'Open the example, or save your own brief above.'}
						</p>
						{opened && (
							<div className="ia-record-detail">
								<h3>{opened.name}</h3>
								<p>
									{opened.kind} · {opened.deadline}
								</p>
								<p>{opened.copy}</p>
								<div className="ia-record-actions">
									<button
										type="button"
										className="run"
										onClick={() => {
											if (opened) {
												setDraft({ ...opened })
												setView('form')
												setPromptShot((value) => value + 1)
											}
										}}
									>
										Edit this brief
									</button>
									<SiteLink href="#intake-demo">Go to intake form ↑</SiteLink>
								</div>
							</div>
						)}
					</div>
				</div>
			</section>
			<AppsSharing preview={opened ?? records[0] ?? initialBrief} />
			<FeatureRelated
				links={[
					{ href: '/features/packages', label: 'Reusable packages' },
					{ href: '/features/triggers', label: 'Triggers and automation' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>Build the tool you would open every week.</h2>
					<p>
						Start with a small job, a project intake form, a review queue, or a
						tracker with data worth keeping.
					</p>
					<p>
						<SiteLink href="/docs/package-apps">Read the guide</SiteLink>
					</p>
				</div>
				<div>
					<SiteLink className="action" href="/onboarding">
						Build an app
					</SiteLink>
					<BuildWithAgentButton />
				</div>
			</div>
		</div>
	)
}
