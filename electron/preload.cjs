const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("webglowDesktop", Object.freeze({
  requestMicrophoneAccess: () => ipcRenderer.invoke("webglow:request-microphone"),
  getMicrophoneAccessStatus: () => ipcRenderer.invoke("webglow:microphone-status"),
}));
