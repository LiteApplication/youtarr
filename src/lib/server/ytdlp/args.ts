import path from 'node:path';
import type { Settings } from '../settings.ts';

/**
 * Build the yt-dlp argv for one video download.
 *
 * SECURITY: the result is only ever passed to execFile/spawn as an argv array.
 * Building a shell string from any of this (video ids and titles are
 * user-influenced) would be a command injection hole.
 */
export function buildYtdlpArgs(options: {
	videoId: string;
	scratchDir: string;
	settings: Pick<
		Settings,
		'videoFormat' | 'maxResolution' | 'sponsorBlock' | 'rateLimit' | 'ytdlpPlayerClient'
	>;
	cookiesFile?: string;
	/**
	 * Base URL of a bgutil PO Token provider HTTP server. When set, yt-dlp's
	 * bgutil plugin fetches GVS PO Tokens from it, letting the `web` client hand
	 * out formats without the "Requested format is not available" failure.
	 * Deployment-level (points at a sibling container), so it comes from an env
	 * var, not a per-user setting.
	 */
	potProviderBaseUrl?: string;
	/**
	 * yt-dlp `--js-runtimes` value. yt-dlp needs an external JavaScript runtime to
	 * solve YouTube's signature/"n" challenge (its EJS solver); without one it
	 * discards every real format and reports "Requested format is not available".
	 * yt-dlp defaults to Deno, which the Alpine image doesn't ship - so in Docker
	 * we point it at the bundled Node. Deployment-level, hence an env var.
	 */
	jsRuntimes?: string;
}): string[] {
	const { videoId, scratchDir, settings } = options;
	if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
		throw new Error(`suspicious video id rejected: ${JSON.stringify(videoId)}`);
	}
	const heightCap = settings.maxResolution === 'best' ? null : Number(settings.maxResolution);
	const format = heightCap
		? `bestvideo[height<=${heightCap}]+bestaudio/best[height<=${heightCap}]`
		: 'bestvideo+bestaudio/best';
	const args = [
		'--no-playlist',
		'--format',
		format,
		'--merge-output-format',
		settings.videoFormat,
		'--remux-video',
		settings.videoFormat,
		'--output',
		path.join(scratchDir, 'video.%(ext)s'),
		'--paths',
		`temp:${scratchDir}`,
		'--newline',
		'--progress-template',
		// One JSON object per line; parsed by progress.ts.
		'%(progress)j',
		'--retries',
		'3',
		'--socket-timeout',
		'15'
	];
	// Override yt-dlp's client selection when the default stops yielding
	// downloadable formats without a GVS PO Token. See settings.ytdlpPlayerClient.
	if (settings.ytdlpPlayerClient) {
		if (!/^[A-Za-z0-9_+,-]+$/.test(settings.ytdlpPlayerClient)) {
			throw new Error(`invalid player client: ${JSON.stringify(settings.ytdlpPlayerClient)}`);
		}
		args.push('--extractor-args', `youtube:player_client=${settings.ytdlpPlayerClient}`);
	}
	if (options.jsRuntimes) {
		// Values look like "node", "deno", "node,quickjs", or "deno:/path/to/deno".
		if (!/^[A-Za-z0-9_,.:/-]+$/.test(options.jsRuntimes)) {
			throw new Error(`invalid js runtimes: ${JSON.stringify(options.jsRuntimes)}`);
		}
		args.push('--js-runtimes', options.jsRuntimes);
	}
	if (options.potProviderBaseUrl) {
		// Operator-controlled, but still validate: it lands in an argv token and a
		// bogus value would silently disable token fetching.
		let parsed: URL;
		try {
			parsed = new URL(options.potProviderBaseUrl);
		} catch {
			throw new Error(`invalid POT provider URL: ${JSON.stringify(options.potProviderBaseUrl)}`);
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(`invalid POT provider URL: ${JSON.stringify(options.potProviderBaseUrl)}`);
		}
		// Strip any trailing slash; the plugin expects a bare origin/base.
		const base = options.potProviderBaseUrl.replace(/\/+$/, '');
		args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${base}`);
	}
	if (settings.sponsorBlock) {
		args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');
	}
	if (settings.rateLimit) {
		if (!/^\d+(\.\d+)?[KMG]?$/i.test(settings.rateLimit)) {
			throw new Error(`invalid rate limit: ${JSON.stringify(settings.rateLimit)}`);
		}
		args.push('--limit-rate', settings.rateLimit);
	}
	if (options.cookiesFile) {
		args.push('--cookies', options.cookiesFile);
	}
	// The id is constrained above, and '--' stops option parsing regardless.
	args.push('--', `https://www.youtube.com/watch?v=${videoId}`);
	return args;
}
