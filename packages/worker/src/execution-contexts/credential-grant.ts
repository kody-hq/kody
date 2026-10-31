/**
 * Who a context run acts for (ADR 0083). Every run uses the requester's own
 * credentials exactly as in Kody cloud; credentialed requests leave from Kody
 * cloud, so values never reach the machine. The operator's own runs also get
 * the Kody APIs and workflows kept for Kody cloud.
 */
export function isOperatorContextRun(input: {
	operatorUserId: string
	requesterUserId: string
}) {
	return input.operatorUserId === input.requesterUserId
}
