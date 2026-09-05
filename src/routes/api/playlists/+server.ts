import {
	listPlaylistSubscriptions,
	setPlaylistEnabled,
	subscribePlaylist,
	unsubscribePlaylist
} from '$lib/server/playlists/store';
import { assertPlaylistId, resolvePlaylist } from '$lib/server/ytdlp/metadata';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	return json({ subscriptions: listPlaylistSubscriptions(locals.session!.userId) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	let body: { playlistId?: unknown };
	try {
		body = (await request.json()) as { playlistId?: unknown };
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	const playlistId = typeof body.playlistId === 'string' ? body.playlistId : '';
	try {
		assertPlaylistId(playlistId);
	} catch (cause) {
		return json({ error: (cause as Error).message }, { status: 400 });
	}
	try {
		// Seed the seen-set with the current contents so future checks only
		// download videos added after the playlist was followed.
		const playlist = await resolvePlaylist(playlistId);
		const sub = subscribePlaylist(
			{
				playlistId,
				title: playlist.title,
				thumbnail: playlist.thumbnails.at(-1)?.url ?? null,
				createdBy: locals.session!.userId
			},
			playlist.videos.map((v) => v.videoId).filter((id): id is string => Boolean(id))
		);
		return json({ subscription: sub }, { status: 201 });
	} catch (cause) {
		return json({ error: (cause as Error).message }, { status: 502 });
	}
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
	let body: { playlistId?: unknown; enabled?: unknown };
	try {
		body = (await request.json()) as { playlistId?: unknown; enabled?: unknown };
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	const playlistId = typeof body.playlistId === 'string' ? body.playlistId : '';
	if (!playlistId) return json({ error: 'playlistId is required' }, { status: 400 });
	if (typeof body.enabled !== 'boolean') {
		return json({ error: 'enabled must be a boolean' }, { status: 400 });
	}
	const updated = setPlaylistEnabled(playlistId, locals.session!.userId, body.enabled);
	return json({ updated });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
	let body: { playlistId?: unknown };
	try {
		body = (await request.json()) as { playlistId?: unknown };
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}
	const playlistId = typeof body.playlistId === 'string' ? body.playlistId : '';
	if (!playlistId) return json({ error: 'playlistId is required' }, { status: 400 });
	const removed = unsubscribePlaylist(playlistId, locals.session!.userId);
	return json({ removed });
};
