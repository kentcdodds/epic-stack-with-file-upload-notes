import {
	conform,
	list,
	useFieldList,
	useFieldset,
	useForm,
	type FieldConfig,
} from '@conform-to/react'
import { getFieldsetConstraint, parse } from '@conform-to/zod'
import {
	json,
	unstable_composeUploadHandlers,
	unstable_createFileUploadHandler,
	unstable_createMemoryUploadHandler,
	unstable_parseMultipartFormData,
	type DataFunctionArgs,
} from '@remix-run/node'
import { useFetcher, useLocation } from '@remix-run/react'
import fs from 'node:fs'
import { useRef } from 'react'
import { ServerOnly } from 'remix-utils'
import { z } from 'zod'
import { floatingToolbarClassName } from '~/components/floating-toolbar.tsx'
import { ErrorList, Field, TextareaField } from '~/components/forms.tsx'
import { Button } from '~/components/ui/button.tsx'
import { Icon } from '~/components/ui/icon.tsx'
import { Input } from '~/components/ui/input.tsx'
import { Label } from '~/components/ui/label.tsx'
import { StatusButton } from '~/components/ui/status-button.tsx'
import { requireUserId } from '~/utils/auth.server.ts'
import { prisma } from '~/utils/db.server.ts'
import { redirectWithToast } from '~/utils/flash-session.server.ts'

const MAX_UPLOAD_SIZE = 1024 * 1024 * 3 // 3MB

// 👋 I'd love to not have to have two separate schemas for client and server
// but the client schema needs to be able to handle File objects and the server
// schema needs to be able to handle the file upload data post-processing.
// I'm not sure how to resolve this.
const ClientImageFieldsetSchema = z.object({
	image: z.instanceof(File),
	altText: z.string().optional(),
})
const ServerImageFieldsetSchema = z.object({
	image: z.object({
		filepath: z.string(),
		type: z.string(),
		name: z.string(),
	}),
	altText: z.string().optional(),
})

const BaseNoteEditorSchema = z.object({
	id: z.string().optional(),
	title: z.string().min(1).max(100),
	content: z.string().min(1).max(10_000),
})

const ClientNoteEditorSchema = BaseNoteEditorSchema.extend({
	images: z.array(ClientImageFieldsetSchema),
})
const ServerNoteEditorSchema = BaseNoteEditorSchema.extend({
	images: z.array(ServerImageFieldsetSchema),
})

export async function action({ request }: DataFunctionArgs) {
	const userId = await requireUserId(request)
	const uploadHandler = unstable_composeUploadHandlers(
		unstable_createFileUploadHandler({ maxPartSize: MAX_UPLOAD_SIZE }),
		// parse everything else into memory
		unstable_createMemoryUploadHandler(),
	)
	const formData = await unstable_parseMultipartFormData(request, uploadHandler)

	const submission = parse(formData, {
		schema: ServerNoteEditorSchema,
		acceptMultipleErrors: () => true,
	})
	if (submission.intent !== 'submit') {
		return json({ status: 'idle', submission } as const)
	}
	if (!submission.value) {
		return json(
			{
				status: 'error',
				submission,
			} as const,
			{ status: 400 },
		)
	}
	let note: { id: string; owner: { username: string } }

	const { title, content, id, images } = submission.value

	const data = {
		ownerId: userId,
		title: title,
		content: content,
	}

	const select = {
		id: true,
		owner: {
			select: {
				username: true,
			},
		},
	}

	if (id) {
		const existingNote = await prisma.note.findFirst({
			where: { id, ownerId: userId },
			select: { id: true },
		})
		if (!existingNote) {
			return json(
				{
					status: 'error',
					submission,
				} as const,
				{ status: 404 },
			)
		}
		note = await prisma.note.update({
			where: { id },
			data,
			select,
		})
	} else {
		note = await prisma.note.create({ data, select })
	}

	for (const { image, altText } of images ?? []) {
		const file = await prisma.file.create({
			data: {
				blob: await fs.promises.readFile(image.filepath),
			},
			select: { id: true },
		})
		await prisma.image.create({
			data: {
				contentType: image.type,
				noteId: note.id,
				altText: altText ?? null,
				fileId: file.id,
			},
		})
	}

	return redirectWithToast(`/users/${note.owner.username}/notes/${note.id}`, {
		title: id ? 'Note updated' : 'Note created',
	})
}

