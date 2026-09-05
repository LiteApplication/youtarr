import { syncDownloadsPlaylist } from '$lib/server/jellyfin/downloads';
import { getSettings, updateSettings, type Settings } from '$lib/server/settings';
import { getUserSettings, updateUserSettings, type UserSettings } from '$lib/server/userSettings';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const userId = locals.session?.userId;
	return {
		settings: getSettings(),
		userSettings: userId ? getUserSettings(userId) : undefined
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const userId = locals.session?.userId;
		if (!userId) throw error(401, 'Not signed in');
		const form = await request.formData();
		const patch: Partial<Settings> = {};

		const videoFormat = String(form.get('videoFormat') ?? '');
		if (['mp4', 'mkv', 'webm'].includes(videoFormat)) {
			patch.videoFormat = videoFormat as Settings['videoFormat'];
		}
		const maxResolution = String(form.get('maxResolution') ?? '');
		if (['2160', '1440', '1080', '720', '480', 'best'].includes(maxResolution)) {
			patch.maxResolution = maxResolution as Settings['maxResolution'];
		}
		const concurrency = Number(form.get('concurrency'));
		if (Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8) {
			patch.concurrency = concurrency;
		}
		const maxRetries = Number(form.get('maxRetries'));
		if (Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 10) {
			patch.maxRetries = maxRetries;
		}
		const template = String(form.get('namingTemplate') ?? '').trim();
		if (template.includes('{title}')) patch.namingTemplate = template;
		patch.sponsorBlock = form.get('sponsorBlock') === 'on';
		patch.jellyfinRefresh = form.get('jellyfinRefresh') === 'on';
		patch.subscriptionsEnabled = form.get('subscriptionsEnabled') === 'on';
		const checkHours = Number(form.get('subscriptionCheckHours'));
		if (Number.isInteger(checkHours) && checkHours >= 1 && checkHours <= 168) {
			patch.subscriptionCheckHours = checkHours;
		}
		const rateLimit = String(form.get('rateLimit') ?? '').trim();
		if (rateLimit === '' || /^\d+(\.\d+)?[KMG]?$/i.test(rateLimit)) patch.rateLimit = rateLimit;
		else return fail(400, { error: 'Rate limit must look like 500K or 4M.' });

		const playerClient = String(form.get('ytdlpPlayerClient') ?? '').trim();
		if (playerClient === '' || /^[A-Za-z0-9_+,-]+$/.test(playerClient)) {
			patch.ytdlpPlayerClient = playerClient;
		} else {
			return fail(400, {
				error: 'Player client may only contain letters, digits, _ + - and commas.'
			});
		}

		const userPatch: Partial<UserSettings> = {
			downloadsPlaylist: form.get('downloadsPlaylist') === 'on',
			downloadsPlaylistName: String(form.get('downloadsPlaylistName') ?? '').trim()
		};
		const wasEnabled = getUserSettings(userId).downloadsPlaylist;
		const userSettings = updateUserSettings(userId, userPatch);

		// Switching it on backfills everything added before now; a rename is picked
		// up by the same pass. Both run detached so saving settings stays snappy.
		if (userSettings.downloadsPlaylist && !wasEnabled) {
			void syncDownloadsPlaylist(userId, undefined, { poll: false }).catch((cause) =>
				console.error('downloads playlist backfill failed:', (cause as Error).message)
			);
		}

		return { settings: updateSettings(patch), userSettings, saved: true };
	}
};
