let allBookmarks = window.METRO_BOOKMARKS || [];
const palette = [
  '#4f7f78', '#8b6f4d', '#6f6b8f', '#7b5963', '#55728a', '#7b7448',
  '#6d5a7d', '#4f745f', '#7c5b52', '#526f7f', '#765d6b', '#576f91'
];
const state = {
  category: 'All Bookmarks',
  query: '',
  density: 'normal'
};

let baseBookmarks = [];
let bookmarks = [];
let byCategory = new Map();
let categoryNames = [];
let categoryColor = new Map();
let isWritingChrome = false;
let activeDraggedBookmarkId = '';
const SHORT_TITLE_MIGRATION_KEY = 'metro:short-title-migration:v1';

const meta = document.getElementById('meta');
const nav = document.getElementById('categoryNav');
const groups = document.getElementById('groups');
const search = document.getElementById('search');

meta.textContent = `${allBookmarks.length} links`;

function normalize(text) {
  return String(text || '').toLowerCase();
}

function hasChromeBookmarksApi() {
  return typeof chrome !== 'undefined' && chrome.bookmarks && typeof chrome.bookmarks.getTree === 'function';
}

function chromeBookmarkCreate(details) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create(details, node => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(node);
    });
  });
}

function chromeBookmarkMove(id, destination) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(id, destination, node => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(node);
    });
  });
}

function chromeBookmarkUpdate(id, changes) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.update(id, changes, node => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(node);
    });
  });
}

function chromeBookmarkRemoveTree(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.removeTree(id, () => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function chromeBookmarkTree() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree(tree => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tree);
    });
  });
}

function findBookmarksBarRoot(tree) {
  const root = tree && tree[0];
  const roots = root && root.children ? root.children : [];
  return roots.find(node => node.id === '1')
    || roots.find(node => /bookmarks bar|书签栏/i.test(node.title || ''))
    || roots[0]
    || root;
}

function flattenChromeBookmarks(nodes) {
  const items = [];
  function visit(node, folderPath) {
    const nextPath = node.url ? folderPath : node.title ? [...folderPath, { id: node.id, title: node.title }] : folderPath;
    if (node.url) {
      let domain = '';
      try {
        domain = new URL(node.url).hostname.replace(/^www\./, '');
      } catch {
        domain = '';
      }
      const cleanPath = folderPath.map(folder => folder.title).filter(Boolean);
      const category = cleanPath[0] || 'Bookmark Bar';
      items.push({
        id: node.id,
        title: node.title || node.url,
        url: node.url,
        category,
        parentId: node.parentId,
        index: node.index,
        domain,
        addDate: node.dateAdded ? Math.floor(node.dateAdded / 1000) : null,
        status: 'ok'
      });
      return;
    }
    for (const child of node.children || []) visit(child, nextPath);
  }
  for (const node of nodes || []) {
    if (node.url) visit(node, []);
    else for (const child of node.children || []) visit(child, []);
  }
  return items;
}

async function syncFromChromeBookmarks(options = {}) {
  const silent = Boolean(options.silent);
  if (!hasChromeBookmarksApi()) {
    if (!silent) alert('Chrome bookmarks API is only available when this page is running as the installed extension.');
    return;
  }
  try {
    const tree = await chromeBookmarkTree();
    const bookmarksBar = findBookmarksBarRoot(tree);
    allBookmarks = flattenChromeBookmarks(bookmarksBar ? [bookmarksBar] : []);
    if (!silent) {
      state.category = 'All Bookmarks';
    }
    render();
    flattenNestedBookmarkFolders(bookmarksBar);
    updateTitlesToShortNamesOnce();
  } catch (error) {
    if (!silent) alert(`Could not sync Chrome bookmarks.\n\n${error && error.message ? error.message : error}`);
    renderGroups();
  }
}

function installChromeBookmarkAutoSync() {
  if (!hasChromeBookmarksApi()) return;
  let syncTimer = 0;
  const scheduleSync = () => {
    if (isWritingChrome) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncFromChromeBookmarks({ silent: true }), 350);
  };
  chrome.bookmarks.onCreated.addListener(scheduleSync);
  chrome.bookmarks.onRemoved.addListener(scheduleSync);
  chrome.bookmarks.onChanged.addListener(scheduleSync);
  chrome.bookmarks.onMoved.addListener(scheduleSync);
  chrome.bookmarks.onChildrenReordered.addListener(scheduleSync);
  chrome.bookmarks.onImportEnded.addListener(scheduleSync);
}