export function NoteEditor({
	note,
}: {
	note?: {
		id: string
		title: string
		content: string
		images: Array<{ fileId: string; altText?: string | null }>
	}
}) {
	const noteEditorFetcher = useFetcher<typeof action>()

	const [form, fields] = useForm({
		id: 'note-editor',
		constraint: getFieldsetConstraint(ClientNoteEditorSchema),
		lastSubmission: noteEditorFetcher.data?.submission,
		onValidate({ formData }) {
			return parse(formData, { schema: ClientNoteEditorSchema })
		},
		defaultValue: {
			id: note?.id,
			title: note?.title,
			content: note?.content,
			images: [],
		},
		shouldRevalidate: 'onBlur',
	})
	const imageList = useFieldList(form.ref, fields.images)

	return (
		<>
			<noteEditorFetcher.Form
				method="post"
				action="/resources/note-editor"
				encType="multipart/form-data"
				{...form.props}
			/>
			<div className="flex h-full flex-col gap-y-4 overflow-y-auto overflow-x-hidden px-10 pb-28 pt-12">
				{/*
					This hidden submit button is here to ensure that when the user hits
					"enter" on an input field, the primary form function is submitted
					rather than the first button in the form (which is delete/add image).
				*/}
				<button form="note-editor" type="submit" className="hidden" />
				<input {...conform.input(fields.id)} type="hidden" />
				<Field
					labelProps={{ children: 'Title' }}
					inputProps={{
						...conform.input(fields.title),
						autoFocus: true,
					}}
					errors={fields.title.errors}
					className="flex flex-col gap-y-2"
				/>
				<TextareaField
					labelProps={{ children: 'Content' }}
					textareaProps={{
						...conform.textarea(fields.content),
						className: 'flex-1 resize-none',
					}}
					errors={fields.content.errors}
					className="flex flex-1 flex-col gap-y-2"
				/>
				{note?.images.length ? (
					<div>
						<Label htmlFor="note-images">Images</Label>
						<ul id="note-images" className="flex flex-wrap gap-5 py-5">
							{note.images.map(image => (
								<li key={image.fileId}>
									<ImageDeleter image={image} />
								</li>
							))}
						</ul>
					</div>
				) : null}
				<ul>
					{imageList.map((image, index) => (
						<li key={image.key}>
							<ImageChooser config={image} />
							{/* 👋 I don't think I should have to specify this form prop. It should come from list.remove */}
							<button
								form="note-editor"
								{...list.remove(fields.images.name, { index })}
							>
								Delete
							</button>
						</li>
					))}
				</ul>
				{/* 👋 I don't think I should have to specify this form prop. It should come from list.append */}
				<button form="note-editor" {...list.append(fields.images.name)}>
					Add Image
				</button>
				<ErrorList errors={form.errors} id={form.errorId} />
			</div>
			<div className={floatingToolbarClassName}>
				<Button
					form="note-editor"
					variant="destructive"
					type="reset"
					className="min-[525px]:max-md:aspect-square min-[525px]:max-md:px-0"
				>
					<Icon name="reset" className="scale-125 max-md:scale-150 md:mr-2" />
					<span className="max-md:hidden">Reset</span>
				</Button>
				<StatusButton
					form="note-editor"
					status={
						noteEditorFetcher.state === 'submitting'
							? 'pending'
							: noteEditorFetcher.data?.status ?? 'idle'
					}
					type="submit"
					disabled={noteEditorFetcher.state !== 'idle'}
					className="min-[525px]:max-md:aspect-square min-[525px]:max-md:px-0"
				>
					<Icon
						name="arrow-right"
						className="scale-125 max-md:scale-150 md:mr-2"
					/>
					<span className="max-md:hidden">Submit</span>
				</StatusButton>
			</div>
		</>
	)
}

function ImageDeleter({
	image,
}: {
	image: { fileId: string; altText?: string | null }
}) {
	const fetcher = useFetcher()
	const location = useLocation()

	return (
		<fetcher.Form method="POST" action="/resources/delete-image">
			<input type="hidden" name="imageId" value={image.fileId} />
			<ServerOnly>
				{() => (
					<input type="hidden" name="redirectTo" value={location.pathname} />
				)}
			</ServerOnly>
			<button type="submit" name="intent" value="delete">
				{fetcher.state === 'submitting' ? '🌀' : '❌'}
				<img
					src={`/resources/file/${image.fileId}`}
					alt={image.altText ?? ''}
					className="h-32 w-32 rounded-lg object-cover"
				/>
			</button>
		</fetcher.Form>
	)
}

function ImageChooser({
	config,
}: {
	config: FieldConfig<z.infer<typeof ClientImageFieldsetSchema>>
}) {
	const ref = useRef<HTMLFieldSetElement>(null)
	const { altText, image } = useFieldset(ref, config)

	return (
		<fieldset ref={ref}>
			<div>
				<Label htmlFor="note-photo">Photo</Label>
				<Input
					id="note-photo"
					{...conform.input(image, { ariaAttributes: true })}
					type="file"
				/>
				<div className="min-h-[32px] px-4 pb-3 pt-1">
					{/* 👋 these errors don't appear to be rendering. Try submitting with no file selection. */}
					<ErrorList id={image.errorId} errors={image.errors} />
				</div>
			</div>
			<div>
				<Label htmlFor="note-photo-alt">Alt Text</Label>
				<Input
					id="note-photo-alt"
					{...conform.input(altText, { ariaAttributes: true })}
				/>
				<div className="min-h-[32px] px-4 pb-3 pt-1">
					<ErrorList id={altText.errorId} errors={altText.errors} />
				</div>
			</div>
		</fieldset>
	)
}
