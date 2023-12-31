import { json, type DataFunctionArgs } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'
import { NoteEditor } from '~/routes/resources+/note-editor.tsx'
import { requireUserId } from '~/utils/auth.server.ts'
import { prisma } from '~/utils/db.server.ts'

export async function loader({ params, request }: DataFunctionArgs) {
	const userId = await requireUserId(request)
	const note = await prisma.note.findFirst({
		where: {
			id: params.noteId,
			ownerId: userId,
		},
		select: {
			id: true,
			title: true,
			content: true,
			images: {
				select: {
					fileId: true,
					altText: true,
				},
			},
		},
	})
	if (!note) {
		throw new Response('Not found', { status: 404 })
	}
	return json({ note })
}

export default function NoteEdit() {
	const data = useLoaderData<typeof loader>()

	return (
		<div className="absolute inset-0">
			<NoteEditor note={data.note} />
		</div>
	)
}
