import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerIpcHandlers } from './ipc-handlers.js';
import { cleanupServers } from './genai-api.js';
import squirrelStartup from 'electron-squirrel-startup';

// ES module compatibility: Define __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (squirrelStartup) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  const preloadPath = join(__dirname, 'preload.cjs');
  console.log('[MAIN] Preload path:', preloadPath);

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for some Electron Forge features
    },
    backgroundColor: '#1e1e1e', // Dark theme default
  });

  // Load the app
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Open DevTools in development mode
  if (process.env.NODE_ENV === 'development' || MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// This method will be called when Electron has finished initialization
app.on('ready', async () => {
  // Register IPC handlers
  registerIpcHandlers();

  // Create window
  createWindow();
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Cleanup on quit
app.on('before-quit', async (event) => {
  event.preventDefault();
  try {
    await cleanupServers();
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    app.exit(0);
  }
});

// Export for access from other modules
export { mainWindow };
