import type { DB } from './db/index.ts';
import { getDb } from './db/index.ts';

export interface Settings {
	/** Container passed to yt-dlp --merge-output-format / preferred remux target. */
	videoFormat: 'mp4' | 'mkv' | 'webm';
	/** Maximum resolution (vertical pixels) to request; 'best' = no cap. */
	maxResolution: '2160' | '1440' | '1080' | '720' | '480' | 'best';
	/** Parallel downloads. */
	concurrency: number;
	/** Retry attempts per job before it is marked failed. */
	maxRetries: number;
	/** Path template inside the media library. */
	namingTemplate: string;
	/** Strip sponsor/self-promo/intro segments via SponsorBlock. */
	sponsorBlock: boolean;
	/** Trigger a Jellyfin library refresh when a batch completes. */
	jellyfinRefresh: boolean;
	/** Optional yt-dlp rate limit, e.g. "4M". Empty = unlimited. */
	rateLimit: string;
	/**
	 * yt-dlp YouTube player client(s), passed as
	 * `--extractor-args youtube:player_client=<value>`. Overrides yt-dlp's default
	 * client selection when it stops yielding downloadable formats (e.g. a client
	 * that now demands a GVS PO Token). Comma-separated; empty = yt-dlp default.
	 */
	ytdlpPlayerClient: string;
	/** Jellyfin server URL, set during the setup wizard. */
	jellyfinUrl: string;
	/** Jellyfin library path for saved videos, chosen during setup. */
	jellyfinLibraryPath: string;
	/** Auto-download new uploads from subscribed channels on a schedule. */
	subscriptionsEnabled: boolean;
	/** How often (hours) to poll a subscribed channel / synced playlist for new videos. */
	subscriptionCheckHours: number;
}

export const defaults: Settings = {
	videoFormat: 'mp4',
	maxResolution: '1080',
	concurrency: 2,
	maxRetries: 3,
	namingTemplate: '{channel}/Season {season}/{channel} - S{season}E{episode:03} - {title}',
	sponsorBlock: true,
	jellyfinRefresh: true,
	rateLimit: '',
	ytdlpPlayerClient: '',
	jellyfinUrl: '',
	jellyfinLibraryPath: '',
	subscriptionsEnabled: true,
	subscriptionCheckHours: 24
};

export function getSettings(db: DB = getDb()): Settings {
	const rows = db.prepare('SELECT key, value FROM settings').all() as {
		key: string;
		value: string;
	}[];
	const stored: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			stored[row.key] = JSON.parse(row.value);
		} catch {
			// Corrupt row: fall back to the default rather than crash the app.
		}
	}
	const merged = { ...defaults };
	for (const key of Object.keys(defaults) as (keyof Settings)[]) {
		if (key in stored && typeof stored[key] === typeof defaults[key]) {
			// Type-compatible stored value wins; anything else keeps the default.
			(merged as Record<string, unknown>)[key] = stored[key];
		}
	}
	return merged;
}

export function updateSettings(patch: Partial<Settings>, db: DB = getDb()): Settings {
	const upsert = db.prepare(
		'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
	);
	db.transaction(() => {
		for (const [key, value] of Object.entries(patch)) {
			if (!(key in defaults)) continue; // ignore unknown keys from stale clients
			upsert.run(key, JSON.stringify(value));
		}
	})();
	return getSettings(db);
}
