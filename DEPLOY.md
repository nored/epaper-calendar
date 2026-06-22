# Deploying the e-paper calendar server on OMV + Portainer

This runs the Node server in a container on your Open Media Vault box. Portainer
builds the image straight from your Git repo, so updating later is one click.

What you get: the control panel at `http://<OMV-IP>:3000/`, and the device
endpoint `http://<OMV-IP>:3000/frame.bin` that the ESP32 fetches.

---

## One-time: push the project to Git

The project isn't on a Git host yet. Create an **empty private repo** on GitHub
**Already done** — the project is published at:

- **Repo URL:** `https://github.com/nored/epaper-calendar`
- **Branch:** `master`
- It's **public**, so Portainer needs no access token.

To push future changes, just: `git add -A && git commit -m "..." && git push`.

---

## In Portainer: create the Stack

1. Open Portainer → left sidebar **Stacks** → **+ Add stack**.
2. **Name:** `epaper-calendar` (lowercase, no spaces).
3. **Build method:** choose **Repository**.
4. Fill in:
   - **Repository URL:** `https://github.com/nored/epaper-calendar`
   - **Repository reference:** `refs/heads/master`
   - **Compose path:** `docker-compose.yml`  ← it's at the repo root.
   - **Authentication:** leave OFF (the repo is public).
5. Click **Deploy the stack**.

Portainer clones the repo, builds the image from `server/Dockerfile`, and starts
the container. The first build takes a few minutes (it installs Node deps). When
it finishes you'll see the `epaper-calendar` container as **running** under
Containers.

---

## Confirm it works

From any browser on your LAN: open `http://<OMV-IP>:3000/`

Find `<OMV-IP>` in OMV under System → Network, or it's the address you use for
the OMV web UI. The control panel should load. `http://<OMV-IP>:3000/preview.png`
shows the rendered calendar.

---

## Point the device at it

In the firmware, set the server base URL to `http://<OMV-IP>:3000` (the device
requests `/frame.bin?batt=<volts>&reason=<wake>`). That lives in
`firmware/src/config.h` (gitignored — edit it on your PC and reflash). Use the
OMV box's IP; a fixed/reserved IP (DHCP reservation in your router) is wise so it
doesn't change.

---

## Updating later

1. Make changes on your PC, `git commit`, `git push`.
2. In Portainer → **Stacks** → `epaper-calendar` → enable **Re-pull image and
   redeploy** / **Pull and redeploy** → confirm.

Your settings survive: `config.json`, the API cache, and device status live in
the `epaper-data` volume, not in the image.

---

## Good to know

- **Port:** host port `3000`. If something else uses it, edit the left number in
  `docker-compose.yml` (`"8080:3000"` → reach it at `:8080`) and redeploy.
- **Persistent data:** the named volume `epaper-data` holds `/app/data`. Don't
  delete it unless you want to reset all settings.
- **Timezone:** set to `Europe/Berlin` in the compose file so "refresh at
  midnight" and the German date stamps are correct. Change it there if needed.
- **Architecture:** works on x86_64 and ARM OMV boxes — the right native canvas
  binary is fetched during the build.
- **Logs:** Portainer → Containers → `epaper-calendar` → **Logs**.
