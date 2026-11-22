import { Schema } from 'effect'
import type { PublishBuildStatus as PublishBuildStatusType } from './publish-build-state.ts'

export const PublishBuildStatus = Schema.Literals([
	'uploading',
	'sealed',
	'committed',
	'rejected',
	'abandoned',
])

/** Fails to compile when the state machine gains or loses a state. */
export const publishBuildStatusesMatchStateMachine: [
	PublishBuildStatusType,
	typeof PublishBuildStatus.Type,
] extends [typeof PublishBuildStatus.Type, PublishBuildStatusType]
	? true
	: never = true

export const PublishBuildOrigin = Schema.Literals(['cloud', 'cli', 'context'])

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const PublishBuildFileEntry = Schema.Struct({
	path: Schema.String,
	size: Schema.Finite,
	sha256: Schema.String,
})

export const PublishBuildModuleEntry = Schema.Struct({
	sha256: Schema.String,
	size: Schema.Finite,
	/** Content-addressed chunks (sha256 hex), in order, that make the module. */
	chunks: Schema.Array(Sha256Hex),
})

export const PublishBuildTargetEntry = Schema.Struct({
	kind: Schema.String,
	bundleKind: Schema.Literals([
		'app',
		'app-client',
		'module',
		'importable-module',
	]),
	artifactName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	entryPoint: Schema.String,
	mainModule: Schema.String,
	modules: Schema.Record(Schema.String, PublishBuildModuleEntry),
})

/**
 * The shape a sealed build document must have before it is stored. The
 * content checks (hashes, sizes, the file set, imports) run at publish time
 * in `verify.ts`.
 */
export const PublishBuildDocument = Schema.Struct({
	builderVersion: Schema.Finite,
	commit: Schema.String,
	files: Schema.Array(PublishBuildFileEntry),
	targets: Schema.Array(PublishBuildTargetEntry),
	/** Builder timing, shown to the publisher; never trusted. */
	buildMs: Schema.optionalKey(Schema.Finite),
})

export const PublishBuildDocumentJson =
	Schema.fromJsonString(PublishBuildDocument)

export const PublishBuildRow = Schema.Struct({
	id: Schema.String,
	package_id: Schema.String,
	source_id: Schema.String,
	owner_user_id: Schema.String,
	requester_user_id: Schema.String,
	org_id: Schema.String,
	commit_sha: Schema.String,
	origin: PublishBuildOrigin,
	context_id: Schema.NullOr(Schema.String),
	context_name: Schema.NullOr(Schema.String),
	ticket_sha256: Schema.String,
	status: PublishBuildStatus,
	document_sha256: Schema.NullOr(Schema.String),
	message: Schema.NullOr(Schema.String),
	created_at: Schema.String,
	updated_at: Schema.String,
	expires_at: Schema.String,
	committed_at: Schema.NullOr(Schema.String),
})
