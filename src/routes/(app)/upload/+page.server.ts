import { ingestUpload } from '$lib/server/library/edit';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'Choose a video file to upload.' });
		}
		const title = String(form.get('title') ?? '').trim();
		const channel = String(form.get('channel') ?? '').trim();
		const season = String(form.get('season') ?? '').trim();
		const episodeRaw = String(form.get('episode') ?? '').trim();
		const episode = Number(episodeRaw);
		if (!title || !channel || !season || !episodeRaw || !Number.isInteger(episode)) {
			return fail(400, { error: 'Title, channel, season, and episode number are required.' });
		}
		const airedRaw = String(form.get('aired') ?? '').trim();
		try {
			const data = Buffer.from(await file.arrayBuffer());
			const result = await ingestUpload(file.name, data, {
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
