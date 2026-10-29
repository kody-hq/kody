// Type-only contracts stay separate from the runtime schema constructors.
export type ConnectSecretsInput = import('zod').infer<
	typeof import('./connect-input-schema.ts').connectSecretsSchema
>
export type ConnectOauthInput = import('zod').infer<
	typeof import('./connect-input-schema.ts').connectOauthSchema
>
export type ConnectWebhookInput = import('zod').infer<
	typeof import('./connect-input-schema.ts').connectWebhookSchema
>
