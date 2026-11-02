// Intentionally minimal — the app is just the hosted website in a native
// window. No Node/Electron APIs are exposed to the page (contextIsolation
// is on and nothing is attached to `window` here), so the web app runs
// exactly as it does in a browser tab, with the same security boundary.
