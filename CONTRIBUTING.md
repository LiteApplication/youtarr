# Contributing

Thanks for your interest in youtarr.

## Setup

```sh
npm install
npm run dev
```

`ffmpeg` must be on PATH (tests exercise real video fixtures with it).

## Before opening a PR

```sh
npm run lint       # prettier + eslint
npm run check      # svelte-check
npm run test:unit  # vitest
npm run test:e2e   # playwright
```

All four must pass; CI runs the same commands.

## Ground rules

- **Never build shell strings from user-influenced data.** Every subprocess call uses argv arrays (`spawn`/`execFile`). The argv-builder tests assert hostile input stays inert - keep them passing.
- **Never write into `/media` without the mount sentinel check**, and never `rename()` across filesystems into the library. See `src/lib/server/library/publish.ts` for why.
- The queue assumes **one process owns the job table** (`replicas: 1` in Swarm). Don't add background workers that claim jobs outside `WorkerPool`.
- New settings go through `src/lib/server/settings.ts` with a typed default; unknown/mistyped stored values must fall back to defaults.
