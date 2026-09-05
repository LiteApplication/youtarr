/**
 * Sequential migrations, applied in order and tracked via PRAGMA user_version.
 * Never edit an entry after release - append a new one.
 */
export const migrations: string[] = [
	// 1 - initial schema
	`
	CREATE TABLE settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL -- JSON-encoded
	) STRICT;

	CREATE TABLE sessions (
		id             TEXT PRIMARY KEY,        -- opaque token handed to the browser
		jellyfin_token TEXT NOT NULL,
		user_id        TEXT NOT NULL,           -- Jellyfin user id
		user_name      TEXT NOT NULL,
		is_admin       INTEGER NOT NULL DEFAULT 0,
		created_at     INTEGER NOT NULL,        -- unix ms
		expires_at     INTEGER NOT NULL
	) STRICT;
	CREATE INDEX idx_sessions_expires ON sessions (expires_at);

	CREATE TABLE batches (
		id           TEXT PRIMARY KEY,
		kind         TEXT NOT NULL CHECK (kind IN ('video', 'channel', 'playlist')),
		source_id    TEXT NOT NULL,             -- video id / channel ref / playlist id
		title        TEXT NOT NULL,
		channel      TEXT,
		thumbnail    TEXT,
		created_at   INTEGER NOT NULL,
		created_by   TEXT NOT NULL,             -- Jellyfin user id
		jellyfin_playlist_id TEXT,
		sync_jellyfin INTEGER NOT NULL DEFAULT 1
	) STRICT;

	CREATE TABLE jobs (
		id            TEXT PRIMARY KEY,
		batch_id      TEXT NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
		video_id      TEXT NOT NULL,
		status        TEXT NOT NULL DEFAULT 'queued'
			CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
		position      INTEGER NOT NULL,          -- order within the queue
		attempts      INTEGER NOT NULL DEFAULT 0,
		progress      REAL NOT NULL DEFAULT 0,   -- 0..1
		-- resolved metadata (JSON): title/channel/channelId/uploadDate/thumbnail/…
		meta          TEXT NOT NULL DEFAULT '{}',
		error         TEXT,                      -- last failure: message + stderr tail
		next_retry_at INTEGER,                   -- unix ms; backoff gate
		started_at    INTEGER,
		finished_at   INTEGER,
		output_path   TEXT                       -- final library path once published
	) STRICT;
	CREATE INDEX idx_jobs_batch ON jobs (batch_id);
	CREATE INDEX idx_jobs_claim ON jobs (status, next_retry_at, position);

	-- Per-channel, per-season episode numbering. Assigned atomically right before
	-- a video is filed into the library, so concurrent downloads of the same
	-- channel never collide on an episode number.
	CREATE TABLE episode_counters (
		channel_id  TEXT NOT NULL,
		season      TEXT NOT NULL,
		next_number INTEGER NOT NULL DEFAULT 1,
		PRIMARY KEY (channel_id, season)
	) STRICT;

	-- Channel subscriptions: auto-download new uploads.
	CREATE TABLE channel_subscriptions (
		channel_ref     TEXT NOT NULL,            -- resolvable reference (e.g. "channel/UC…" or "@handle")
		channel_id      TEXT NOT NULL,             -- canonical UC… id, once resolved
		name            TEXT NOT NULL,
		thumbnail       TEXT,
		created_by      TEXT NOT NULL,            -- Jellyfin user id the downloads are attributed to
		created_at      INTEGER NOT NULL,         -- unix ms
		last_checked_at INTEGER,                  -- unix ms; NULL until first check
		PRIMARY KEY (channel_ref, created_by)
	) STRICT;
	CREATE INDEX idx_channel_subs_user ON channel_subscriptions (created_by);

	-- Videos already accounted for, so a check only enqueues uploads published
	-- after the channel was followed. Seeded with the channel's current uploads
	-- on subscribe.
	CREATE TABLE channel_seen (
		channel_ref TEXT NOT NULL,
		created_by  TEXT NOT NULL,
		video_id    TEXT NOT NULL,
		seen_at     INTEGER NOT NULL,             -- unix ms
		PRIMARY KEY (channel_ref, created_by, video_id),
		FOREIGN KEY (channel_ref, created_by)
			REFERENCES channel_subscriptions (channel_ref, created_by) ON DELETE CASCADE
	) STRICT;

	-- Playlist sync: mirror an upstream playlist into a Jellyfin playlist and
	-- poll followed playlists for newly-added videos.
	CREATE TABLE playlist_subscriptions (
		playlist_id     TEXT NOT NULL,
		title           TEXT NOT NULL,
		thumbnail       TEXT,
		enabled         INTEGER NOT NULL DEFAULT 1, -- per-playlist poll toggle
		created_by      TEXT NOT NULL,             -- Jellyfin user id the downloads are attributed to
		created_at      INTEGER NOT NULL,          -- unix ms
		last_checked_at INTEGER,                   -- unix ms; NULL until first check
		PRIMARY KEY (playlist_id, created_by)
	) STRICT;
	CREATE INDEX idx_playlist_subs_user ON playlist_subscriptions (created_by);

	-- Video ids already accounted for, so a check only enqueues videos added
	-- after the playlist was followed. Seeded with the current contents on
	-- subscribe.
	CREATE TABLE playlist_seen (
		playlist_id TEXT NOT NULL,
		created_by  TEXT NOT NULL,
		video_id    TEXT NOT NULL,
		seen_at     INTEGER NOT NULL,              -- unix ms
		PRIMARY KEY (playlist_id, created_by, video_id),
		FOREIGN KEY (playlist_id, created_by)
			REFERENCES playlist_subscriptions (playlist_id, created_by) ON DELETE CASCADE
	) STRICT;

	CREATE TABLE user_settings (
		user_id TEXT NOT NULL,               -- Jellyfin user id
		key     TEXT NOT NULL,
		value   TEXT NOT NULL,               -- JSON-encoded
		PRIMARY KEY (user_id, key)
	) STRICT;

	-- The Jellyfin playlist mirroring one user's downloads, remembered by id so a
	-- rename does not orphan it (and so a deleted playlist can be rebuilt).
	CREATE TABLE downloads_playlist (
		user_id        TEXT PRIMARY KEY,
		playlist_id    TEXT,
		last_synced_at INTEGER
	) STRICT;

	-- Videos already resolved to a Jellyfin item id and placed in that playlist.
	-- Keyed on the library path, so a steady-state sync costs zero Jellyfin
	-- searches and only genuinely new downloads are looked up.
	CREATE TABLE downloads_playlist_items (
		user_id  TEXT NOT NULL,
		path     TEXT NOT NULL,              -- youtarr's view of the file inside the media library
		item_id  TEXT NOT NULL,              -- Jellyfin item id
		added_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, path)
	) STRICT;
	`
];
