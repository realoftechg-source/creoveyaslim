const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

// Point this at your real, live Render URL before building the installer.
// Using the same hosted site means desktop users log in with the exact
// same account/credentials as the website — there is no separate
// desktop-only backend or account system.
const APP_URL = process.env.CREOVEYA_APP_URL || 'https://creoveyabetter.onrender.com';

// The desktop app opens straight to the sign-in page rather than the
// marketing homepage, so it behaves like a real dedicated app — not a
// browser tab. If the user already has a valid session (they stay
// logged in between launches, same as a real app), login.html itself
// detects that and skips straight to the dashboard/admin automatically
// (see the on-load check added to public/login.html) — so most of the
// time this is effectively a direct launch into the dashboard.
const LOAD_URL = `${APP_URL}/login.html`;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#0a1f4d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // The app needs real camera/mic access for AI streaming, same as
      // in a browser tab — Electron's permission handler below approves
      // exactly those two, and nothing else, per session.
    },
  });

  // Tags every request from this window with a custom UA fragment so the
  // web app itself can detect "I'm running inside the desktop app" (see
  // isDesktopApp() in public/js/common.js) and adapt — e.g. hiding the
  // "Back to Home" link and using the desktop-specific auth screen
  // styling, without needing a second set of pages to maintain.
  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} CreoveyaDesktopApp/1.0`);

  mainWindow.loadURL(LOAD_URL);

  // No native fullscreen forwarding here on purpose: the Studio page's
  // fullscreen button is a CSS-only "fill the window" overlay (see
  // .pseudo-fullscreen in style.css), not the browser's native
  // Fullscreen API — so it never fires 'enter-html-full-screen', and
  // this window's own OS-level fullscreen state is never touched. That
  // is deliberate: making the whole app window go OS-fullscreen would
  // hide the window's minimize/close controls, which is the opposite of
  // what's wanted — the video should fill the app's own window, with
  // the window itself staying exactly as the user left it.

  // Camera/mic prompts (needed for the Studio's getUserMedia calls) are
  // auto-approved once, matching what a browser would ask the user
  // anyway — everything else stays default (denied).
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['media', 'camera', 'microphone'].includes(permission));
  });

  // Any link that isn't the app itself (e.g. Telegram support link,
  // legal pages opened in a new tab) opens in the user's real browser
  // instead of a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
