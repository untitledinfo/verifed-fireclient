'use strict';

/**
 * Sandboxed FireClient Preload Bridge for macOS & Linux (and Electron dev mode).
 * Exposes ONLY the allowlisted ipcRenderer surface via window.require('electron')
 * — matching native/src/bridge.cpp Bridge::ShimJs() while keeping nodeIntegration disabled.
 */
const { ipcRenderer } = require('electron');

const listenerMap = new WeakMap();

const safeIpcRenderer = Object.freeze({
  invoke(channel, ...args) {
    if (typeof channel !== 'string' || !channel) return Promise.resolve(null);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    if (typeof channel !== 'string' || !channel) return;
    ipcRenderer.send(channel, ...args);
  },
  on(channel, fn) {
    if (typeof channel !== 'string' || typeof fn !== 'function') return this;
    const wrapped = (_event, ...args) => fn({}, ...args);
    listenerMap.set(fn, wrapped);
    ipcRenderer.on(channel, wrapped);
    return this;
  },
  once(channel, fn) {
    if (typeof channel !== 'string' || typeof fn !== 'function') return this;
    ipcRenderer.once(channel, (_event, ...args) => fn({}, ...args));
    return this;
  },
  removeListener(channel, fn) {
    const wrapped = listenerMap.get(fn);
    if (wrapped) ipcRenderer.removeListener(channel, wrapped);
    return this;
  },
  removeAllListeners(channel) {
    if (typeof channel === 'string') ipcRenderer.removeAllListeners(channel);
    return this;
  }
});

const electronShim = Object.freeze({ ipcRenderer: safeIpcRenderer });

window.ipc = safeIpcRenderer;
window.require = function fireclientRequireShim(mod) {
  if (mod === 'electron') return electronShim;
  throw new Error('Module access denied in sandboxed renderer: ' + mod);
};

