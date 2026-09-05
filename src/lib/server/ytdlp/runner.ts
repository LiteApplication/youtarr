import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DB } from '../db/index.ts';
import { getDb } from '../db/index.ts';
import { configDir, mediaDir, potProviderBaseUrl, scratchDir, ytdlpJsRuntimes } from '../env.ts';
import { renderTemplate, resolveLibraryPath, seasonFor } from '../library/naming.ts';
import { episodeNfo, tvshowNfo } from '../library/nfo.ts';
import { publishFile, writeSidecar } from '../library/publish.ts';
import { getJobOwner } from '../queue/store.ts';
import type { Job, JobMeta } from '../queue/store.ts';
import type { JobRunner, RunResult } from '../queue/worker.ts';
import { RetryableJobError } from '../queue/worker.ts';
import { getSettings } from '../settings.ts';
import { buildYtdlpArgs } from './args.ts';
import { resolveCookiesFile } from './cookies.ts';
import { parseProgressLine } from './progress.ts';

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'm4v'];

/** Fraction of the progress bar given to the download phase; the rest is publish. */
const DOWNLOAD_SHARE = 0.92;

export interface PipelineOptions {
	db?: DB;
	ytdlpBin?: string;
	libraryRoot?: string;
	staging?: string;
	scratchRoot?: string;
	/** Directory holding per-account cookies (defaults to the config dir). */
	cookiesRoot?: string;
	fetchImpl?: typeof fetch;
}

/**
 * Atomically hand out the next episode number for a (channel, season) pair.
 * A single UPSERT...RETURNING avoids a race between concurrent downloads of
 * the same channel.
 */
function nextEpisodeNumber(channelId: string, season: string, db: DB): number {
	const row = db
		.prepare(
			`INSERT INTO episode_counters (channel_id, season, next_number) VALUES (?, ?, 2)
			 ON CONFLICT (channel_id, season) DO UPDATE SET next_number = next_number + 1
			 RETURNING next_number - 1 AS assigned`
		)
		.get(channelId, season) as { assigned: number };
	return row.assigned;
}

