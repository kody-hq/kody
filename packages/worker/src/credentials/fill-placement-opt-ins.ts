/**
 * Per-credential owner opt-in for filling into the query, URL path, or body
 * (`credential_fill_placement_opt_ins`). The host may store a value sent
 * there, so placement enforcement honors those parts only when opted in.
 */
import { type CredentialFillPlacement } from './fill-placement.ts'

export const optInFillPlacementParts = ['query', 'path', 'body'] as const

export type OptInFillPlacementPart = (typeof optInFillPlacementParts)[number]

export type FillPlacementOptIn = Record<OptInFillPlacementPart, boolean>

export const noFillPlacementOptIn: FillPlacementOptIn = {
	query: false,
	path: false,
	body: false,
}

/** True when `placement` lists a part that needs an owner opt-in. */
export function placementNeedsOptIn(placement: CredentialFillPlacement | null) {
	return (
		placement === null ||
		optInFillPlacementParts.some((part) => placement[part] === true)
	)
}

export async function readFillPlacementOptIn(
	db: D1Database,
	credentialId: string,
): Promise<FillPlacementOptIn> {
	const row = await db
		.prepare(
			`SELECT query, path, body FROM credential_fill_placement_opt_ins
			 WHERE credential_id = ?`,
		)
		.bind(credentialId)
		.first<{ query: number; path: number; body: number }>()
	if (!row) return noFillPlacementOptIn
	return { query: row.query === 1, path: row.path === 1, body: row.body === 1 }
}

/** The query, path, and body parts `placement` lists. Null (anywhere) lists all three. */
export function fillPlacementOptInFromPlacement(
	placement: CredentialFillPlacement | null,
): FillPlacementOptIn {
	return {
		query: placement === null || placement.query === true,
		path: placement === null || placement.path === true,
		body: placement === null || placement.body === true,
	}
}

/** One statement that saves `optIn` as the owner's (deleting the row when empty). */
export function ownerFillPlacementOptInStatement(input: {
	db: D1Database
	credentialId: string
	optIn: FillPlacementOptIn
	at?: string
}) {
	const { optIn } = input
	if (!optIn.query && !optIn.path && !optIn.body) {
		return input.db
			.prepare(
				`DELETE FROM credential_fill_placement_opt_ins WHERE credential_id = ?`,
			)
			.bind(input.credentialId)
	}
	return input.db
		.prepare(
			`INSERT INTO credential_fill_placement_opt_ins (
				credential_id, query, path, body, source, updated_at
			) VALUES (?, ?, ?, ?, 'owner', ?)
			ON CONFLICT(credential_id) DO UPDATE SET
				query = excluded.query,
				path = excluded.path,
				body = excluded.body,
				source = excluded.source,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.credentialId,
			optIn.query ? 1 : 0,
			optIn.path ? 1 : 0,
			optIn.body ? 1 : 0,
			input.at ?? new Date().toISOString(),
		)
}

/**
 * Records the owner's opt-in from the website: exactly the query, path, and
 * body parts `placement` lists.
 */
export async function recordOwnerFillPlacementOptIn(input: {
	db: D1Database
	credentialId: string
	placement: CredentialFillPlacement | null
	at?: string
}) {
	await ownerFillPlacementOptInStatement({
		db: input.db,
		credentialId: input.credentialId,
		optIn: fillPlacementOptInFromPlacement(input.placement),
		...(input.at ? { at: input.at } : {}),
	}).run()
}
