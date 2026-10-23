import { z } from 'zod'
import { packageAppCustomHostnameBindingKinds } from '#worker/package-app-custom-hostnames/types.ts'
import { packageAppCustomDomainStates } from '#universal/package-app-custom-domain-status.ts'

export const packageAppCustomHostnameDnsRecordSchema = z.object({
	type: z.string(),
	name: z.string(),
	value: z.string(),
})

export const packageAppCustomHostnameDnsHintSchema = z.object({
	type: z.literal('CNAME'),
	name: z.string(),
	target: z.string().nullable(),
})

export const packageAppCustomHostnameVerificationSchema = z.object({
	ownership_verification: packageAppCustomHostnameDnsRecordSchema.nullable(),
	ssl_validation_records: z.array(packageAppCustomHostnameDnsRecordSchema),
})

export const packageAppCustomHostnameSetupSchema = z
	.object({
		records: z
			.array(
				z.object({
					type: z.enum(['CNAME', 'TXT']),
					name: z.string().describe('Fully qualified record name.'),
					relative_name: z
						.string()
						.describe(
							'Record name without your domain (@ for the root). Most DNS provider forms want this.',
						),
					value: z.string(),
					proxy: z
						.literal('dns_only')
						.describe('Publish as DNS only. Proxied records never validate.'),
					purpose: z.enum(['routing', 'ownership', 'certificate']),
				}),
			)
			.describe('Every DNS record to publish, exactly as shown.'),
		steps: z.array(z.string()).describe('Plain step-by-step instructions.'),
		provider_notes: z
			.array(z.string())
			.describe('Short notes for common DNS providers.'),
	})
	.describe(
		'DNS records and steps to finish setup. Kody re-checks pending hostnames automatically.',
	)

export const packageAppCustomHostnameRowSchema = z.object({
	id: z.string(),
	hostname: z.string(),
	binding_kind: z.enum(packageAppCustomHostnameBindingKinds),
	package_id: z.string().nullable(),
	org_id: z.string().nullable(),
	hostname_status: z.string(),
	ssl_status: z.string(),
	verified_at: z.string().nullable(),
	dns_missing_since: z.string().nullable(),
	verification: packageAppCustomHostnameVerificationSchema,
	status: z
		.object({
			state: z.enum(packageAppCustomDomainStates),
			reason: z.string().nullable(),
		})
		.describe(
			'pending (Kody re-checks automatically), active, or needs_attention (Kody stopped re-checking; fix DNS and sync).',
		),
	needs_attention_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})
