import { type OnboardingPayload } from '#universal/onboarding-types.ts'
import {
	type AccountConnectionsLoaderData,
	type AccountProfileLoaderData,
} from '#universal/loader-data.ts'

export type AccountPagePayloads = {
	accountProfile: AccountProfileLoaderData
	accountConnections: AccountConnectionsLoaderData
	onboarding: OnboardingPayload | null
}
