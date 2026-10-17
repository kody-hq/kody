import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	formatOnboardingSearchNotice,
	onboardingAccessSelectedLede,
	onboardingAccessWinMadeLine,
	onboardingConnectedAgentLabelsLine,
	uniqueOnboardingConnectedAgents,
	onboardingAgentHref,
	onboardingChecklistItemHref,
	onboardingChecklistItems,
	onboardingExplorePackagesHref,
	onboardingIndexRedirectHref,
	onboardingPortabilityProofPrompt,
	onboardingSecondAgentHref,
	onboardingSecondAgentConnectedStatusLabel,
	onboardingStep2Prompt,
	onboardingWizardStepHref,
	onboardingWizardSteps,
	portabilityGuideEntity,
	remainingOnboardingWizardLabels,
	resolveOnboardingFirstAgentKind,
	resumeOnboardingWizardStep,
} from './onboarding-process.ts'

const guidesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../docs/guides',
)

const progress = (
	hasMcpClient: boolean,
	hasAccessWin: boolean,
	hasSecondMcpClient: boolean,
) => ({ hasMcpClient, hasAccessWin, hasSecondMcpClient })

test('the derived checklist covers verify-email plus each wizard step', () => {
	expect(onboardingChecklistItemHref('verify-email', 'kentcdodds')).toBe(
		'/pending-verification',
	)
	for (const step of onboardingWizardSteps) {
		const item = onboardingChecklistItems.find(
			(candidate) =>
				'wizardStep' in candidate && candidate.wizardStep === step.number,
		)
		if (!item) {
			throw new Error(`wizard step ${step.number} needs a checklist item`)
		}
		expect(onboardingChecklistItemHref(item.id, 'kentcdodds')).toBe(step.path)
	}
	expect(onboardingChecklistItemHref('install-starter', 'kentcdodds')).toBe(
		'/@kentcdodds',
	)
	expect([
		onboardingIndexRedirectHref(),
		onboardingIndexRedirectHref('?redirectTo=%2F'),
		onboardingIndexRedirectHref(
			'?redirectTo=%2F',
			progress(true, false, false),
		),
		onboardingIndexRedirectHref('', progress(true, true, true)),
		onboardingWizardStepHref(2),
		onboardingWizardStepHref(3),
		onboardingAgentHref('cursor'),
		onboardingAgentHref('other'),
		onboardingAgentHref('cursor', '?redirectTo=%2F'),
		onboardingAgentHref(null, '?redirectTo=%2F'),
		onboardingSecondAgentHref('claude-code'),
		onboardingSecondAgentHref('other'),
		onboardingSecondAgentHref(null, '?redirectTo=%2F'),
		onboardingExplorePackagesHref(),
	]).toEqual([
		'/onboarding/step-1',
		'/onboarding/step-1?redirectTo=%2F',
		'/onboarding/step-2?redirectTo=%2F',
		'/onboarding/step-3',
		'/onboarding/step-2',
		'/onboarding/step-3',
		'/onboarding/step-1/cursor',
		'/onboarding/step-1/not-listed',
		'/onboarding/step-1/cursor?redirectTo=%2F',
		'/onboarding/step-1?redirectTo=%2F',
		'/onboarding/step-3/claude-code',
		'/onboarding/step-3',
		'/onboarding/step-3?redirectTo=%2F',
		'/community',
	])

	expect(onboardingWizardSteps.map((step) => step.path)).toEqual([
		'/onboarding/step-1',
		'/onboarding/step-2',
		'/onboarding/step-3',
	])
})

test('step 2 is one short prompt that retrieves the onboarding guide', () => {
	expect(onboardingAccessSelectedLede(null)).toContain('your agent')
	expect(onboardingAccessSelectedLede('Cursor')).toContain('Cursor')
	expect(onboardingStep2Prompt).toContain(
		'search({ entity: "guide:onboarding" })',
	)
	expect(onboardingPortabilityProofPrompt).toContain(
		'search({ entity: "guide:portability" })',
	)
	const longSubject =
		'Family vault photo backup cannot use Cloudflare Tunnel for large uploads'
	const madeLines: Array<
		[Parameters<typeof onboardingAccessWinMadeLine>[0], string | null]
	> = [
		[{}, null],
		[{ packageName: 'grok-bot' }, null],
		[{ memorySubject: 'Preferred commute' }, 'You made Preferred commute'],
		[{ packageName: '@you/morning-digest' }, 'You made @you/morning-digest'],
		[
			{
				memorySubject: 'Preferred commute',
				packageName: '@you/morning-digest',
			},
			'You made Preferred commute and @you/morning-digest',
		],
		[
			{ memorySubject: longSubject, packageName: 'grok-bot' },
			'You made Family vault photo backup cannot use Cloudflare…',
		],
		[
			{ memorySubject: longSubject, packageName: '@you/family-vault' },
			'You made Family vault photo backup cannot use Cloudflare… and @you/family-vault',
		],
	]
	expect(
		madeLines.map(([input]) => [input, onboardingAccessWinMadeLine(input)]),
	).toEqual(madeLines)

	expect(onboardingConnectedAgentLabelsLine([])).toBeNull()
	expect(onboardingConnectedAgentLabelsLine([{ label: 'Cursor' }])).toBe(
		'Connected: Cursor',
	)
	expect(
		onboardingConnectedAgentLabelsLine([
			{ label: 'Cursor', kind: 'cursor' },
			{ label: 'Claude Desktop', kind: 'claude-desktop' },
		]),
	).toBe('Connected: Cursor and Claude Desktop')
	expect(
		uniqueOnboardingConnectedAgents([
			{ label: 'Cursor', kind: 'cursor' },
			{ label: ' Cursor ', kind: 'cursor' },
			{ label: 'Kody' },
		]),
	).toEqual([
		{ label: 'Cursor', kind: 'cursor' },
		{ label: 'Kody', kind: null },
	])
	expect(onboardingSecondAgentConnectedStatusLabel(false)).toBe(
		"You've connected a second agent.",
	)
	expect(onboardingSecondAgentConnectedStatusLabel(true)).toBe(
		"You've connected a second agent. Pro is free for 2 weeks.",
	)
})

