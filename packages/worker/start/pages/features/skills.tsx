import { publicAsset } from '../../public-assets.ts'
import { SiteLink } from '../../components/site-link.tsx'
import { Textarea } from '../../components/input.tsx'
import { FeatureRelated } from './feature-related.tsx'
import { FeatureCtaActions, FeatureCtaLink } from './feature-cta.tsx'
import { FeatureExample } from './feature-example.tsx'

const layout = `my-package/
├── package.json
├── src/index.ts
└── skills/
    └── hello-skill/
        ├── SKILL.md      # required
        ├── references/   # optional
        ├── scripts/      # optional
        └── assets/       # optional`

const skillFile = `---
name: hello-skill
description:
  Greets the user by name. Use when the user asks
  for a friendly hello.
---

# Hello skill

1. Ask for the person's name if you do not have it.
2. Reply with a short greeting.
3. Read references/checklist.md before sending
   anything longer than a sentence.`

const publishCheck = `skills ok   Validated 1 package skill: hello-skill.

skills fail Skill "skills/hello-skill/SKILL.md" is
            missing frontmatter "name".`

const openSkill = `search({
  entity:
    'package:@you/my-package#skills/hello-skill/SKILL.md',
})`

export function SkillsFeature() {
	return (
		<div className="study skills">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset('/images/features/skills.svg')}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Teach every agent
						<br />
						<em>the same playbook.</em>
					</h1>
					<p className="lead">
						A skill is a set of instructions an agent loads when a task calls
						for it. Put Agent Skills in a Kody package and everyone who can read
						the package works from the same published version.
					</p>
					<FeatureCtaLink href="/onboarding">Connect your agent</FeatureCtaLink>
				</div>
				<div>
					<span className="example">Example package skill</span>
					<FeatureExample
						title="skills/hello-skill"
						state="Published"
						tabsLabel="Skill example"
						tabs={[
							{
								id: 'layout',
								label: 'Layout',
								summary:
									'A skill is a folder under skills in a package, with a required SKILL.md file.',
								code: layout,
							},
							{
								id: 'skill',
								label: 'SKILL.md',
								summary:
									'SKILL.md has a name and a description in frontmatter, then the instructions.',
								code: skillFile,
							},
							{
								id: 'publish',
								label: 'Publish check',
								summary:
									'Publishing reports whether each package skill is valid.',
								code: publishCheck,
							},
						]}
					/>
				</div>
			</div>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							A folder and a file.
							<br />
							Checked at publish.
						</h2>
						<p>
							Each skill is one folder at{' '}
							<code>skills/&lt;name&gt;/SKILL.md</code>, following the open{' '}
							<a href="https://agentskills.io/specification">
								Agent Skills specification
							</a>
							. The folder is the declaration. There is nothing else to
							register.
						</p>
						<p>
							Skills go through the same publish checks as the rest of the
							package. A skill with a missing name or description fails the
							publish, and nothing goes live.
						</p>
						<SiteLink href="/docs/package-skills">
							How to ship skills in a package
						</SiteLink>
					</div>
					<div>
						<h3>Open a skill from any connected agent</h3>
						<p>
							An agent finds the skill through Kody search, then opens the file.
						</p>
						<FeatureExample
							title="Kody search"
							tabs={[
								{
									id: 'search',
									label: 'Search',
									summary: 'A search call that opens one skill file.',
									code: openSkill,
								},
							]}
						/>
					</div>
				</div>
			</section>
			<section className="story-section">
				<div className="story-split">
					<div>
						<h2>
							Browse them.
							<br />
							Compare versions.
						</h2>
						<p>
							Open Skills in your workspace to see published skills across the
							packages you can read. Search by skill or package name, then read
							the instructions and their supporting files.
						</p>
						<p>
							History shows earlier published versions and what changed between
							them. People who can write to the package can restore one skill
							folder as a new version, through the normal publish checks.
						</p>
					</div>
					<div>
						<h3>See what gets read</h3>
						<p>
							The Skills page shows the last 30 days of reads: instruction
							reads, supporting-file reads, distinct people, and the most-read
							skills.
						</p>
						<p>
							A read means Kody delivered or displayed the file. It is not proof
							that an agent followed the instructions.
						</p>
						<SiteLink href="/docs/package-skills#read-metrics">
							What counts as a read
						</SiteLink>
					</div>
				</div>
				<div className="ms-next-agent">
					<h3>Ask your agent to write one.</h3>
					<div className="ms-prompt-pair">
						<div>
							<label htmlFor="skills-write-prompt">Add a skill</label>
							<Textarea
								id="skills-write-prompt"
								readOnly
								value="Add a skill to my weekly-brief package in Kody that explains how I like status updates written, then publish it."
							/>
						</div>
						<div>
							<label htmlFor="skills-use-prompt">Use it somewhere else</label>
							<Textarea
								id="skills-use-prompt"
								readOnly
								value="Search Kody for my status update skill, read it, and draft this week's update."
							/>
						</div>
					</div>
					<p className="smallprint">
						Serving skills directly through the Skills extension for MCP is an
						opt-in experiment, because support in agent apps is still partial.{' '}
						<SiteLink href="/docs/package-skills#which-hosts-support-it">
							See which hosts support it
						</SiteLink>
					</p>
				</div>
			</section>
			<FeatureRelated
				links={[
					{ href: '/features/packages', label: 'Packages' },
					{ href: '/features/memory', label: 'Memory' },
					{ href: '/features/agent-profiles', label: 'Agent profiles' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>Start with the instructions you keep repeating.</h2>
					<p>
						<SiteLink href="/docs/package-skills">
							Read the package skills guide
						</SiteLink>
					</p>
				</div>
				<FeatureCtaActions href="/onboarding" label="Connect your agent" />
			</div>
		</div>
	)
}
