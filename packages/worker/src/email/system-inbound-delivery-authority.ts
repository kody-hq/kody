import {
	claimSystemInboundDeliveryStorage as claimInboundDeliveryStorage,
	claimSystemInboundDeliveryWindow as claimInboundDeliveryWindow,
	markSystemInboundDeliveryReceived as markInboundDeliveryReceived,
	markSystemInboundDeliveryRejected as markInboundDeliveryRejected,
	pruneSystemExpiredInboundDedupePointers as pruneExpiredInboundDedupePointers,
	reconcileSystemStaleInboundDeliveries as reconcileStaleInboundDeliveries,
	releaseSystemInboundDeliveryStorage as releaseInboundDeliveryStorage,
} from './system-inbound-delivery-store.ts'
import type { InboundDelivery } from './inbound-delivery.ts'
import { systemEmailOwnerId } from './email-owner.ts'

function assertSystemInboundOwner(userId: string) {
	if (userId !== systemEmailOwnerId) {
		throw new Error(
			'Dedicated D1 inbound delivery mutations are restricted to system:email.',
		)
	}
}

function assertSystemInboundDelivery(delivery: InboundDelivery) {
	assertSystemInboundOwner(delivery.userId)
}

export async function claimSystemInboundDeliveryWindow(
	input: Parameters<typeof claimInboundDeliveryWindow>[0],
) {
	assertSystemInboundDelivery(input.delivery)
	return await claimInboundDeliveryWindow(input)
}

export async function claimSystemInboundDeliveryStorage(
	input: Parameters<typeof claimInboundDeliveryStorage>[0],
) {
	assertSystemInboundDelivery(input.delivery)
	return await claimInboundDeliveryStorage(input)
}

export async function releaseSystemInboundDeliveryStorage(
	input: Parameters<typeof releaseInboundDeliveryStorage>[0],
) {
	assertSystemInboundDelivery(input.delivery)
	return await releaseInboundDeliveryStorage(input)
}

export async function markSystemInboundDeliveryRejected(
	input: Parameters<typeof markInboundDeliveryRejected>[0],
) {
	assertSystemInboundDelivery(input.delivery)
	return await markInboundDeliveryRejected(input)
}

export async function markSystemInboundDeliveryReceived(
	input: Parameters<typeof markInboundDeliveryReceived>[0],
) {
	assertSystemInboundDelivery(input.delivery)
	return await markInboundDeliveryReceived(input)
}

export async function pruneSystemExpiredInboundDedupePointers(
	input: Parameters<typeof pruneExpiredInboundDedupePointers>[0],
) {
	return await pruneExpiredInboundDedupePointers(input)
}

export async function reconcileSystemStaleInboundDeliveries(
	input: Parameters<typeof reconcileStaleInboundDeliveries>[0],
) {
	return await reconcileStaleInboundDeliveries(input)
}
