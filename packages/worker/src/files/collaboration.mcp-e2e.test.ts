import { expect, test } from 'vitest'
import {
	createUniqueTestUser,
	createMcpClient,
	getSharedMcpE2eServer,
} from '../../../../tools/mcp-test-support.ts'

test('an authenticated agent creates, edits, and comments on the same durable file through execute', async () => {
	const server = await getSharedMcpE2eServer(),
		user = createUniqueTestUser()
	await using connection = await createMcpClient(server.origin, user, {
		ensureUser: async (user) => {
			await server.ensureUser(user)
			await server.seedFileWorkspace(user.email)
		},
		markEmailVerified: server.markEmailVerified,
		clearAuthRateLimits: server.clearAuthRateLimits,
	})
	const result = await connection.client.callTool({
		name: 'execute',
		arguments: {
			code: `import {kody} from 'kody:runtime'
export default async function main() {
 const fileId=crypto.randomUUID(),writeId=crypto.randomUUID()
 const created=[]
 try {
  await kody.fileCreate({file_id:fileId,write_id:writeId,name:'Agent collaboration.txt',media_type:'text/plain',content:'Draft'})
  created.push(fileId)
  const original=await kody.fileGet({file_id:fileId})
  const updated=await kody.fileWrite({file_id:fileId,write_id:crypto.randomUUID(),base_revision_id:original.file.headVersion ?? original.file.revisionId,content:'Reviewed draft'})
  if(!updated.ok) throw new Error('Unexpected revision conflict')
  const discussion=await kody.fileComment({file_id:fileId,command:{kind:'create',operationId:crypto.randomUUID(),threadId:crypto.randomUUID(),commentId:crypto.randomUUID(),anchor:{kind:'file'},body:'Agent review complete'}})
  const shared=await kody.fileCollaborationGet({file_id:fileId})
  const anchors=[]
  for(const [name,media_type,content,anchor] of [
   ['review.wav','audio/wav','UklGRgAAAAA=',{kind:'audio',timeMs:0}],
   ['review.png','image/png','iVBORw0KGgo=',{kind:'image',x:0.25,y:0.75}],
   ['review.json','application/json','{"items":[1]}',{kind:'json',pointer:'/items/0'}],
   ['review.csv','text/csv','Name,Status\\nExample,Ready',{kind:'csv',row:1,column:1}],
  ]) {
   const id=crypto.randomUUID()
   await kody.fileCreate({file_id:id,write_id:crypto.randomUUID(),name,media_type,content,...(anchor.kind==='audio'||anchor.kind==='image'?{encoding:'base64'}:{})})
   created.push(id)
   const snapshot=await kody.fileCollaborationGet({file_id:id})
   const command={kind:'create',operationId:crypto.randomUUID(),threadId:crypto.randomUUID(),commentId:crypto.randomUUID(),anchor:{...anchor,revisionId:snapshot.revisionId},body:'Agent anchor'}
   await kody.fileComment({file_id:id,command})
   if(anchor.kind==='json') {
    const replacement=await kody.fileWrite({file_id:id,write_id:crypto.randomUUID(),base_revision_id:snapshot.revisionId,content:'{}'})
    if(!replacement.ok) throw new Error('Unexpected JSON revision conflict')
    const retry=await kody.fileComment({file_id:id,command})
    if(retry.threads.length!==1||!retry.threads[0].outdated) throw new Error('Comment retry should return the original, now outdated thread')
   }
   const saved=await kody.fileCollaborationGet({file_id:id})
   anchors.push(saved.threads[0].anchor.kind)
  }
  return {anchors,body:updated.file.content,actor:shared.actor.kind,comments:discussion.comments.length,author:discussion.comments[0].author.kind,sequence:shared.sequence}
 } finally { for(const id of created) await kody.fileDelete({file_id:id}) }
}`,
		},
	})
	expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
	const structured = result.structuredContent as {
		error?: unknown
		result?: unknown
	}
	expect(structured.error).toBeUndefined()
	expect(structured.result).toMatchObject({
		anchors: ['audio', 'image', 'json', 'csv'],
		body: 'Reviewed draft',
		actor: 'agent',
		comments: 1,
		author: 'agent',
	})
})
