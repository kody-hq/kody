import { z } from 'zod'

const vaultItemConfigSchema = z.strictObject({
	kind: z.literal('vault-item'),
	bindingId: z.string().min(1),
	providerId: z.string().min(1),
	encryptedRef: z.string().min(1),
})

export function readVaultItemConfig(raw: string | null) {
	if (!raw) return null
	try {
		return vaultItemConfigSchema.safeParse(JSON.parse(raw)).data ?? null
	} catch {
		return null
	}
}
