import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { buildCallerScopedIdempotencyKey } from '#mcp/capabilities/durable-escalation.ts'
import {
	buildExternalPublishIdempotencyParts,
	type ExternalPublishSemanticInput,
} from '#mcp/capabilities/packages/publish-external-push.ts'
import { publishProvenanceFromIdempotencyKey } from './workflow-projection.ts'

const semanticInput: ExternalPublishSemanticInput = {
	ownerUserId: ownerIdFromStored('owner-synthetic'),
	packageId: 'pkg-synthetic',
	newCommit: 'b'.repeat(40),
	allowForce: false,
	destructiveOverwriteConfirmed: false,
}
const userId = ownerIdFromStored('user-synthetic')

test('publishProvenanceFromIdempotencyKey reads the current v3 publish key', () => {
	const key = buildCallerScopedIdempotencyKey({
		userId,
		parts: buildExternalPublishIdempotencyParts(semanticInput),
	})
	expect(publishProvenanceFromIdempotencyKey(key)).toEqual({
		packageId: 'pkg-synthetic',
		commit: 'b'.repeat(40),
	})
})

test.each([[], ['v2']])(
	'publishProvenanceFromIdempotencyKey reads legacy publish keys (%j)',
	(...version) => {
		const key = buildCallerScopedIdempotencyKey({
			userId,
			parts: [
				'packagePublishExternalPush',
				...version,
				canonicalJsonStringify(semanticInput),
			],
		})
		expect(publishProvenanceFromIdempotencyKey(key)).toEqual({
			packageId: 'pkg-synthetic',
			commit: 'b'.repeat(40),
		})
	},
)

test('publishProvenanceFromIdempotencyKey ignores released and unrelated keys', () => {
	expect(publishProvenanceFromIdempotencyKey('released:dynwf-synthetic')).toBe(
		null,
	)
	expect(publishProvenanceFromIdempotencyKey('user-1:other-op:{}')).toBe(null)
	expect(
		publishProvenanceFromIdempotencyKey(
			'user-1:packagePublishExternalPush:v2:not-json',
		),
	).toBe(null)
	expect(
		publishProvenanceFromIdempotencyKey(
			'user-1:packagePublishExternalPush:{"packageId":"pkg-1"}',
		),
	).toBe(null)
})
