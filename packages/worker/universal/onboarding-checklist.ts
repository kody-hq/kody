import { onboardingChecklistItemLabels } from '#universal/onboarding-process.ts'
import { type OnboardingChecklistLoaderData } from '#universal/loader-data.ts'

export function shouldShowOnboardingChecklist(
	checklist: OnboardingChecklistLoaderData | null | undefined,
): checklist is OnboardingChecklistLoaderData {
	if (!checklist || checklist.dismissed) return false
	return checklist.items.some((item) => !item.done)
}

export function getFirstUndoneChecklistItemLabel(
	checklist: OnboardingChecklistLoaderData,
): string | null {
	const undone = checklist.items.find((item) => !item.done)
	return undone ? onboardingChecklistItemLabels[undone.id] : null
}