test('resume step is the first unfinished wizard step, else step 3', () => {
	expect([
		resumeOnboardingWizardStep(progress(false, false, false)),
		resumeOnboardingWizardStep(progress(true, false, false)),
		resumeOnboardingWizardStep(progress(true, true, false)),
		resumeOnboardingWizardStep(progress(true, true, true)),
	]).toEqual([1, 2, 3, 3])

	const cursorAt17 = {
		kind: 'cursor',
		connectedAt: '2026-09-08T17:00:00.000Z',
	} as const
	const chatgptAt17 = {
		kind: 'chatgpt',
		connectedAt: '2026-09-08T17:00:00.000Z',
	} as const
	const claudeAt18 = {
		kind: 'claude-desktop',
		connectedAt: '2026-09-08T18:00:00.000Z',
	} as const
	const firstAgents: Array<
		[
			...Parameters<typeof resolveOnboardingFirstAgentKind>,
			ReturnType<typeof resolveOnboardingFirstAgentKind>,
		]
	> = [
		[null, [claudeAt18, cursorAt17], 'cursor'],
		['claude-desktop', [cursorAt17], 'cursor'],
		['claude-desktop', [chatgptAt17], 'chatgpt'],
		['claude-desktop', [], 'claude-desktop'],
		['claude-desktop', [claudeAt18, chatgptAt17], 'claude-desktop'],
		[null, [{ kind: 'cursor', connectedAt: null }], 'cursor'],
		['claude-desktop', [{ kind: 'chatgpt', connectedAt: null }], 'chatgpt'],
		[
			'claude-desktop',
			[{ kind: null, connectedAt: '2026-09-08T17:00:00.000Z' }],
			null,
		],
	]
	expect(
		firstAgents.filter(
			([selected, agents, want]) =>
				resolveOnboardingFirstAgentKind(selected, agents) !== want,
		),
	).toEqual([])
})

test('search leftover notice lists remaining wizard steps, not a quest', () => {
	expect(remainingOnboardingWizardLabels(progress(true, false, false))).toEqual(
		['Make something useful', 'Connect a second agent'],
	)
	expect(remainingOnboardingWizardLabels(progress(true, true, true))).toEqual(
		[],
	)
	const notice = formatOnboardingSearchNotice(
		['Make something useful', 'Connect a second agent'],
		'https://kody.example',
	)
	expect(notice).toContain('2 steps left')
	expect(notice).toContain('Make something useful')
	expect(notice).toContain('Connect a second agent')
	expect(notice).toContain('https://kody.example/onboarding')
	expect(formatOnboardingSearchNotice([], 'https://kody.example')).toBeNull()
})

test('first-win and quick-example name the current wizard steps', () => {
	const firstWin = readFileSync(join(guidesDir, 'first-win.md'), 'utf8')
	const quickExample = readFileSync(join(guidesDir, 'quick-example.md'), 'utf8')
	const portability = readFileSync(join(guidesDir, 'portability.md'), 'utf8')
	const connectYourAgent = readFileSync(
		join(guidesDir, 'connect-your-agent.md'),
		'utf8',
	)
	for (const step of onboardingWizardSteps) {
		expect(firstWin.includes(step.label) || firstWin.includes(step.path)).toBe(
			true,
		)
	}
	const giveAccess = onboardingWizardSteps.find((step) => step.number === 2)
	const connectAgent = onboardingWizardSteps.find((step) => step.number === 1)
	const secondAgent = onboardingWizardSteps.find((step) => step.number === 3)
	if (!giveAccess || !connectAgent || !secondAgent) {
		throw new Error('wizard steps 1, 2, and 3 are required')
	}
	expect(quickExample).toContain(giveAccess.label)
	expect(quickExample).toContain(connectAgent.path)
	expect(quickExample).toContain('first-win')
	expect(portability).toContain(portabilityGuideEntity)
	expect(portability).toContain(secondAgent.path)
	expect(connectYourAgent).toContain(giveAccess.path)
})