export class YtdlpPipeline implements JobRunner {
	private readonly db: DB;
	private readonly ytdlpBin: string;
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: PipelineOptions = {}) {
		this.db = options.db ?? getDb();
		this.ytdlpBin = options.ytdlpBin ?? process.env.YTDLP_BIN ?? 'yt-dlp';
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async run(
		job: Job,
		onProgress: (fraction: number) => void,
		signal: AbortSignal
	): Promise<RunResult> {
		const scratch = path.join(this.options.scratchRoot ?? scratchDir(), job.id);
		mkdirSync(scratch, { recursive: true });
		try {
			await this.download(job, scratch, onProgress, signal);
			const videoFile = this.findVideoFile(scratch);
			const coverPath = await this.fetchCover(job.meta, scratch, signal);
			onProgress(0.94);

			const libraryRoot = this.options.libraryRoot ?? mediaDir();
			const ext = path.extname(videoFile).slice(1);
			const channelId = job.meta.channelId ?? job.meta.channel;
			const season = seasonFor(job.meta);
			const episode = nextEpisodeNumber(channelId, season, this.db);
			const relative = renderTemplate(getSettings(this.db).namingTemplate, job.meta, episode, season);
			const targetPath = resolveLibraryPath(libraryRoot, relative, ext);

			this.publishWithRetryClassification(videoFile, targetPath, job.id, libraryRoot);
			onProgress(0.97);

			this.writeSidecars(job, targetPath, coverPath, libraryRoot, season, episode);
			onProgress(1);
			return { outputPath: targetPath };
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	private download(
		job: Job,
		scratch: string,
		onProgress: (fraction: number) => void,
		signal: AbortSignal
	): Promise<void> {
		const settings = getSettings(this.db);
		// Cookies live under CONFIG_DIR, independent of where scratch is (scratch
		// is tmpfs, so its parent is not the media volume).
		const cookiesRoot = this.options.cookiesRoot ?? configDir();
		const owner = getJobOwner(job.id, this.db);
		const args = buildYtdlpArgs({
			videoId: job.videoId,
			scratchDir: scratch,
			settings,
			cookiesFile: resolveCookiesFile(owner, cookiesRoot),
			potProviderBaseUrl: potProviderBaseUrl(),
			jsRuntimes: ytdlpJsRuntimes()
		});
		return new Promise<void>((resolve, reject) => {
			const child = spawn(this.ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
			const stderrTail: string[] = [];
			createInterface({ input: child.stdout }).on('line', (line) => {
				const update = parseProgressLine(line);
				if (update) onProgress(update.fraction * DOWNLOAD_SHARE);
			});
			createInterface({ input: child.stderr }).on('line', (line) => {
				// Mirror yt-dlp diagnostics to the server log so failures are visible
				// live, not just in the final error message.
				console.error(`[yt-dlp ${job.videoId}] ${line}`);
				stderrTail.push(line);
				if (stderrTail.length > 15) stderrTail.shift();
			});
			child.on('error', (cause) => reject(this.classifySpawnError(cause)));
			child.on('close', (code) => {
				if (code === 0) return resolve();
				const detail = stderrTail.join('\n');
				// Transient network trouble should retry; a private/removed video should not.
				const permanent =
					/Video unavailable|Private video|This video is not available|has been removed/i.test(
						detail
					);
				const message = `yt-dlp exited ${code}: ${detail.slice(-500) || 'no stderr'}`;
				reject(permanent ? new Error(message) : new RetryableJobError(message));
			});
		});
	}

	private classifySpawnError(cause: Error & { code?: string }): Error {
		if (cause.name === 'AbortError') return cause;
		if (cause.code === 'ENOENT') {
			return new Error(`yt-dlp binary not found at '${this.ytdlpBin}'`);
		}
		return new RetryableJobError(`failed to start yt-dlp: ${cause.message}`);
	}

	private findVideoFile(scratch: string): string {
		const files = readdirSync(scratch).filter((f) =>
			VIDEO_EXTENSIONS.includes(path.extname(f).slice(1))
		);
		if (files.length === 0) {
			throw new RetryableJobError('yt-dlp reported success but produced no video file');
		}
		// Prefer the requested container if several remain (e.g. source + remux).
		const preferred = files.find((f) => f.startsWith('video.')) ?? files[0];
		return path.join(scratch, preferred);
	}

	private async fetchCover(
		meta: JobMeta,
		scratch: string,
		signal: AbortSignal
	): Promise<string | undefined> {
		if (!meta.thumbnail) return undefined;
		try {
			const response = await this.fetchImpl(meta.thumbnail, { signal });
			if (!response.ok) return undefined;
			const buffer = Buffer.from(await response.arrayBuffer());
			const coverPath = path.join(scratch, 'cover.img');
			writeFileSync(coverPath, buffer);
			return coverPath;
		} catch {
			return undefined; // cover is best-effort; never fail the download over it
		}
	}

	private publishWithRetryClassification(
		videoFile: string,
		targetPath: string,
		jobId: string,
		libraryRoot: string
	): void {
		try {
			publishFile({
				sourcePath: videoFile,
				targetPath,
				jobId,
				libraryRoot,
				staging: this.options.staging
			});
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code;
			// Gluster brick outages surface as EIO/ESTALE - worth retrying later.
			if (code === 'EIO' || code === 'ESTALE') {
				throw new RetryableJobError(`library write failed (${code}): ${(cause as Error).message}`);
			}
			throw cause;
		}
	}

	/** tvshow.nfo (once) + episode NFO + thumbnail, beside the published video. */
	private writeSidecars(
		job: Job,
		targetPath: string,
		coverPath: string | undefined,
		libraryRoot: string,
		season: string,
		episode: number
	): void {
		const seasonDir = path.dirname(targetPath);
		const showDir = path.dirname(seasonDir);
		const meta = job.meta;

		writeSidecar(
			targetPath.replace(/\.[^./\\]+$/, '.nfo'),
			episodeNfo({
				title: meta.title,
				showTitle: meta.channel,
				season,
				episode,
				aired: meta.uploadDate,
				videoId: job.videoId
			}),
			libraryRoot
		);

		// Only write tvshow.nfo the first time this channel's directory appears
		// (the default template has one; a flat custom template may not have a
		// separate show directory at all).
		if (path.resolve(showDir) !== path.resolve(libraryRoot)) {
			const showNfoPath = path.join(showDir, 'tvshow.nfo');
			if (!existsSync(showNfoPath)) {
				writeSidecar(
					showNfoPath,
					tvshowNfo({ title: meta.channel, channelId: meta.channelId }),
					libraryRoot
				);
			}
			const posterPath = path.join(showDir, 'poster.jpg');
			if (coverPath && existsSync(coverPath) && !existsSync(posterPath)) {
				writeSidecar(posterPath, readFileSync(coverPath), libraryRoot);
			}
		}
	}
}
