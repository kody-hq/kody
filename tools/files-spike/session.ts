import * as Y from 'yjs'
import {
	byteLength,
	checksum,
	documentLimits,
	toBase64,
	type DurableDocument,
	type Principal,
	type DocumentPatch,
	type Revision,
} from './contracts.ts'
import {
	applyDocumentPatch,
	candidateDocument,
	DocumentFailure,
} from './document.ts'
import { revisionKey, verifyRevision, type ObjectStore } from './storage.ts'

type Persistence = {
	get<T>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
	delete(key: string): Promise<unknown>
}
export type SessionEvent = {
	type: 'update'
	update: string
	version: number
	author: string
}

/** Callers serialize operations. No acknowledged state is held only in memory. */
export class DocumentSession {
	private persistence: Persistence
	private stores: (location: 'included' | 'external') => ObjectStore
	private broadcast: (event: SessionEvent) => void
	constructor(
		persistence: Persistence,
		stores: (location: 'included' | 'external') => ObjectStore,
		broadcast: (event: SessionEvent) => void,
	) {
		this.persistence = persistence
		this.stores = stores
		this.broadcast = broadcast
	}

	async load() {
		const state = await this.persistence.get<DurableDocument>('document')
		if (!state) throw new DocumentFailure('not_found', 'File not found.', 404)
		return state
	}

	canRead(state: DurableDocument, principal: Principal) {
		return (
			state.file.orgId === principal.orgId &&
			(state.file.owner === principal.personId ||
				Boolean(state.file.grants[principal.personId]))
		)
	}
	private authorize(
		state: DurableDocument,
		principal: Principal,
		action: 'view' | 'edit' | 'manage',
	) {
		if (!this.canRead(state, principal))
			throw new DocumentFailure('not_found', 'File not found.', 404)
		const owner = state.file.owner === principal.personId
		if (
			(action === 'manage' && !owner) ||
			(action === 'edit' &&
				!owner &&
				state.file.grants[principal.personId] !== 'edit')
		)
			throw new DocumentFailure(
				'forbidden',
				'You do not have permission to change this file.',
				403,
			)
	}

	async initialize(
		principal: Principal,
		id: string,
		name: string,
		grants: Record<string, 'edit' | 'view'>,
		ownerPersonId = principal.personId,
	) {
		if (await this.persistence.get('document'))
			throw new DocumentFailure('exists', 'File already exists.', 409)
		const doc = new Y.Doc()
		doc.getText('content').insert(0, `# ${name}\n\n`)
		const state: DurableDocument = {
			file: {
				id,
				name,
				orgId: principal.orgId,
				owner: ownerPersonId,
				grants,
				location: 'included',
				previousLocation: null,
				revisions: [],
				createdAt: new Date().toISOString(),
			},
			state: Y.encodeStateAsUpdate(doc),
			version: 0,
		}
		doc.destroy()
		await this.persistence.put('document', state)
		await this.checkpoint(principal)
		return this.view(principal)
	}

	async view(principal: Principal) {
		const state = await this.load()
		this.authorize(state, principal, 'view')
		const doc = candidateDocument(state.state)
		let storageAvailable = true
		try {
			await this.verifyCurrent(state)
		} catch {
			storageAvailable = false
		}
		const content = doc.getText('content').toString()
		doc.destroy()
		return {
			id: state.file.id,
			name: state.file.name,
			version: state.version,
			content,
			state: toBase64(state.state),
			storageAvailable,
			canEdit:
				storageAvailable &&
				(state.file.owner === principal.personId ||
					state.file.grants[principal.personId] === 'edit'),
			canManage: state.file.owner === principal.personId,
			access:
				state.file.owner === principal.personId ? state.file.grants : null,
			revisions: state.file.revisions,
		}
	}

	private async verifyCurrent(state: DurableDocument) {
		const revision = state.file.revisions.at(-1)
		if (revision)
			await verifyRevision(
				this.stores(state.file.location),
				state.file,
				revision,
			)
	}

	private async commit(
		state: DurableDocument,
		candidate: Y.Doc,
		author: string,
	) {
		const update = Y.encodeStateAsUpdate(candidate)
		const difference = Y.diffUpdate(
			update,
			Y.encodeStateVectorFromUpdate(state.state),
		)
		const next = { ...state, state: update, version: state.version + 1 }
		await this.persistence.put('document', next)
		this.broadcast({
			type: 'update',
			update: toBase64(difference),
			version: next.version,
			author,
		})
		return { ok: true as const, version: next.version }
	}

	async update(principal: Principal, update: Uint8Array) {
		const state = await this.load()
		this.authorize(state, principal, 'edit')
		await this.verifyCurrent(state)
		const candidate = candidateDocument(state.state, update)
		try {
			return await this.commit(state, candidate, principal.name)
		} finally {
			candidate.destroy()
		}
	}

	async patch(principal: Principal, patch: DocumentPatch) {
		const state = await this.load()
		this.authorize(state, principal, 'edit')
		await this.verifyCurrent(state)
		const candidate = candidateDocument(state.state)
		try {
			const result = applyDocumentPatch(candidate, state.version, patch)
			return result.ok
				? await this.commit(state, candidate, principal.name)
				: result
		} finally {
			candidate.destroy()
		}
	}

