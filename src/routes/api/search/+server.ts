import { searchVideos } from '$lib/server/ytdlp/metadata';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * JSON search endpoint powering in-page pickers. The search *page* has its own
 * SSR loader; this is the fetch-friendly variant returning `VideoResult[]` directly.
 */
export const GET: RequestHandler = async ({ url }) => {
	const query = url.searchParams.get('q')?.trim() ?? '';
	if (!query) return json({ results: [] });

	try {
		const results = await searchVideos(query);
		return json({ results });
	} catch (cause) {
		return json({ error: (cause as Error).message }, { status: 502 });
	}
};
