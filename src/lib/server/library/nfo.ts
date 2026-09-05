/** Jellyfin-compatible NFO sidecars for a "channel = show, video = episode" library. */

function esc(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function tag(name: string, value: string | undefined | null): string {
	return value ? `  <${name}>${esc(value)}</${name}>\n` : '';
}

/** YYYYMMDD -> YYYY-MM-DD, as Jellyfin/Kodi NFOs expect. */
function isoDate(uploadDate: string | undefined): string | undefined {
	if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return undefined;
	return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

export interface TvShowNfoInput {
	title: string;
	channelId?: string;
	plot?: string;
}

/** One per channel directory, written once (never overwritten by a later download). */
export function tvshowNfo(input: TvShowNfoInput): string {
	let xml = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<tvshow>\n';
	xml += tag('title', input.title);
	xml += tag('plot', input.plot);
	if (input.channelId) xml += `  <uniqueid type="youtube" default="true">${esc(input.channelId)}</uniqueid>\n`;
	xml += '</tvshow>\n';
	return xml;
}

export interface EpisodeNfoInput {
	title: string;
	showTitle: string;
	season: string;
	episode: number;
	aired?: string; // YYYYMMDD
	videoId: string;
	plot?: string;
}

/** Written next to each downloaded video, same basename with a `.nfo` extension. */
export function episodeNfo(input: EpisodeNfoInput): string {
	let xml = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<episodedetails>\n';
	xml += tag('title', input.title);
	xml += tag('showtitle', input.showTitle);
	xml += `  <season>${Number(input.season) || 1}</season>\n`;
	xml += `  <episode>${input.episode}</episode>\n`;
	xml += tag('aired', isoDate(input.aired));
	xml += tag('plot', input.plot);
	xml += `  <uniqueid type="youtube" default="true">${esc(input.videoId)}</uniqueid>\n`;
	xml += '</episodedetails>\n';
	return xml;
}
