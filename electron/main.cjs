const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Desktop shell for the game.
 *
 * Development loads the Vite dev server (hot reload intact); a packaged build loads the
 * static `dist/index.html` from inside the asar over file://. `vite.config.ts` sets a
 * relative base so those assets resolve on disk instead of against the filesystem root,
 * which is what produces the classic white screen in a packaged Electron app.
 */

const DEV_URL = process.env.ELECTRON_START_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;
const SMOKE = process.argv.includes('--smoke');
/** Smoke tests and debugging can point an unpackaged run at the built files. */
const LOAD_BUILD = process.argv.includes('--file');
/**
 * Window/taskbar icon for an unpackaged run. A packaged build takes its icon from the
 * executable itself, so only development needs the file on disk.
 */
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.png');

function createWindow() {
  const window = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // Matches the arena background, so the first paint is not a white flash.
    backgroundColor: '#0a0817',
    autoHideMenuBar: true,
    title: 'Jujutsu Cards: Sorcery Clash',
    icon: fs.existsSync(DEV_ICON) ? DEV_ICON : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Borderless/clean chrome: no menu bar and no menu shortcut revealing it.
  window.setMenuBarVisibility(false);

  window.once('ready-to-show', () => window.show());

  // External links belong in the user's browser, never in a second game window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[electron] failed to load ${url}: ${description} (${code})`);
    if (SMOKE) app.exit(1);
  });

  if (SMOKE) {
    window.webContents.once('did-finish-load', async () => {
      try {
        const loaded = await window.webContents.executeJavaScript(
          "Boolean(document.querySelector('#setup-form') && document.querySelector('#mode') && document.querySelector('#vfx-canvas') && document.querySelector('#sound-toggle'))",
        );
        const title = await window.webContents.executeJavaScript('document.title');
        // Web Audio is the whole sound system; report whether the shell can open a graph.
        // A suspended context is normal without a gesture, so any state is reported, not failed.
        const audio = await window.webContents.executeJavaScript(
          "(() => { try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const state = ctx.state; void ctx.close(); return state; } catch (error) { return `unavailable: ${error.message}`; } })()",
        );
        console.log(`SMOKE ${loaded ? 'OK' : 'FAIL'} title="${title}" audio=${audio}`);
        app.exit(loaded ? 0 : 1);
      } catch (error) {
        console.error(`SMOKE FAIL ${error && error.message ? error.message : String(error)}`);
        app.exit(1);
      }
    });
  }

  if (isDev && !LOAD_BUILD) {
    void window.loadURL(DEV_URL);
  } else {
    void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  return window;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
