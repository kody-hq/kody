import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import {
	WizardNavigation,
	WizardStepsNav,
} from '../../pages/onboarding-wizard-chrome.tsx'

test('linear stepper marks finished, active and upcoming steps', async () => {
	const midway = await renderToString(
		jsx(WizardStepsNav, {
			activeStep: 2,
			hasMcpClient: true,
			accessWin: false,
			hasSecondMcpClient: false,
			stepHref: (step: 1 | 2 | 3) => `/onboarding/step-${step}`,
		}),
	)
	expect(midway).toContain('data-testid="onboarding-stepper"')
	expect(midway).toContain('2 steps left')
	expect(midway).toContain('data-step-state="complete"')
	expect(midway).toContain('data-step-state="current"')
	expect(midway).toContain('data-step-state="upcoming"')
	expect(midway).toContain('data-step-connector="filled"')

	const alreadyDone = await renderToString(
		jsx(WizardStepsNav, {
			activeStep: 3,
			hasMcpClient: true,
			accessWin: true,
			hasSecondMcpClient: true,
			stepHref: (step: 1 | 2 | 3) => `/onboarding/step-${step}`,
		}),
	)
	expect(alreadyDone).toContain('All steps complete')
})

test('connect wait replaces Next and Next shortens through a container query', async () => {
	const waiting = await renderToString(
		jsx(WizardNavigation, {
			activeStep: 1,
			onSelectStep() {},
			connectWaitLabel: 'Waiting for Cursor to connect…',
		}),
	)
	expect(waiting).toContain('data-testid="onboarding-connect-wait"')
	expect(waiting).not.toContain('data-testid="onboarding-wizard-next"')

	const next = await renderToString(
		jsx(WizardNavigation, {
			activeStep: 1,
			onSelectStep() {},
			confirmUnconnectedNext: true,
		}),
	)
	expect(next).toContain('data-testid="onboarding-wizard-next"')
	expect(next).toContain('data-next-label="full"')
	expect(next).toContain('data-next-label="terse"')
	expect(next).toContain('@container wizardNav (max-width: 36rem)')
	expect(next).not.toContain('data-testid="onboarding-connect-wait"')
})