function chromeBookmarkRemove(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.remove(id, () => {
      const error = chrome.runtime && chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function findFolderChild(parent, title) {
  return (parent.children || []).find(node => !node.url && node.title === title);
}

function descendantBookmarks(node) {
  const items = [];
  function visit(current) {
    if (current.url) {
      items.push(current);
      return;
    }
    for (const child of current.children || []) visit(child);
  }
  visit(node);
  return items;
}

async function flattenNestedBookmarkFolders(bookmarksBar) {
  if (!hasChromeBookmarksApi() || isWritingChrome || !bookmarksBar) return;
  const topFolders = (bookmarksBar.children || []).filter(node => !node.url);
  const nestedFolders = topFolders.flatMap(folder => (folder.children || [])
    .filter(child => !child.url)
    .map(child => ({ parent: folder, folder: child })));
  if (!nestedFolders.length) return;
  isWritingChrome = true;
  try {
    for (const entry of nestedFolders) {
      for (const bookmark of descendantBookmarks(entry.folder)) {
        await chromeBookmarkMove(bookmark.id, { parentId: entry.parent.id });
      }
      await chromeBookmarkRemoveTree(entry.folder.id);
    }
  } catch (error) {
    alert(`Could not flatten bookmark folders.\n\n${error && error.message ? error.message : error}`);
  } finally {
    isWritingChrome = false;
    syncFromChromeBookmarks({ silent: true });
  }
}

async function moveChromeBookmarkTo(item, category) {
  if (!hasChromeBookmarksApi() || !item.id) return;
  isWritingChrome = true;
  try {
    const tree = await chromeBookmarkTree();
    const bookmarksBar = findBookmarksBarRoot(tree);
    if (!bookmarksBar) return;
    const targetFolder = category === 'Bookmark Bar'
      ? bookmarksBar
      : findFolderChild(bookmarksBar, category) || await chromeBookmarkCreate({ parentId: bookmarksBar.id, title: category });
    await chromeBookmarkMove(item.id, { parentId: targetFolder.id });
  } catch (error) {
    alert(`Could not move Chrome bookmark.\n\n${error && error.message ? error.message : error}`);
  } finally {
    isWritingChrome = false;
    syncFromChromeBookmarks({ silent: true });
  }
}

function findChromeBookmarkNode(nodes, id, parent = null) {
  for (const node of nodes || []) {
    if (String(node.id) === String(id)) return { node, parent };
    const found = findChromeBookmarkNode(node.children, id, node);
    if (found) return found;
  }
  return null;
}

async function reorderChromeBookmark(draggedId, targetId, placeAfter) {
  if (!hasChromeBookmarksApi() || !draggedId || !targetId || String(draggedId) === String(targetId)) return;
  isWritingChrome = true;
  try {
    const tree = await chromeBookmarkTree();
    const dragged = findChromeBookmarkNode(tree, draggedId);
    const target = findChromeBookmarkNode(tree, targetId);
    if (!dragged || !target || !target.parent || !target.node.url) return;

    const remainingChildren = (target.parent.children || [])
      .filter(node => String(node.id) !== String(draggedId));
    const targetIndex = remainingChildren.findIndex(node => String(node.id) === String(targetId));
    if (targetIndex < 0) return;

    await chromeBookmarkMove(dragged.node.id, {
      parentId: target.parent.id,
      index: targetIndex + (placeAfter ? 1 : 0)
    });
  } catch (error) {
    alert(`Could not reorder Chrome bookmark.\n\n${error && error.message ? error.message : error}`);
  } finally {
    isWritingChrome = false;
    syncFromChromeBookmarks({ silent: true });
  }
}

async function deleteChromeBookmark(item) {
  if (!hasChromeBookmarksApi() || !item.id) return false;
  isWritingChrome = true;
  try {
    await chromeBookmarkRemove(item.id);
    return true;
  } catch (error) {
    alert(`Could not delete Chrome bookmark.\n\n${error && error.message ? error.message : error}`);
    return false;
  } finally {
    isWritingChrome = false;
    syncFromChromeBookmarks({ silent: true });
  }
}

async function renameChromeBookmark(item, title) {
  const nextTitle = String(title || '').replace(/\s+/g, ' ').trim();
  if (!nextTitle || nextTitle === item.title || !hasChromeBookmarksApi() || !item.id) return false;
  isWritingChrome = true;
  try {
    await chromeBookmarkUpdate(item.id, { title: nextTitle });
    item.title = nextTitle;
    return true;
  } catch (error) {
    alert(`Could not rename bookmark.\n\n${error && error.message ? error.message : error}`);
    return false;
  } finally {
    isWritingChrome = false;
    syncFromChromeBookmarks({ silent: true });
  }
}

function rebuildIndexes() {
  baseBookmarks = allBookmarks;
  bookmarks = baseBookmarks;
  byCategory = new Map();
  for (const item of bookmarks) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }
  categoryNames = ['All Bookmarks', ...byCategory.keys()];
  categoryColor = new Map(categoryNames.map((name, index) => [name, palette[index % palette.length]]));
  meta.textContent = `${baseBookmarks.length} links`;
}

function initials(item) {
  const source = item.domain || item.title || '?';
  return source.replace(/^www\./, '').slice(0, 1).toUpperCase();
}

function shortTitle(item) {
  return String(item.title || item.domain || item.url || initials(item)).trim();
}

function compactTitle(item) {
  const domainName = (item.domain || '')
    .replace(/\.(com|org|net|io|ai|dev|app|edu|gov)$/i, '')
    .split('.')[0];
  const raw = item.title && item.title !== item.url ? item.title : domainName || item.url;
  const cleaned = String(raw || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\s*[-|–—:]\s*.*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length > 1) return words.slice(0, 3).join(' ');
  return cleaned.slice(0, 14) || initials(item);
}

async function updateTitlesToShortNamesOnce() {
  if (!hasChromeBookmarksApi() || isWritingChrome || !allBookmarks.length) return;
  if (localStorage.getItem(SHORT_TITLE_MIGRATION_KEY) === 'done') return;
  isWritingChrome = true;
  let changed = false;
  try {
    for (const item of allBookmarks) {
      if (!item.id) continue;
      const nextTitle = compactTitle(item);
      if (!nextTitle || nextTitle === item.title) continue;
      await chromeBookmarkUpdate(item.id, { title: nextTitle });
      changed = true;
    }
    localStorage.setItem(SHORT_TITLE_MIGRATION_KEY, 'done');
  } catch (error) {
    alert(`Could not update bookmark titles.\n\n${error && error.message ? error.message : error}`);
  } finally {
    isWritingChrome = false;
    if (changed) syncFromChromeBookmarks({ silent: true });
  }
}

function faviconUrl(item) {
  return faviconUrls(item)[0] || '';
}

function faviconUrls(item) {
  try {
    const url = new URL(item.url);
    const fallback = `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(url.href)}&sz=128`;
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      return [
        chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url.href)}&size=128`),
        fallback
      ];
    }
    return [fallback];
  } catch {
    return [];
  }
}

function prepareSlidingTitle(title) {
  requestAnimationFrame(() => {
    if (title.classList.contains('is-editing')) return;
    const text = title.querySelector('.title-text');
    if (!text) return;
    const overflow = text.scrollWidth - title.clientWidth;
    title.classList.toggle('is-overflow', overflow > 2);
    title.style.setProperty('--title-shift', `${Math.max(0, overflow + 14)}px`);
  });
}

function beginTitleEdit(item, title, titleText, tile) {
  if (title.classList.contains('is-editing')) return;
  const original = titleText.textContent;
  title.classList.remove('is-overflow');
  title.classList.add('is-editing');
  tile.draggable = false;
  titleText.contentEditable = 'plaintext-only';
  titleText.textContent = original;
  titleText.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(titleText);
  selection.removeAllRanges();
  selection.addRange(range);

  let finished = false;
  const onKeyDown = event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      titleText.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };

  const finish = async save => {
    if (finished) return;
    finished = true;
    titleText.removeEventListener('keydown', onKeyDown);
    titleText.contentEditable = 'false';
    title.classList.remove('is-editing');
    tile.draggable = true;
    const nextTitle = titleText.textContent;
    if (!save || !nextTitle.trim()) {
      titleText.textContent = original;
      prepareSlidingTitle(title);
      return;
    }
    const saved = await renameChromeBookmark(item, nextTitle);
    titleText.textContent = saved ? item.title : original;
    tile.title = `${titleText.textContent}\n${item.url}`;
    prepareSlidingTitle(title);
  };

  titleText.addEventListener('blur', () => finish(true), { once: true });
  titleText.addEventListener('keydown', onKeyDown);
}

function scoreSize(item) {
  void item;
  return '';
}

function matches(item) {
  if (state.category !== 'All Bookmarks' && item.category !== state.category) return false;
  if (!state.query) return true;
  const haystack = normalize(`${item.title} ${item.url} ${item.domain} ${item.category}`);
  return haystack.includes(state.query);
}

function moveBookmark(id, category) {
  const base = allBookmarks.find(item => item.id === id);
  if (!base || !category || category === 'All Bookmarks') return;
  if (state.category !== 'All Bookmarks' && state.category !== category) {
    state.category = category;
  }
  moveChromeBookmarkTo(base, category);
}

function makeDropTarget(element, category) {
  element.classList.add('drop-target');
  element.addEventListener('dragover', event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    element.classList.add('drop-over');
  });
  element.addEventListener('dragleave', () => element.classList.remove('drop-over'));
  element.addEventListener('drop', event => {
    event.preventDefault();
    element.classList.remove('drop-over');
    const id = event.dataTransfer.getData('application/x-metro-bookmark-id') || event.dataTransfer.getData('text/plain');
    moveBookmark(id, category);
  });
}

function clearTileDropMarkers() {
  document.querySelectorAll('.tile.drop-before, .tile.drop-after').forEach(tile => {
    tile.classList.remove('drop-before', 'drop-after');
  });
}

function makeTileSortTarget(tile, item) {
  const updateDropPosition = event => {
    const draggedId = event.dataTransfer.getData('application/x-metro-bookmark-id')
      || event.dataTransfer.getData('text/plain')
      || activeDraggedBookmarkId;
    if (!draggedId || String(draggedId) === String(item.id)) return false;
    const rect = tile.getBoundingClientRect();
    const placeAfter = event.clientX >= rect.left + rect.width / 2;
    tile.classList.toggle('drop-before', !placeAfter);
    tile.classList.toggle('drop-after', placeAfter);
    tile.dataset.dropPosition = placeAfter ? 'after' : 'before';
    return true;
  };

  tile.addEventListener('dragover', event => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    updateDropPosition(event);
  });
  tile.addEventListener('dragleave', event => {
    if (event.relatedTarget && tile.contains(event.relatedTarget)) return;
    tile.classList.remove('drop-before', 'drop-after');
  });
  tile.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    const draggedId = event.dataTransfer.getData('application/x-metro-bookmark-id')
      || event.dataTransfer.getData('text/plain')
      || activeDraggedBookmarkId;
    const placeAfter = tile.dataset.dropPosition === 'after';
    clearTileDropMarkers();
    reorderChromeBookmark(draggedId, item.id, placeAfter);
  });
}

function filteredItems() {
  return bookmarks.filter(matches);
}

function renderNav() {
  nav.innerHTML = '';
  const visibleBookmarks = bookmarks;
  for (const name of categoryNames) {
    const count = name === 'All Bookmarks'
      ? visibleBookmarks.length
      : (byCategory.get(name) || []).length;
    const block = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `category-row ${name === state.category ? 'active' : ''}`.trim();
    button.style.setProperty('--accent', categoryColor.get(name));
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = name;
    const counter = document.createElement('span');
    counter.className = 'count';
    counter.textContent = count;
    button.append(dot, label, counter);
    button.addEventListener('click', () => {
      state.category = name;
      render();
    });
    if (name !== 'All Bookmarks') makeDropTarget(button, name);
    block.appendChild(button);
    nav.appendChild(block);
  }
}

function renderGroups() {
  const items = filteredItems();

  const densityVars = {
    compact: ['72px', '72px'],
    normal: ['86px', '86px'],
    roomy: ['102px', '102px']
  }[state.density];
  document.documentElement.style.setProperty('--tile-min', densityVars[0]);
  document.documentElement.style.setProperty('--tile-row', densityVars[1]);

  if (!items.length) {
    groups.innerHTML = '<div class="empty">No matching bookmarks.</div>';
    return;
  }

  const byGroup = new Map();
  for (const item of items) {
    const name = item.category;
    if (!byGroup.has(name)) byGroup.set(name, []);
    byGroup.get(name).push(item);
  }

  groups.innerHTML = '';
  for (const entries of byGroup.values()) {
    const cluster = document.createElement('section');
    cluster.className = 'group';
    cluster.setAttribute('aria-label', entries[0].category);
    const tileGrid = document.createElement('div');
    tileGrid.className = 'tiles';
    const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(entries.length))));
    tileGrid.style.gridTemplateColumns = `repeat(${columns}, var(--tile-min, 86px))`;
    tileGrid.style.setProperty('--mobile-columns', Math.min(3, columns));

    for (const item of entries) {
      const tile = document.createElement('div');
      tile.className = `tile ${scoreSize(item)} ${item.status !== 'ok' ? item.status : ''}`.trim();
      tile.draggable = true;
      tile.title = `${item.title}\n${item.url}`;
      tile.dataset.statusLabel = item.status === 'broken' ? 'broken' : item.status === 'maybe' ? 'check' : '';
      tile.style.setProperty('--accent', categoryColor.get(item.category) || '#00a99d');
      tile.addEventListener('dragstart', event => {
        activeDraggedBookmarkId = String(item.id);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-metro-bookmark-id', item.id);
        event.dataTransfer.setData('text/plain', item.id);
        tile.classList.add('dragging');
      });
      tile.addEventListener('dragend', () => {
        activeDraggedBookmarkId = '';
        tile.classList.remove('dragging');
        clearTileDropMarkers();
      });
      makeTileSortTarget(tile, item);
      const link = document.createElement('a');
      link.className = 'tile-link';
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      const body = document.createElement('div');
      const domain = document.createElement('div');
      domain.className = 'domain';
      domain.textContent = item.domain || item.category;
      const initial = document.createElement('div');
      initial.className = 'initial';
      const title = document.createElement('div');
      title.className = 'title';
      const titleText = document.createElement('span');
      titleText.className = 'title-text';
      titleText.textContent = shortTitle(item);
      titleText.title = 'Click to rename';
      titleText.addEventListener('pointerdown', event => {
        event.stopPropagation();
      });
      titleText.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        beginTitleEdit(item, title, titleText, tile);
      });
      title.appendChild(titleText);
      const icon = document.createElement('img');
      icon.className = 'favicon';
      icon.alt = '';
      icon.loading = 'lazy';
      const iconSources = faviconUrls(item);
      if (iconSources.length) {
        icon.src = iconSources[0];
        initial.classList.add('has-icon');
        let iconSourceIndex = 0;
        icon.addEventListener('error', () => {
          iconSourceIndex += 1;
          if (iconSources[iconSourceIndex]) {
            icon.src = iconSources[iconSourceIndex];
            return;
          }
          icon.classList.add('is-hidden');
          initial.classList.remove('has-icon');
        });
      } else {
        icon.classList.add('is-hidden');
      }
      initial.append(icon, title);
      prepareSlidingTitle(title);
      body.append(domain);
      link.append(body, initial);
      const deleteButton = document.createElement('button');
      deleteButton.className = 'delete-tile';
      deleteButton.type = 'button';
      deleteButton.textContent = '×';
      deleteButton.title = 'Delete bookmark';
      deleteButton.setAttribute('aria-label', `Delete ${item.title}`);
      deleteButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (!confirm(`Delete this bookmark?\n\n${item.title}`)) return;
        deleteChromeBookmark(item);
      });
      tile.append(link, deleteButton);
      tileGrid.appendChild(tile);
    }
    cluster.appendChild(tileGrid);
    groups.appendChild(cluster);
  }
}

function render() {
  rebuildIndexes();
  renderNav();
  renderGroups();
}

search.addEventListener('input', event => {
  state.query = normalize(event.target.value.trim());
  renderGroups();
});

document.querySelectorAll('[data-density]').forEach(button => {
  button.addEventListener('click', () => {
    state.density = button.dataset.density;
    document.querySelectorAll('[data-density]').forEach(item => item.classList.toggle('active', item === button));
    renderGroups();
  });
});

if (hasChromeBookmarksApi()) {
  installChromeBookmarkAutoSync();
  syncFromChromeBookmarks({ silent: true });
}

render();
