# Creoveya Desktop (Windows)

This is a thin native wrapper around your hosted web app (`main.js` just opens
your Render URL in a window) — it is **not** a separate app with its own
backend. Desktop users log in with the exact same username/password they
created on the website, because it's the same account system.

## Before building

Open `main.js` and confirm `APP_URL` points at your real production URL
(defaults to `https://creoveya.onrender.com`).

## Building the Windows installer

This project uses [electron-builder](https://www.electron.build/), which needs
either a Windows machine or a CI runner to produce a proper NSIS `.exe`
installer (it can't be cross-compiled from this Linux sandbox — there's no
Wine/Windows toolchain here). Two easy ways to build it:

### Option A — GitHub Actions (recommended, no local Windows needed)
Push this `desktop-app/` folder to a GitHub repo and add
`.github/workflows/build.yml`:
```yaml
name: build
on: workflow_dispatch
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
        working-directory: desktop-app
      - run: npm run dist
        working-directory: desktop-app
      - uses: actions/upload-artifact@v4
        with: { name: CreoveyaSetup, path: desktop-app/dist/*.exe }
```
Run it from the Actions tab, then download the `.exe` artifact.

### Option B — On a Windows machine
```bash
cd desktop-app
npm install
npm run dist
```
The installer lands in `desktop-app/dist/Creoveya Setup <version>.exe`.

## What the installer does

- `nsis.createDesktopShortcut` and `createStartMenuShortcut` are both `true`
  in `package.json`, so on install it automatically creates a **desktop
  shortcut** and a Start Menu entry — double-clicking either opens the app
  straight to the Creoveya login/dashboard.
- `oneClick: false` gives users the standard "choose install location" wizard
  rather than a silent install, which reads as more trustworthy/professional.

## Publishing it on the site

Once you have a built `.exe`, put it at `public/downloads/CreoveyaSetup.exe`
in the main web project (create the `downloads` folder) — the homepage's
"Download for Windows" button already links to `/downloads/CreoveyaSetup.exe`.
