import { publicAsset } from '../../public-assets.ts'
import { SiteLink } from '../../components/site-link.tsx'
import { Textarea } from '../../components/input.tsx'
import { FeatureRelated } from './feature-related.tsx'
import { FeatureCtaActions, FeatureCtaLink } from './feature-cta.tsx'
import { FeatureAvailability, FeatureExample } from './feature-example.tsx'

const create = `fileCreate({
  file_id: '<new uuid>',
  write_id: '<new uuid>',
  name: 'launch-plan.md',
  media_type: 'text/markdown',
  content: '# Launch plan\\n\\n- Draft the announcement',
})`

const write = `fileWrite({
  file_id,
  write_id: '<new uuid>',
  base_revision_id, // the version you read
  content,
})

// someone saved first? nothing is overwritten:
{
  ok: false,
  code: 'revision_conflict',
  current: '...',
  proposed: '...'
}`

const share = `// a read link anyone can open; turn it off to revoke
filePublicLinkSet({ file_id, enabled: true })

// a temporary download URL, up to 24 hours
fileAssetSign({ file_id, minutes: 60 })`

export function FilesFeature() {
	return (
		<div className="study files">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset('/images/features/files.svg')}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Files you and your agents
						<br />
						<em>edit together.</em>
					</h1>
					<p className="lead">
						A workspace for pages, folders, and uploads. You work in the
						browser. Your agents read and write the same files, with the same
						permissions.
					</p>
					<FeatureCtaLink href="/onboarding">Connect your agent</FeatureCtaLink>
					<FeatureAvailability>
						Files is in early access behind a feature flag. Ask for access in
						the <SiteLink href="/discord">Kody Discord</SiteLink>.
					</FeatureAvailability>
				</div>
				<div>
					<span className="example">Example calls your agent makes</span>
					<FeatureExample
						title="Workspace files"
						state="Early access"
						tabsLabel="Files example"
						tabs={[
							{
								id: 'create',
								label: 'Create',
								summary: 'An agent creates a Markdown file in the workspace.',
								code: create,
							},
							{
								id: 'write',
								label: 'Save',
								summary:
									'A save names the version it was based on. A conflict returns both versions and overwrites neither.',
								code: write,
							},
							{
								id: 'share',
								label: 'Share',
								summary:
									'An agent can turn on a public read link or make a temporary download URL.',
								code: share,
							},
						]}
					/>
				</div>
			</div>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Every save
							<br />
							is a version.
						</h2>
						<p>
							Each save is kept as its own revision, so you can read the history
							of a file. When two edits collide, Kody returns both versions and
							overwrites neither.
						</p>
						<p>
							Rename, move, and trash files and folders, then restore them from
							the trash. A text file can hold up to 64 KiB and an uploaded file
							up to 16 MiB.
						</p>
					</div>
					<div>
						<h3>Work in the same page</h3>
						<p>
							Pages support live editing, so you see other people and agents
							while they work. An agent can change one block of a page without
							replacing the rest.
						</p>
						<p>
							Discuss the work where it is: comments can point at a moment in a
							video or audio file, a spot on an image, or a value in a JSON or
							CSV file.
						</p>
					</div>
				</div>
			</section>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Private first.
							<br />
							Shared on purpose.
						</h2>
						<p>
							Files start private to your workspace. Items inherit access from
							their folder, or you can restrict one and invite the people who
							need it.
						</p>
						<p>
							A public read link exists only when you create one, and you can
							revoke it. A folder link leaves out restricted items, and
							comments, people, and history stay private.
						</p>
					</div>
					<div>
						<h3>Preview without downloading</h3>
						<p>
							Open Markdown, HTML, CSV, JSON, images, audio, and video in the
							workspace. HTML files preview in a sandbox.
						</p>
						<h3>Your storage, if you want it</h3>
						<p>
							Workspaces with Files include storage. A workspace owner can
							connect a Cloudflare R2 or Amazon S3 bucket for new revisions
							instead.
						</p>
					</div>
				</div>
				<div className="ms-next-agent">
					<h3>Ask your agent to pick up where you left off.</h3>
					<div className="ms-prompt-pair">
						<div>
							<label htmlFor="files-create-prompt">Start a page</label>
							<Textarea
								id="files-create-prompt"
								readOnly
								value="Create a page in my Kody files called Launch plan with a checklist for next week's release."
							/>
						</div>
						<div>
							<label htmlFor="files-edit-prompt">Change one part</label>
							<Textarea
								id="files-edit-prompt"
								readOnly
								value="Open Launch plan in my Kody files and rewrite only the announcement section."
							/>
						</div>
					</div>
				</div>
			</section>
			<FeatureRelated
				links={[
					{
						href: '/blog/whats-new-in-kody-2026-11-12',
						label: 'Announcement: workspace Files',
					},
					{ href: '/features/apps', label: 'Apps' },
					{ href: '/features/agent-profiles', label: 'Agent profiles' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>For when you just need a file.</h2>
					<p>
						<SiteLink href="/discord">Ask for early access in Discord</SiteLink>
					</p>
				</div>
				<FeatureCtaActions href="/onboarding" label="Connect your agent" />
			</div>
		</div>
	)
}
