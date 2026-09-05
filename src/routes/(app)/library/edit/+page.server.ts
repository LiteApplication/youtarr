import { readEpisodeInfo } from '$lib/server/library/browse';
import { applyVideoTags } from '$lib/server/library/edit';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const relative = url.searchParams.get('path');
	if (!relative) error(400, 'path query parameter required');
	try {
		return { path: relative, tags: readEpisodeInfo(relative) };
	} catch (cause) {
		error(404, `Could not read episode info: ${(cause as Error).message}`);
	}
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const relative = String(form.get('path') ?? '');
		const title = String(form.get('title') ?? '').trim();
		const channel = String(form.get('channel') ?? '').trim();
		const season = String(form.get('season') ?? '').trim();
		const episodeRaw = String(form.get('episode') ?? '').trim();
		const episode = Number(episodeRaw);
		if (!relative || !title || !channel || !season || !episodeRaw || !Number.isInteger(episode)) {
			return fail(400, { error: 'Title, channel, season, and episode number are required.' });
		}
		const airedRaw = String(form.get('aired') ?? '').trim();
		try {
			const result = await applyVideoTags(relative, {
				title,
				channel,
				season,
				episode,
				// The <input type="date"> gives YYYY-MM-DD; NFOs (and JobMeta) use YYYYMMDD.
				aired: airedRaw ? airedRaw.replaceAll('-', '') : undefined
			});
			redirect(
				303,
				`/library?path=${encodeURIComponent(result.newPath.split('/').slice(0, -1).join('/'))}`
			);
		} catch (cause) {
			if ((cause as { status?: number }).status === 303) throw cause;
			return fail(500, { error: (cause as Error).message });
		}
	}
};
