import { publicAsset } from '../../public-assets.ts'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { FeatureRelated } from './feature-related.tsx'
import {
	MemoryEditScene,
	MemoryHeroScene,
	MemoryIndexScene,
	type MemoryNote,
	type MemoryNoteId,
} from './memory-scenes.tsx'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'
const notes: ReadonlyArray<MemoryNote> = [
	{
		id: 'writing',
		kind: 'Writing preference',
		fact: 'Lead with the decision.',
		task: 'Draft my weekly update.',
		draft: "We're moving ahead with the new design. Review starts Thursday.",
	},
	{
		id: 'projects',
		kind: 'Project name',
		fact: 'Website refresh: Orchard.',
		task: 'Help me outline an Orchard update.',
		draft:
			'Orchard update: what changed on the website, what needs review, and what comes next.',
	},
	{
		id: 'people',
		kind: 'People',
		fact: 'Morgan is my accountant.',
		task: 'Draft a question for my accountant.',
		draft:
			'Hi Morgan, which documents should I have ready before our next meeting?',
	},
]
const originalWritingPreference = 'Lead with the decision. Keep updates short.'
const updatedWritingPreference =
	'Include the decision, the reason, and the next step.'
const originalProjectDraft =
	"We're moving ahead with the new design. Review starts Thursday."
const updatedProjectDraft =
	"We're moving ahead with the new design. The review feedback is solid. Next step: begin the review Thursday."
export function MemoryFeature() {
	const [nextAgent, setNextAgent] = useState(true)
	const [heroShot, setHeroShot] = useState(0)
	const [note, setNote] = useState<MemoryNoteId>('writing')
	const [updated, setUpdated] = useState(false)
	const [editShot, setEditShot] = useState(0)
	const writingPreference = updated
		? updatedWritingPreference
		: originalWritingPreference
	const selectedNote = notes.find((entry) => entry.id === note) ?? notes[0]!
	return (
		<div className="study memory">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset('/images/lantern/kody-primitives-orb-memory.webp')}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						New agent.
						<br />
						<em>Same you.</em>
					</h1>
					<p className="lead">
						Save the facts and preferences you keep repeating. Bring them to
						your next connected agent.
					</p>
					<SiteLink className="action" href="/onboarding">
						Connect your agent
					</SiteLink>
					<div className="controls" aria-label="Example agent">
						<button
							type="button"
							aria-pressed={!nextAgent}
							onClick={() => {
								setNextAgent(false)
								setHeroShot((shot) => shot + 1)
							}}
						>
							Save in one agent
						</button>
						<button
							type="button"
							aria-pressed={nextAgent}
							onClick={() => {
								setNextAgent(true)
								setHeroShot((shot) => shot + 1)
							}}
						>
							Try another agent
						</button>
					</div>
				</div>
				<div className="memory-stack">
					<span className="example">
						Example memory, shared between connected agents
					</span>
					<MemoryHeroScene
						mode={nextAgent ? 'recall' : 'save'}
						preference={writingPreference}
						draft={updated ? updatedProjectDraft : originalProjectDraft}
						shot={heroShot}
					/>
					<p className="visually-hidden" aria-live="polite">
						{nextAgent
							? `Your next connected agent found your saved preference: ${writingPreference}`
							: 'Your first agent saved your writing preference in Kody.'}
					</p>
				</div>
			</div>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>A little context goes a long way.</h2>
						<p>
							A writing preference. A project name. The person you mean when you
							say “my accountant.” Keep the details worth carrying into the next
							conversation.
						</p>
						<div className="controls" aria-label="Choose an example memory">
							<button
								type="button"
								aria-pressed={note === 'writing'}
								onClick={() => {
									setNote('writing')
								}}
							>
								Writing
							</button>
							<button
								type="button"
								aria-pressed={note === 'projects'}
								onClick={() => {
									setNote('projects')
								}}
							>
								Projects
							</button>
							<button
								type="button"
								aria-pressed={note === 'people'}
								onClick={() => {
									setNote('people')
								}}
							>
								People
							</button>
						</div>
						<details className="ms-details">
							<summary>How does the right note surface?</summary>
							<p>
								Kody returns a small amount of relevant context when your
								connected agent searches or runs work with a memory hint.
								Memories belong to your account.
							</p>
							<SiteLink href="/docs/memory">
								How memory retrieval works
							</SiteLink>
						</details>
					</div>
					<div className="ms-memory-index">
						<MemoryIndexScene notes={notes} selected={note} />
						<p className="visually-hidden" aria-live="polite">
							{`${selectedNote.kind}: ${selectedNote.fact} Example draft: ${selectedNote.draft}`}
						</p>
					</div>
				</div>
			</section>
			<section className="story-section">
				<div className="story-split">
					<div className="ms-edit-scene">
						<MemoryEditScene
							original={originalWritingPreference}
							updated={updatedWritingPreference}
							isUpdated={updated}
							shot={editShot}
						/>
						<p className="ms-update-status" id="ms-update-status" role="status">
							{updated
								? 'Found your existing writing preference. Updated it to include the decision, the reason, and the next step.'
								: 'The original preference is saved.'}
						</p>
					</div>
					<div>
						<h2>
							Changed your mind?
							<br />
							Change the memory.
						</h2>
						<p>
							Ask your agent to update what it remembers. It checks related
							memories first, then tells you what changed.
						</p>
						<div className="controls">
							<button
								type="button"
								className="run"
								id="ms-update"
								disabled={updated}
								onClick={() => {
									setUpdated(true)
									setEditShot((shot) => shot + 1)
								}}
							>
								Make updates more detailed
							</button>
							<button
								type="button"
								id="ms-reset"
								onClick={() => {
									setUpdated(false)
									setEditShot((shot) => shot + 1)
								}}
							>
								Reset example
							</button>
						</div>
						<p>
							Search your memories, remove what you no longer need, or download
							a JSON copy.
						</p>
						<SiteLink href="/docs/memory">
							How to manage and export memories
						</SiteLink>
					</div>
				</div>
				<div className="ms-next-agent">
					<h3>Take it to your next agent.</h3>
					<div className="ms-prompt-pair">
						<div>
							<label htmlFor="ms-save-prompt">
								In your first connected agent
							</label>
							<textarea
								id="ms-save-prompt"
								readOnly
								value="Save this in Kody memory: for project updates, lead with the decision and keep it short."
							/>
						</div>
						<div>
							<label htmlFor="ms-lookup-prompt">
								In another connected agent
							</label>
							<textarea
								id="ms-lookup-prompt"
								readOnly
								value="Look up my project-update preference in Kody and help me draft an update."
							/>
						</div>
					</div>
				</div>
			</section>
			<FeatureRelated
				links={[
					{
						href: '/use-cases/shared-agent-memory',
						label: 'Shared agent memory use case',
					},
					{ href: '/features/credentials', label: 'Credentials' },
				]}
			/>
			<div className="feature-start">
				<SiteLink href="/docs/memory">Read the memory guide</SiteLink>
				<BuildWithAgentButton />
			</div>
		</div>
	)
}