	async checkpoint(principal: Principal) {
		const state = await this.load()
		this.authorize(state, principal, 'edit')
		await this.verifyCurrent(state)
		const doc = candidateDocument(state.state)
		const content = doc.getText('content').toString()
		doc.destroy()
		const sha256 = await checksum(content)
		const previous = state.file.revisions.at(-1)
		if (previous?.sha256 === sha256) return previous
		if (state.file.previousLocation)
			throw new DocumentFailure(
				'move_pending',
				'Finish the storage move before saving a checkpoint.',
				409,
			)
		if (
			state.file.revisions.length >= documentLimits.revisions ||
			state.file.revisions.reduce(
				(total, revision) => total + revision.bytes,
				0,
			) +
				byteLength(content) >
				documentLimits.historyBytes
		)
			throw new DocumentFailure(
				'history_limit',
				'This spike has reached its history allowance. Export the file before continuing.',
				413,
			)
		const pending = await this.persistence.get<{
			key: string
			location: 'included' | 'external'
		}>('pending-revision')
		if (
			pending &&
			!state.file.revisions.some(
				(revision) => revisionKey(state.file, revision.id) === pending.key,
			)
		)
			await this.stores(pending.location).delete(pending.key)
		const revision: Revision = {
			id: crypto.randomUUID(),
			createdAt: new Date().toISOString(),
			author: principal.name,
			bytes: byteLength(content),
			sha256,
		}
		const key = revisionKey(state.file, revision.id)
		await this.persistence.put('pending-revision', {
			key,
			location: state.file.location,
		})
		await this.stores(state.file.location).put(key, content)
		await verifyRevision(this.stores(state.file.location), state.file, revision)
		await this.persistence.put('document', {
			...state,
			file: { ...state.file, revisions: [...state.file.revisions, revision] },
		})
		await this.persistence.delete('pending-revision')
		return revision
	}

	async revision(principal: Principal, id: string) {
		const state = await this.load()
		this.authorize(state, principal, 'view')
		const revision = state.file.revisions.find((item) => item.id === id)
		if (!revision)
			throw new DocumentFailure('not_found', 'Revision not found.', 404)
		return {
			...revision,
			content: await verifyRevision(
				this.stores(state.file.location),
				state.file,
				revision,
			),
		}
	}

	async inspect(principal: Principal) {
		const state = await this.load()
		this.authorize(state, principal, 'manage')
		return {
			location: state.file.location,
			recoveryCopy: state.file.previousLocation,
			historyBytes: state.file.revisions.reduce(
				(total, revision) => total + revision.bytes,
				0,
			),
			stateBytes: state.state.byteLength,
		}
	}

	async migrate(principal: Principal, target: 'included' | 'external') {
		let state = await this.load()
		this.authorize(state, principal, 'manage')
		if (state.file.location === target) return { ok: true }
		if (state.file.previousLocation)
			throw new DocumentFailure(
				'move_pending',
				'Finish the previous storage move first.',
				409,
			)
		await this.checkpoint(principal)
		state = await this.load()
		const source = this.stores(state.file.location)
		const destination = this.stores(target)
		// An intent survives an interrupted copy. Keys are immutable and retries overwrite the same bytes.
		await this.persistence.put('migration-target', target)
		for (const revision of state.file.revisions) {
			const content = await verifyRevision(source, state.file, revision)
			await destination.put(revisionKey(state.file, revision.id), content)
			await verifyRevision(destination, state.file, revision)
		}
		await this.persistence.put('document', {
			...state,
			file: {
				...state.file,
				location: target,
				previousLocation: state.file.location,
			},
		})
		await this.persistence.delete('migration-target')
		return { ok: true }
	}

	async finishMove(principal: Principal) {
		const state = await this.load()
		this.authorize(state, principal, 'manage')
		if (!state.file.previousLocation) return { ok: true }
		for (const revision of state.file.revisions) {
			await verifyRevision(
				this.stores(state.file.location),
				state.file,
				revision,
			)
			await this.stores(state.file.previousLocation).delete(
				revisionKey(state.file, revision.id),
			)
		}
		await this.persistence.put('document', {
			...state,
			file: { ...state.file, previousLocation: null },
		})
		return { ok: true }
	}

	async grant(
		principal: Principal,
		personId: string,
		role: 'view' | 'edit' | null,
	) {
		const state = await this.load()
		this.authorize(state, principal, 'manage')
		if (personId === state.file.owner)
			throw new DocumentFailure('owner_grant', 'The owner cannot be removed.')
		const grants = { ...state.file.grants }
		if (role) grants[personId] = role
		else delete grants[personId]
		await this.persistence.put('document', {
			...state,
			file: { ...state.file, grants },
		})
		return { ok: true }
	}

	async export(principal: Principal) {
		const state = await this.load()
		this.authorize(state, principal, 'view')
		const doc = candidateDocument(state.state)
		const content = doc.getText('content').toString()
		doc.destroy()
		const history = []
		for (const revision of state.file.revisions)
			history.push(await this.revision(principal, revision.id))
		return {
			id: state.file.id,
			name: state.file.name,
			content,
			version: state.version,
			history,
		}
	}

	async purge(principal: Principal) {
		const state = await this.load()
		this.authorize(state, principal, 'manage')
		const target = await this.persistence.get<'included' | 'external'>(
			'migration-target',
		)
		const locations = new Set(
			[state.file.location, state.file.previousLocation, target].filter(
				(value) => value != null,
			),
		)
		for (const location of locations)
			for (const revision of state.file.revisions)
				await this.stores(location).delete(revisionKey(state.file, revision.id))
		const pending = await this.persistence.get<{
			key: string
			location: 'included' | 'external'
		}>('pending-revision')
		if (pending) await this.stores(pending.location).delete(pending.key)
		await this.persistence.delete('document')
		await this.persistence.delete('pending-revision')
		await this.persistence.delete('migration-target')
		return { ok: true }
	}
}
