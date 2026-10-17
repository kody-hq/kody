import {
	createEmailInbox,
	createEmailInboxAddress,
	deleteEmailInboxAddressById,
	ensurePlatformSenderIdentity,
	getEmailInboxAddressByAddress,
	getEmailInboxById,
	getEmailInboxByName,
} from './repo.ts'
import { buildPlatformEmailAddress } from './platform-address.ts'
import { type EmailInboxAddressRecord, type EmailInboxRecord } from './types.ts'

export const defaultEmailInboxName = 'default'

export type ProvisionedDefaultInbox = {
	inbox: EmailInboxRecord
	address: EmailInboxAddressRecord
}

/**
 * Ensure the user's automatic default inbox at `{username}@<platform domain>`
 * exists, together with the platform-assigned verified sender identity for
 * the same address (there is no user-facing sender verification).
 * Idempotent and race-tolerant: signup provisioning and first-inbound
 * provisioning may run concurrently, so each insert falls back to re-reading
 * the row another writer created. If a platform address still belongs to the
 * username's prior owner, the stale address row is reclaimed for the current
 * owner without moving the prior owner's inbox or messages.
 */
export async function ensureDefaultEmailInbox(input: {
	db: D1Database
	// Mailbox owner, which may differ from the person who owns sender identities.
	userId: string
	actorPersonId: string
	username: string
	domain: string
}): Promise<ProvisionedDefaultInbox | null> {
	const address = buildPlatformEmailAddress({
		username: input.username,
		domain: input.domain,
	})
	await ensurePlatformSenderIdentity({
		db: input.db,
		userId: input.actorPersonId,
		email: address,
		domain: input.domain,
	})

	const readExisting = async () => {
		const existingAddress = await getEmailInboxAddressByAddress({
			db: input.db,
			address,
		})
		if (!existingAddress) return null
		// Usernames are unique, so the platform address canonically belongs
		// to whoever holds the username now. A row owned by a different user
		// is stale (left behind by a username change); reclaim it so the
		// current owner can receive. The old owner keeps their inbox and
		// stored messages — only the routable address row moves.
		if (existingAddress.userId !== input.userId) {
			await deleteEmailInboxAddressById({
				db: input.db,
				addressId: existingAddress.id,
			})
			return null
		}
		// The user's own disabled row was deliberately turned off; keep the
		// address unavailable instead of silently re-enabling it.
		if (!existingAddress.enabled) {
			return { conflict: true as const }
		}
		const inbox = await getEmailInboxById({
			db: input.db,
			userId: input.userId,
			id: existingAddress.inboxId,
		})
		if (!inbox) return { conflict: true as const }
		return { conflict: false as const, inbox, address: existingAddress }
	}

	const existing = await readExisting()
	if (existing) {
		return existing.conflict
			? null
			: { inbox: existing.inbox, address: existing.address }
	}

	let inbox = await getEmailInboxByName({
		db: input.db,
		userId: input.userId,
		name: defaultEmailInboxName,
	})
	if (!inbox) {
		try {
			inbox = await createEmailInbox({
				db: input.db,
				userId: input.userId,
				name: defaultEmailInboxName,
				description: `Automatic inbox for ${address}`,
			})
		} catch (error) {
			inbox = await getEmailInboxByName({
				db: input.db,
				userId: input.userId,
				name: defaultEmailInboxName,
			})
			if (!inbox) throw error
		}
	}

	try {
		const created = await createEmailInboxAddress({
			db: input.db,
			inboxId: inbox.id,
			userId: input.userId,
			address,
			localPart: input.username.trim().toLowerCase(),
			domain: input.domain,
		})
		return { inbox, address: created }
	} catch (error) {
		const raced = await readExisting()
		if (raced) {
			return raced.conflict
				? null
				: { inbox: raced.inbox, address: raced.address }
		}
		throw error
	}
}
