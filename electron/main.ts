/**
 * Main Process Entry Point
 * Handles application lifecycle and window management
 *
 * Architecture:
 * - Main process: Node.js environment with full system access
 * - Renderer process: Isolated browser environment (sandboxed)
 * - IPC: Secure communication bridge via typed channels
 */

// Initialize logger first - redirects console.log to file
import './services/logger.service'

import { app, BrowserWindow, Menu, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { databaseService } from './services/database.service'
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc/handlers'

// Load Windows system certificates into Node.js (fixes corporate proxy/firewall TLS issues)
// Must be loaded synchronously before any HTTPS connections are made
if (process.platform === 'win32') {
  try {
    const require = createRequire(import.meta.url)
    require('win-ca')

    // Check how many certificates were loaded
    const https = require('https')
    const ca = https.globalAgent.options.ca
    const certCount = Array.isArray(ca) ? ca.length : (ca ? 1 : 0)
    console.log(`[Security] Windows certificate store loaded: ${certCount} certificates`)
  } catch (err) {
    console.warn('[Security] win-ca not available:', err)
  }
}

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Environment setup
process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public')

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

let mainWindow: BrowserWindow | null = null

/**
 * Get the main window instance for IPC events
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * Setup Content Security Policy
 * Implements strict CSP to prevent XSS and code injection attacks
 */
function setupContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = VITE_DEV_SERVER_URL
      ? [
          // Development CSP - more permissive for Vite HMR
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:*",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "connect-src 'self' http://localhost:* ws://localhost:* https:",
          "frame-src 'none'",
        ].join('; ')
      : [
          // Production CSP - strict security
          "default-src 'self'",
          "script-src 'self'",
          // Note: 'unsafe-inline' required for Tailwind CSS dynamic class generation
          // Consider migrating to nonce-based CSP in future for maximum security
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:", // Allow external images from emails
          "connect-src 'self'",
          "frame-src 'none'",
          "object-src 'none'", // Prevents plugin content (Flash, Java applets, etc.)
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ')

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

/**
 * Create the main application window with secure settings
 */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../build/icons/icon.ico')
      : path.join(__dirname, '../build/icons/icon.png'),
    webPreferences: {
      // Security: Enable context isolation (default in Electron 12+)
      contextIsolation: true,

      // Security: Disable Node.js integration in renderer
      nodeIntegration: false,

      // Security: Enable sandbox for maximum security
      sandbox: true,

      // Preload script for secure IPC bridge
      preload: path.join(__dirname, 'preload.mjs'),

      // Security: Always enable web security
      webSecurity: true,
    },
  })

  // Security: Prevent navigation to external sites
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl)

    // Allow navigation only to localhost in development or file:// protocol
    if (VITE_DEV_SERVER_URL) {
      if (!parsedUrl.origin.includes('localhost') && parsedUrl.protocol !== 'file:') {
        event.preventDefault()
        console.warn('Navigation blocked:', navigationUrl)
      }
    } else {
      // In production, only allow file:// protocol
      if (parsedUrl.protocol !== 'file:') {
        event.preventDefault()
        console.warn('Navigation blocked:', navigationUrl)
      }
    }
  })

  // Security: Prevent opening new windows
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  // Load the app
  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(process.env.DIST || '', 'index.html'))
  }

  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Application initialization
 */
async function initialize() {
  try {
    // Remove the default application menu bar
    Menu.setApplicationMenu(null)

    // Setup Content Security Policy
    setupContentSecurityPolicy()

    // Initialize database before anything else
    await databaseService.initialize()
    console.log('Database initialized')

    // Register IPC handlers once at app level
    registerIpcHandlers()

    // Create the main window
    await createWindow()

    console.log('Application initialized successfully')
  } catch (error) {
    console.error('Failed to initialize application:', error)
    app.quit()
  }
}

/**
 * Application lifecycle events
 */

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(initialize)

// Quit when all windows are closed, except on macOS.
// On macOS it's common for applications to stay open until the user explicitly quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// On macOS, re-create a window when the dock icon is clicked and no other windows are open.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Cleanup before quit
app.on('before-quit', () => {
  unregisterIpcHandlers()
})

/**
 * Security: Handle certificate errors (development only)
 * In production, this should be removed or configured to only accept valid certificates
 */
if (VITE_DEV_SERVER_URL) {
  app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    // Only allow certificate errors for localhost in development
    if (url.startsWith('https://localhost')) {
      event.preventDefault()
      callback(true)
    } else {
      callback(false)
    }
  })
}

/**
 * Security: Implement Content Security Policy
 * This helps prevent XSS attacks and other code injection attacks
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, _webPreferences, _params) => {
    // Prevent webview creation (security best practice)
    event.preventDefault()
  })
})
