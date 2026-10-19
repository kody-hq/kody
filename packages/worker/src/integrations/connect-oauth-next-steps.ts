import { buildConnectOauthWhatsNextPrompt } from '#universal/connect-oauth-whats-next.ts'
import {
	resolveIntegrationProviderName,
	type IntegrationProviderMetadata,
} from './provider-name.ts'

export type ConnectOauthNextSteps = {
	service: string
	connectionName: string
	prompt: string
}

export function buildConnectOauthNextSteps(input: {
	integrationName: string
	integration: IntegrationProviderMetadata
}): ConnectOauthNextSteps {
	const service = resolveIntegrationProviderName({
		...input.integration,
		name: input.integration.name || input.integrationName,
	})
	const connectionName = input.integrationName
	return {
		service,
		connectionName,
		prompt: buildConnectOauthWhatsNextPrompt({
			service,
			connectionName,
		}),
	}
}
