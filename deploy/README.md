# Publishing AQAI Music to aqaimusic.com

Two things live separately:

- **App code** (`server.py` + `static/`) — small, version-controlled with
  git in this `player/` folder, deployed by `git pull` on the server.
- **Media library** (all the song/panorama folders one level up from
  `player/`) — currently ~11GB, too large and binary for git. Copied to
  the server with `rsync`, independent of code deploys.

## One-time setup

1. ~~Register a domain~~ — done: **aqaimusic.com**, registered at Hostnet.

2. ~~Provision a VPS~~ — done: Hostnet, 1 vCPU / 2GB RAM / 50GB SSD.

3. ~~Push this code to a git host~~ — done: public repo at
   **https://github.com/martijnvanmeel/AQAI**.

4. **Point DNS at the VPS.** In Hostnet's DNS management for aqaimusic.com,
   add an `A` record for `aqaimusic.com` (and one for `www`) pointing at
   the VPS's IP address. This can take a few minutes to a few hours to
   propagate.

5. **SSH into the VPS** and run the bootstrap script (already points at
   the right repo - nothing to edit):
   ```bash
   ssh root@your-vps-ip
   curl -O https://raw.githubusercontent.com/martijnvanmeel/AQAI/main/deploy/setup.sh
   bash setup.sh
   ```
   This installs Python/Caddy, clones the repo (public, no auth needed)
   to `/opt/aqai/player`, and starts the app as a systemd service (`aqai`)
   behind Caddy, which automatically provisions HTTPS for your domain.

6. **Copy the media library over** (run from your Mac - this first sync
   is the slow part, expect it to take a while depending on your upload
   speed; later syncs after adding new songs will be much faster since
   rsync only transfers what changed):
   ```bash
   rsync -avz --progress \
     --exclude='.DS_Store' \
     --exclude='player/' \
     --exclude='.claude/' \
     "/Users/martijnmeel/Claude/AQAI Music/" root@your-vps-ip:/opt/aqai/
   chown -R aqai:aqai /opt/aqai   # run this on the VPS afterward
   ```

At this point `https://aqaimusic.com` should be live, and it's
**read-only for the public** — the delete/rename/sync-edit endpoints all
check `_is_public_request()` in `server.py` and refuse (403) any request
that arrives through Caddy's reverse proxy, since Caddy stamps
`X-Forwarded-For` on every request it forwards. No code changes were
needed for this — it already worked this way when built for a tunnel,
and a normal reverse proxy triggers the same check.

## Publishing a new version

Once you're happy with changes made locally (test at `http://localhost:8420`,
where editing/deleting/renaming still works normally):

```bash
cd "AQAI Music/player"
git add -A && git commit -m "describe the change"
git push
deploy/deploy.sh root@your-vps-ip
```

That's it — `deploy.sh` pulls the new commit on the server and restarts
the service.

If you've also added new songs/backgrounds since the last sync, re-run
the `rsync` command from step 6 as well (it only transfers what's new).

## Notes

- The local git identity for this repo was set to a placeholder
  (`AQAI <aqai@localhost>`). Change it if you want real attribution:
  `git config user.name "..."; git config user.email "..."`.
- `player/bin/cloudflared` is excluded from git and unused by this setup
  - it was left over from an earlier, different approach (running the
  server directly on a Mac and tunneling to it, instead of an always-on
  VPS). Safe to ignore or delete.
