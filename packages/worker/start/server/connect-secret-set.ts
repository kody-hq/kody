import { createServerFn } from '@tanstack/react-start'
import { connectSecretsSchema } from '../connect-input.ts'
export const loadConnectSecretSet = createServerFn({ method: 'GET' })
	.validator(connectSecretsSchema)
	.handler(async ({ data }) => {
		const { readConnectSecrets } = await import('./connect.ts')
		return readConnectSecrets('/connect/secret-set', data)
	})
