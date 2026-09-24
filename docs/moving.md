# Moving, backup and restore

Everything the platform keeps lives on the host, outside the container and the image:

| Directory (`.env`) | Contents | Needed on a new machine |
|---|---|---|
| `DATA_PATH` (`./data`) | users, sessions, job history, logs, uploads, thumbnails, your own models/modes (`state/*.local.json`), the Mesa shader cache | yes — this is the platform itself |
| `MODELS_PATH` (`./models`) | downloaded models, tens of GB | optional: the platform downloads missing ones again |
| `OUTPUT_PATH` (`./output`) | generated videos and images | if you want to keep the results |
| `.env` | paths, port, GIDs, tokens | copy it, then re-run `setup.sh` |

All paths inside `data/state` are relative, so the directories can be moved anywhere. The container runs as the host user (`PUID`/`PGID` in `.env`, written by `setup.sh`), so every file belongs to you and can be copied without `sudo`. `data/state/users.json` and `sessions.json` are mode 600 (only password hashes and session token hashes, but keep them private).

## Before copying

Stop the platform so no job is running and no file is half-written. Check that the queue is empty first — stopping aborts the current generation:

```bash
docker compose down
```

## To another disk on the same server

```bash
rsync -a --info=progress2 ./data ./models ./output /mnt/newdisk/genai/
```

Point `DATA_PATH`, `MODELS_PATH` and `OUTPUT_PATH` in `.env` to the new locations (absolute paths are fine) and start again with `docker compose up -d`. Only models can be moved on their own as well: models are large and benefit most from a fast SSD.

## To another server

```bash
rsync -a --info=progress2 genai-platform/ user@new-server:/srv/genai-platform/
```

On the new server:

```bash
cd /srv/genai-platform
./scripts/setup.sh          # updates PUID/PGID, RENDER_GID/VIDEO_GID for this machine and checks GTT
docker compose up -d --build
```

The GIDs of the `render` and `video` groups and the user id often differ between machines, which is why `setup.sh` must run again. If files arrived with another owner (a copy made with `sudo`, or a user with a different uid), `setup.sh` reports it; `./scripts/setup.sh --install` fixes ownership with `sudo chown`.

Users, passwords, history and results come along; sessions stay valid, so nobody has to sign in again.

## Backup

A backup of `DATA_PATH` (small) is enough to restore users and history; add `OUTPUT_PATH` to keep the results. Models do not need a backup: they are re-downloaded from the catalog. `data/state/cache` (shader cache) and `data/state/previews` can be skipped.

```bash
tar -czf genai-backup-$(date +%F).tgz --exclude=state/cache --exclude=state/previews data .env
```

To restore, unpack into the project directory, run `./scripts/setup.sh` and start the platform.

## Upgrading from a version that ran as root

Earlier versions ran the container as root, so the files in `data/`, `models/` and `output/` belong to root. Run `./scripts/setup.sh --install` once (it writes `PUID`/`PGID` and fixes the ownership), then `docker compose up -d --build`.
