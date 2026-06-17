/**
 * Persistence of recently-opened projects (diagram + SQL file handle pairs).
 *
 * FileSystemFileHandle objects are structured-cloneable, so they can be stored
 * in IndexedDB and reused later. The browser still requires the user to re-grant
 * read permission (via a user gesture) before the handle can be read again; see
 * {@link ensureReadPermission} and {@link hasReadPermission}.
 *
 * @module recentProjects
 */

const DB_NAME = 'erd-pets';
const DB_VERSION = 1;
const STORE = 'recent-projects';
const MAX_RECENTS = 12;

/**
 * @typedef {Object} RecentProject
 * @property {string} key - URL-safe identifier, also used as the bookmark hash key
 * @property {string} name - Display name (diagram file name without extension)
 * @property {string} diagramFileName
 * @property {string} sqlFileName
 * @property {FileSystemFileHandle} diagramHandle
 * @property {FileSystemFileHandle} sqlHandle
 * @property {number} lastOpened - Epoch milliseconds
 */

/**
 * Whether recent-project persistence is available in this browser.
 * @returns {boolean}
 */
export function isRecentSupported() {
  return typeof indexedDB !== 'undefined';
}

/**
 * Derive a URL-safe project key from the diagram file name.
 * Strips the `.erd-pets.json` / `.json` extension and slugifies the rest.
 * @param {string} diagramFileName
 * @returns {string}
 */
export function projectKey(diagramFileName) {
  const base = diagramFileName
    .replace(/\.erd-pets\.json$/i, '')
    .replace(/\.json$/i, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return slug || 'project';
}

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @template T
 * @param {IDBTransaction} tx
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function awaitRequest(tx, request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * List stored recent projects, most recently opened first.
 * @returns {Promise<RecentProject[]>}
 */
export async function listRecentProjects() {
  if (!isRecentSupported()) return [];
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    /** @type {RecentProject[]} */
    const all = await awaitRequest(tx, tx.objectStore(STORE).getAll());
    return all.sort((a, b) => b.lastOpened - a.lastOpened);
  } finally {
    db.close();
  }
}

/**
 * Insert or update a recent project, trimming the list to the most recent entries.
 * @param {Omit<RecentProject, 'lastOpened'>} project
 * @returns {Promise<void>}
 */
export async function saveRecentProject(project) {
  if (!isRecentSupported()) return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ ...project, lastOpened: Date.now() });
    /** @type {RecentProject[]} */
    const all = await awaitRequest(tx, store.getAll());
    if (all.length > MAX_RECENTS) {
      const stale = all
        .sort((a, b) => b.lastOpened - a.lastOpened)
        .slice(MAX_RECENTS);
      for (const entry of stale) {
        store.delete(entry.key);
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Remove a recent project by key.
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function removeRecentProject(key) {
  if (!isRecentSupported()) return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await awaitRequest(tx, tx.objectStore(STORE).get(key));
  } finally {
    db.close();
  }
}

/**
 * Query whether read permission is already granted for a handle, without
 * prompting (safe to call outside a user gesture, e.g. on page load).
 * @param {FileSystemHandle} handle
 * @returns {Promise<boolean>}
 */
export async function hasReadPermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  try {
    return (await handle.queryPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Ensure read permission for a handle, prompting if necessary. Must be called
 * from within a user gesture (e.g. a click handler) for the prompt to appear.
 * @param {FileSystemHandle} handle
 * @returns {Promise<boolean>}
 */
export async function ensureReadPermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return true;
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

const URL_KEY = 'p';

/**
 * Read the project key from the current URL hash (e.g. `#p=my-project`).
 * @returns {string | null}
 */
export function getUrlProjectKey() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get(URL_KEY);
}

/**
 * Write the project key into the URL hash without adding a history entry.
 * @param {string} key
 */
export function setUrlProjectKey(key) {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  params.set(URL_KEY, key);
  const newHash = `#${params.toString()}`;
  history.replaceState(null, '', newHash);
}
