# Security Best Practices

This document outlines the security measures implemented in this Electron application.

## Architecture Overview

### Process Isolation
- **Main Process**: Node.js environment with full system access
- **Renderer Process**: Sandboxed browser environment (Chromium)
- **Preload Script**: Secure bridge between main and renderer processes

### Security Configurations

#### 1. Context Isolation (ENABLED)
```typescript
contextIsolation: true
```
- Prevents renderer from accessing Electron internals
- Ensures `window` object is isolated from preload scripts

#### 2. Node Integration (DISABLED)
```typescript
nodeIntegration: false
```
- Renderer process cannot directly use Node.js APIs
- Prevents arbitrary code execution

#### 3. Remote Module (DISABLED)
```typescript
enableRemoteModule: false
```
- Deprecated module that allowed direct main process access
- Removed for security

#### 4. Sandbox Mode
```typescript
sandbox: false
```
- Currently disabled to allow preload scripts
- Consider enabling for maximum security if preload is not needed

## Secure IPC Communication

### Type-Safe Channels
All IPC channels are:
- Centrally defined in `electron/types/index.ts`
- Strongly typed with TypeScript
- Validated on both sides

### Input Validation
All IPC handlers validate inputs before processing:
```typescript
function validateAccount(account: any): account is Account {
  if (!account || typeof account !== 'object') {
    throw new Error('Invalid account data')
  }
  // ... more validation
}
```

### Limited API Exposure
The preload script exposes ONLY specific methods via `contextBridge`:
```typescript
// GOOD: Limited, typed API
window.electronAPI.getAccounts()

// BAD: Direct ipcRenderer access (OLD CODE - NOW REMOVED)
window.ipcRenderer.invoke('any-channel')
```

## Data Protection

### Encrypted Database
- Uses AES-256-CBC encryption for local storage
- Encryption key derived from app secret using scrypt
- Supports migration from plain JSON

### Sensitive Data Handling
1. **User Credentials**:
   - Stored encrypted in local database
   - Only decrypted in main process
   - Never exposed to renderer

## Network Security

### External Navigation Protection
```typescript
mainWindow.webContents.on('will-navigate', (event, url) => {
  // Block navigation to external sites
  // Only allow localhost in dev, file:// in production
})
```

### Window Opening Prevention
```typescript
mainWindow.webContents.setWindowOpenHandler(() => {
  return { action: 'deny' }
})
```

### Certificate Validation
- Development: Allows localhost certificates
- Production: Strict certificate validation

## Content Security Policy (CSP)

While not explicitly set in this version, consider adding:
```typescript
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'"]
    }
  })
})
```

## Best Practices for Development

### 1. Never Commit Secrets
- API keys → `.env` file
- Database files → `.gitignore`
- User data → `.gitignore`

### 2. Validate All Inputs
- Check types and structure
- Sanitize user-provided data
- Use TypeScript for compile-time checks

### 3. Principle of Least Privilege
- Only expose necessary APIs to renderer
- Validate permissions for each operation
- Use service layer pattern for business logic

### 4. Keep Dependencies Updated
```bash
npm audit
npm audit fix
```

### 5. Code Reviews
- Review all IPC handler changes
- Check for new security vulnerabilities
- Test authentication and authorization

## Security Checklist for Production

- [ ] Enable `sandbox: true` if possible
- [ ] Remove development-only code (DevTools, certificate bypass)
- [ ] Implement Content Security Policy
- [ ] Code sign the application
- [ ] Set up auto-updater with signature verification
- [ ] Audit all dependencies (`npm audit`)
- [ ] Test on clean machine before release
- [ ] Document security procedures for users

## Reporting Security Issues

If you discover a security vulnerability, please email [security contact] instead of opening a public issue.

## References

- [Electron Security Documentation](https://www.electronjs.org/docs/latest/tutorial/security)
- [OWASP Electron Security](https://owasp.org/www-community/vulnerabilities/Electron_Security)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
