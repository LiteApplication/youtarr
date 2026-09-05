import { listSubscriptions, subscribe, unsubscribe } from '$lib/server/subscriptions/store';
import { assertChannelRef, resolveChannel } from '$lib/server/ytdlp/metadata';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	return json({ subscriptions: listSubscriptions(locals.session!.userId) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	let body: { channelRef?: unknown };
	try {
		body = (await request.json()) as { channelRef?: unknown };
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	const channelRef = typeof body.channelRef === 'string' ? body.channelRef : '';
	try {
		assertChannelRef(channelRef);
	} catch (cause) {
		return json({ error: (cause as Error).message }, { status: 400 });
	}
	try {
		// Seed the seen-set with the current uploads so future checks only
		// enqueue genuinely new videos.
		const channel = await resolveChannel(channelRef, { limit: 50 });
		const sub = subscribe(
			{
				channelRef,
				channelId: channel.channelId,
				name: channel.name,
				thumbnail: channel.thumbnails.at(-1)?.url ?? null,
				createdBy: locals.session!.userId
			},
			channel.videos.map((v) => v.videoId)
		);
		return json({ subscription: sub }, { status: 201 });
	} catch (cause) {
		return json({ error: (cause as Error).message }, { status: 502 });
	}
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	let body: { channelRef?: unknown };
	try {
		body = (await request.json()) as { channelRef?: unknown };
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	const channelRef = typeof body.channelRef === 'string' ? body.channelRef : '';
	if (!channelRef) return json({ error: 'channelRef is required' }, { status: 400 });
	const removed = unsubscribe(channelRef, locals.session!.userId);
	return json({ removed });
};
