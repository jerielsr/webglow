const { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } = require("electron");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let windowRef;
let webglowServer;
let portalOrigin;
let portalHost;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!windowRef) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.focus();
  });

  app.whenReady().then(startWebGlow).catch(async (error) => {
    await dialog.showMessageBox({
      type: "error",
      title: "WebGlow could not start",
      message: "The local WebGlow service could not start.",
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  });
}

function findLanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if ((address.family === "IPv4" || address.family === 4) && !address.internal && !address.address.startsWith("169.254.")) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

async function startWebGlow() {
  const dataDirectory = app.getPath("userData");
  const networkAddress = findLanAddress();
  process.env.DATA_DIR = dataDirectory;
  process.env.HOST = "0.0.0.0";
  process.env.WEBGLOW_HTTPS_ENABLED ||= "true";
  process.env.WEBGLOW_HTTPS_PORT ||= "18443";
  process.env.WEBGLOW_HTTPS_PUBLIC_PORT ||= process.env.WEBGLOW_HTTPS_HOST_PORT || process.env.WEBGLOW_HTTPS_PORT;
  const httpsEnabled = !["false", "0", "no", "off"].includes(process.env.WEBGLOW_HTTPS_ENABLED.toLowerCase());
  const publicPort = httpsEnabled ? process.env.WEBGLOW_HTTPS_PUBLIC_PORT : process.env.PORT || "1828";
  process.env.WEBGLOW_PUBLIC_URL ||= `${httpsEnabled ? "https" : "http"}://${networkAddress}:${publicPort}`;

  const appPath = app.getAppPath();
  const [{ buildApp }, { getConfig }, { prepareHttpsListener }] = await Promise.all([
    import(pathToFileURL(path.join(appPath, "dist", "app.js")).href),
    import(pathToFileURL(path.join(appPath, "dist", "config.js")).href),
    import(pathToFileURL(path.join(appPath, "dist", "https.js")).href),
  ]);
  const config = getConfig();
  webglowServer = await buildApp({ config });
  try {
    const secureListener = await prepareHttpsListener(webglowServer, config);
    await webglowServer.listen({ host: config.host, port: config.port });
    await secureListener.start();
  } catch (error) {
    await webglowServer.close().catch(() => undefined);
    webglowServer = undefined;
    throw new Error(`WebGlow could not open its HTTP or HTTPS listener. Check ports ${config.port} and ${config.httpsPort}, stop anything already using them, or set PORT/WEBGLOW_HTTPS_PORT to free ports. ${error instanceof Error ? error.message : String(error)}`);
  }

  portalHost = `127.0.0.1:${config.port}`;
  portalOrigin = `http://${portalHost}`;
  registerMicrophonePermissions();
  createWindow(portalOrigin);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(portalOrigin);
  });
  app.on("before-quit", () => {
    quitting = true;
    if (webglowServer) void webglowServer.close();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

function registerMicrophonePermissions() {
  const isLocalPortal = (origin) => {
    try {
      return new URL(origin).origin === portalOrigin;
    } catch {
      return false;
    }
  };
  const audioOnly = (details) => Array.isArray(details?.mediaTypes) && details.mediaTypes.includes("audio") && !details.mediaTypes.includes("video");

  const { session } = require("electron");
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isLocalPortal(contents.getURL().split("/").slice(0, 3).join("/")) && permission === "media" && audioOnly(details));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, _details) => {
    return isLocalPortal(requestingOrigin) && permission === "media";
  });
  ipcMain.handle("webglow:request-microphone", async () => {
    if (process.platform !== "darwin") return true;
    return systemPreferences.askForMediaAccess("microphone");
  });
  ipcMain.handle("webglow:microphone-status", async () => {
    if (process.platform !== "darwin") return "granted";
    return systemPreferences.getMediaAccessStatus("microphone");
  });
}

function createWindow(url) {
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.focus();
    return;
  }
  const preloadPath = path.join(app.getAppPath(), "electron", "preload.cjs");
  windowRef = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 760,
    minHeight: 560,
    resizable: true,
    maximizable: true,
    title: "WebGlow",
    backgroundColor: "#101a23",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isPortalUrl(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  windowRef.webContents.on("will-navigate", (event, target) => {
    if (!isPortalUrl(target)) event.preventDefault();
  });
  windowRef.on("closed", () => { windowRef = undefined; });
  void windowRef.loadURL(url);
  if (process.env.WEBGLOW_DEBUG === "1") windowRef.webContents.openDevTools({ mode: "detach" });
}

function isPortalUrl(target) {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" && parsed.host === portalHost;
  } catch {
    return false;
  }
}

app.on("before-quit", () => {
  if (quitting || !webglowServer) return;
  quitting = true;
  void webglowServer.close();
});
