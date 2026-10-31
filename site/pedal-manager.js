// Pedal manager (pedal-manager.html): the patch memories of the pedal, read over Web MIDI (pedal-midi.js),
// next to the patches saved in this browser (My patches of the builder). A pedal patch can be opened in the
// builder, copied to My patches or downloaded; a local patch can be sent to the selected memory. Every write first
// reads the target memory and keeps it as a backup (localStorage and a downloaded .zptc), asks for confirmation,
// then reads the memory back and compares it with what was sent.
(() => {
  const $ = selector => document.querySelector(selector);
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NO_MIDI = 'This browser has no Web MIDI. Use Chrome or Edge on a computer.';
  const LIBRARY_KEY = `${PEDAL.id}-library`; // shared with the builder: [{ id, name, effects: [{ index, on, values }], output, updatedAt }]
  const DELETED_KEY = `${PEDAL.id}-deleted`; // { patchId: ISO time }: deletions waiting to reach other devices, kept by the builder too
  const DRAFT_KEY = `${PEDAL.id}-builder`;
  const EDIT_KEY = `${PEDAL.id}-pedal-edit`; // { memory, name, base: base64 PTCF, at } while a memory is edited in the builder
  const PEDAL_SYNC_KEY = `${PEDAL.id}-pedal-sync`; // { enabled, links: { memory: { patchId, pedalBaseline, libraryBaseline } } }
  const CLEARED_NAME = 'Empty'; // name of a cleared memory: no effects, only the BLANK slot
  // [{ id, memory, name, at, data: base64 of the whole memory }], newest first. A deleted backup stays as { id, deleted: true, at }
  // for 90 days, so that an account does not bring it back (backups are only ever added when two copies are merged)
  const BACKUP_KEY = `${PEDAL.id}-usb-backups`;
  const MAX_BACKUPS = 30;
  const GRAVE_MS = 90 * 864e5;
  // The memories as last read, so the list stays visible (greyed, read-only) while the pedal is not connected:
  // { at, count, memories: { n: base64 of the PTCF file | null for an empty memory } }
  const LAST_READ_KEY = `${PEDAL.id}-usb-last-read`;
  const PEDAL_HINT = 'Select a memory: it is where a patch from My patches goes. Drag a memory to another place to change the order, then Write.';
  const lines = [];
  let info = null; // { count, size, bankSize } from the pedal
  let connected = false;
  let reading = 0; // bumps on every full read, so an older read stops
  let busy = false; // a full read or a write is running: one exchange with the pedal at a time
  let fullRead = false; // readAll() is running: the last-read list is saved once, at the end
  const memories = new Map(); // number → { state: 'loading' | 'ok' | 'empty' | 'error', data, memory, decoded, error }
  let selected = null; // memory number where a local patch goes
  let fileItem = null; // { name, bytes } from "Send a .zptc file"
  let renaming = null; // memory number whose rename field is open
  let staleOpen = null; // memory number whose saved patch is open in the list shown while the pedal is not connected
  function needsReadAgain() {
    return connected && [...memories.values()].some(m => m.state === 'error' || (m.state === 'ok' && !m.crcOk));
  }
  function updateReadAgainButton() {
    const button = $('#usb-refresh');
    button.classList.toggle('btn-warning', needsReadAgain());
    button.title = needsReadAgain() ? 'A memory needs to be read again' : 'Read all pedal memories again';
  }
  // "Send to memory N" in the builder opens this page with #send=N: once the pedal is read, the builder's patch goes there
  let pendingSend = Number(new URLSearchParams(location.hash.replace(/^#/, '')).get('send')) || null;
  if (pendingSend) history.replaceState(null, '', location.pathname);

  // ---- log and status --------------------------------------------------------------------------------
  const showLog = () => { $('#usb-log').textContent = lines.join('\n'); };
  PEDALMIDI.onLog((dir, bytes) => {
    const text = PEDALMIDI.hex(bytes);
    lines.push(`${new Date().toISOString().slice(11, 23)} ${dir === 'out' ? '→' : '←'} ${bytes.length} B  ${text.length > 600 ? `${text.slice(0, 600)} …` : text}`);
    if (lines.length > 2000) lines.splice(0, lines.length - 2000);
    showLog();
  });
  const note = text => { lines.push(`   ${text}`); showLog(); };
  // Octicons "upload": the send button of each patch (its tooltip names the memory)
  const ICON_SEND = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path fill="currentColor" d="M11.78 4.72a.749.749 0 1 1-1.06 1.06L8.75 3.811V9.5a.75.75 0 0 1-1.5 0V3.811L5.28 5.78a.749.749 0 1 1-1.06-1.06l3.25-3.25a.749.749 0 0 1 1.06 0l3.25 3.25Z"/></svg>';
  // Octicons "trash": the delete control of each My patches row
  const ICON_TRASH = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>';
  const status = (text, kind = '') => { $('#usb-status').textContent = text; $('#usb-status').dataset.kind = kind; };
  const result = (ok, text, action = null) => {
    if (!text) { $('#usb-result').innerHTML = ''; return; }
    const reread = action?.type === 'reread' && Number.isInteger(action.memory)
      ? `<button class="btn btn-sm btn-warning usb-read-again" data-result-act="reread" data-memory="${action.memory}">Read again</button>`
      : '';
    $('#usb-result').innerHTML = `<div class="usb-result" data-ok="${ok}"><p>${escapeHtml(text)}</p>${reread}</div>`;
  };
  // Runs one step; a failure shows in the status line and the log
  async function step(label, fn) {
    status(`${label}…`);
    try { return { ok: true, value: await fn() }; } catch (error) {
      status(error.message, 'danger');
      note(`${label} failed: ${error.message}`);
      return { ok: false, value: null, error };
    }
  }

  // ---- helpers ---------------------------------------------------------------------------------------
  const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
  const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const ptcfOf = bytes => bytes.slice(0, Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true) || bytes.length));
  const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const validBase64 = value => typeof value === 'string' && value.length >= 12 && value.length <= 200_000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  const validBackup = backup => {
    if (!backup || typeof backup !== 'object' || typeof backup.id !== 'string' || backup.id.length > 80 || !validDate(backup.at)) return false;
    if (backup.deleted === true) return true;
    if (Array.isArray(backup.group)) return backup.group.length > 0 && backup.group.every(item => Number.isInteger(item?.memory) && typeof item.name === 'string' && validBase64(item.data));
    return Number.isInteger(backup.memory) && typeof backup.name === 'string' && validBase64(backup.data);
  };
  const when = iso => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const fileName = text => text.replace(/[^A-Za-z0-9 ._-]/g, '').trim() || 'PATCH';
  const download = (bytes, name) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const chainText = names => names.length ? names.join(' → ') : 'no effects';
  // The chain of a decoded patch as effect cards with their pedal images, in signal order
  const chainCards = d => d.effects.length ? `<ol class="usb-fx">${d.effects.map(e => {
    const index = EFFECTS_DATA.findIndex(fx => fx[0] === e.effect);
    const category = CATEGORIES[EFFECTS_DATA[index]?.[1]];
    return `<li class="${e.on ? '' : 'is-off'}">
      ${index === -1 ? '' : `<img class="fx-thumb" src="assets/effects/fx-${String(index).padStart(3, '0')}.png" alt="" width="40" height="50" loading="lazy" />`}
      <span><b>${escapeHtml(e.effect)}</b><span class="usb-fx-tags">${category ? `<span class="Label">${escapeHtml(category.label)}</span>` : ''}${e.on ? '' : '<span class="Label">Off</span>'}</span></span>
    </li>`;
  }).join('')}</ol>` : '<p class="usb-chain-line">No effects.</p>';

  // Decoded PTCF → builder patch: { name, effects: [{ index, on, values }] }
  function toPatch(decoded, { strict = false } = {}) {
    const effects = decoded.effects.flatMap(e => {
      const index = EFFECTS_DATA.findIndex(fx => fx[0] === e.effect);
      if (index === -1) {
        if (strict) throw new Error(`The pedal patch contains an effect not available in My patches: ${e.effect}`);
        return [];
      }
      const values = Object.fromEntries(Object.entries(e.params).map(([n, v]) => [n, v && typeof v === 'object' ? v.raw : v]));
      return [{ index, on: e.on, values }];
    });
    return { name: decoded.name.replace(/[^!%&'+,\-.=_ A-Za-z0-9]/g, '').trim().slice(0, 28) || 'PEDAL', effects };
  }
  // Builder patch → PTCF bytes, encoded like the builder's Download .zptc. With base (the PTCF of the pedal
  // memory it was opened from), the data the builder does not edit is kept: description, header, slot layout and
  // the patch data in PRM2 (the bits that follow the chain are recomputed).
  function toFile(patch, base = null) {
    if (!patch.effects?.length) throw new Error('The patch has no effects.');
    if (!String(patch.name || '').trim()) throw new Error('The patch has no name. Give it one in the patch builder first.');
    let kept = {};
    if (base) {
      const b = ZPTC.decode(base);
      kept = { _version: b._version, _header: b._header, _txj1: b._txj1, _slot0: b._slot0, _noBlank: b._noBlank, _prm2: b._prm2, _prm2Refresh: true,
        description: b.description, shortName: patch.name.trim() === b.name ? b.shortName : undefined };
      Object.keys(kept).forEach(k => kept[k] === undefined && delete kept[k]);
    }
    return ZPTC.encode({
      ...kept,
      name: patch.name.trim(),
      effects: patch.effects.filter(e => EFFECTS_DATA[e.index]).map(e => ({
        effect: EFFECTS_DATA[e.index][0], on: e.on !== false,
        params: Object.fromEntries(EFFECTS_DATA[e.index][5].map(([n, , range]) => [n, ZPTC.codec(range, n) ? e.values?.[n] : { raw: Number(e.values?.[n]) || 0 }]))
      }))
    }).file;
  }

  // ---- connection ------------------------------------------------------------------------------------
  async function listPorts() {
    const { inputs, outputs } = await PEDALMIDI.ports();
    const options = list => list.map(p => `<option value="${escapeHtml(p.id)}"${/zoom/i.test(p.name) ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
    $('#usb-in').innerHTML = options(inputs);
    $('#usb-out').innerHTML = options(outputs);
  }
  function setConnected(on) {
    connected = on;
    staleOpen = null;
    $('#usb-connect').hidden = on;
    $('#usb-disconnect').hidden = !on;
    $('#usb-howto').hidden = on; // the instructions are for a pedal that is not connected yet
    $('.usb-connect').classList.toggle('is-connected', on); // the pedal in the connection box: dim when off, in colour when connected
    $('#usb-refresh').disabled = !on || !info;
    updateReadAgainButton();
    renderMemories();
    renderLocals();
    renderBackups();
    syncSettingText();
  }

  // The page is a new page each time the visitor goes elsewhere in the site, so the connection is made again by itself
  // when it was open before and the browser still allows MIDI with SysEx (no prompt: it only asks when it was never granted)
  const AUTO_KEY = `${PEDAL.id}-usb-auto`;
  const setAuto = on => { try { if (on) localStorage.setItem(AUTO_KEY, '1'); else localStorage.removeItem(AUTO_KEY); } catch {} };
  async function autoConnect() {
    let wanted = false;
    try { wanted = localStorage.getItem(AUTO_KEY) === '1'; } catch {}
    if (!wanted || !PEDALMIDI.supported()) return;
    try { if ((await navigator.permissions.query({ name: 'midi', sysex: true })).state !== 'granted') return; } catch { return; }
    status('Reconnecting the pedal…');
    $('#usb-connect').click();
  }
  $('#usb-connect').addEventListener('click', async () => {
    if (!PEDALMIDI.supported()) { status(NO_MIDI, 'danger'); return; }
    if (!(await step('Asking for MIDI access', listPorts)).ok) return;
    const ports = await step('Connecting', () => PEDALMIDI.connect($('#usb-in').value, $('#usb-out').value));
    if (!ports.ok) return;
    note(`Ports: ${ports.value.input} / ${ports.value.output}`);
    const id = await step('Identifying the pedal', PEDALMIDI.identify);
    if ((await step('Editor mode', PEDALMIDI.editorOn)).ok) info = (await step('Reading the patch memory size', PEDALMIDI.patchInfo)).value;
    $('#usb-facts').textContent = [ports.value.output, id.ok && `firmware ${id.value.version}`, info && `${info.count} memories`].filter(Boolean).join(' · ');
    setConnected(true);
    setAuto(true);
    if (info) readAll();
  });
  async function disconnect() {
    setAuto(false); // a Disconnect pressed on purpose: the next visit does not connect by itself
    reading++;
    try { await PEDALMIDI.editorOff(); } catch {}
    PEDALMIDI.disconnect();
    info = null;
    $('#usb-facts').textContent = '';
    setConnected(false);
    status('Not connected');
  }
  $('#usb-disconnect').addEventListener('click', disconnect);
  window.addEventListener('pagehide', () => { PEDALMIDI.editorOff().catch(() => {}); });

  // ---- pedal memories --------------------------------------------------------------------------------
  async function readOne(number) {
    memories.set(number, { state: 'loading' });
    try {
      const r = await PEDALMIDI.readMemory(number, info);
      if (!r) { memories.set(number, { state: 'empty' }); return; }
      let decoded = null, error = null;
      try { decoded = ZPTC.decode(r.data); } catch (e) { error = e.message; }
      memories.set(number, { state: decoded ? 'ok' : 'error', data: r.data, memory: r.memory, crcOk: r.crcOk, decoded, error: error || (r.crcOk ? null : 'checksum mismatch') });
    } catch (e) {
      memories.set(number, { state: 'error', error: e.message });
      note(`Memory ${number}: ${e.message}`);
    }
    updateReadAgainButton();
    if (!fullRead) saveLastRead();
  }
  function saveLastRead() {
    if (!info) return;
    const saved = readJson(LAST_READ_KEY, null);
    const list = saved?.count === info.count ? { ...saved.memories } : {};
    memories.forEach((m, n) => { if (m.state === 'ok') list[n] = toBase64(m.data); else if (m.state === 'empty') list[n] = null; });
    try { localStorage.setItem(LAST_READ_KEY, JSON.stringify({ at: new Date().toISOString(), count: info.count, memories: list })); } catch {}
  }
  // Rows of the last-read list: name and summary of each memory, decoded again from the saved files; a readable
  // memory also carries its file (data) and what it holds (decoded: the effects), so it can be opened without the pedal
  function lastRead() {
    const saved = readJson(LAST_READ_KEY, null);
    if (!saved?.count) return null;
    const rows = Array.from({ length: saved.count }, (_, i) => {
      const n = i + 1, data = saved.memories?.[n];
      if (data === null) return { n, state: 'empty', name: '(empty)', meta: '' };
      if (!data) return { n, state: 'empty', name: 'Not read', meta: '' };
      try {
        const bytes = fromBase64(data);
        const decoded = ZPTC.decode(bytes);
        return { n, state: 'ok', name: decoded.name || '(no name)', meta: `${decoded.effects.length} fx · ${decoded.dspTotal.toFixed(1)}%`, data: bytes, decoded };
      } catch { return { n, state: 'error', name: 'Unreadable', meta: '' }; }
    });
    return { at: saved.at, rows };
  }
  async function readAll() {
    const run = ++reading;
    busy = true;
    fullRead = true;
    renderLocals();
    memories.clear();
    for (let n = 1; n <= info.count; n++) memories.set(n, { state: 'loading' });
    renderMemories();
    for (let n = 1; n <= info.count; n++) {
      if (run !== reading || !connected) { busy = false; fullRead = false; return; }
      status(`Reading memory ${n} of ${info.count}…`);
      await readOne(n);
      renderMemory(n);
    }
    busy = false;
    fullRead = false;
    saveLastRead();
    renderLocals();
    const failed = [...memories.values()].filter(m => m.state === 'error').length;
    status(failed ? `Connected: ${failed} of ${info.count} memories with errors (see the MIDI log)` : 'Connected', failed ? 'danger' : 'ok');
    await offerLinkedChanges(Array.from({ length: info.count }, (_, i) => i + 1));
    if (pendingSend) sendPending();
  }
  function sendPending() {
    const n = pendingSend;
    pendingSend = null;
    const item = localItems().find(i => i.key === 'draft');
    if (!item?.bytes) { status(item?.error || 'The builder has no patch to send.', 'danger'); return; }
    if (n > info.count) return;
    if (selected !== n) select(n);
    $(`#usb-memories [data-n="${n}"]`)?.scrollIntoView({ block: 'nearest' });
    send(n, item.bytes);
  }
  $('#usb-refresh').addEventListener('click', () => { if (info) readAll(); });
  $('#usb-result').addEventListener('click', async event => {
    const button = event.target.closest('[data-result-act="reread"]');
    if (!button || !connected || busy) return;
    const n = Number(button.dataset.memory);
    if (!Number.isInteger(n) || !info?.count || n < 1 || n > info.count) return;
    button.disabled = true;
    await readOne(n);
    renderMemory(n);
    const m = memories.get(n);
    updateReadAgainButton();
    if (m?.state === 'ok' && m.crcOk) result(true, `Memory ${n} read again successfully. You can arrange again.`);
    else result(false, `Memory ${n} still needs to be read correctly.`, { type: 'reread', memory: n });
    status(m?.state === 'ok' && m.crcOk ? `Memory ${n} read again` : `Memory ${n} needs to be read again`, m?.state === 'ok' && m.crcOk ? 'ok' : 'danger');
    await offerLinkedChanges([n]);
  });

  function memoryHtml(n) {
    const m = memories.get(n) || { state: 'loading' };
    const d = m.decoded;
    const linked = m.state === 'ok' && m.crcOk ? syncInfo(n) : null;
    const linkedPatch = readPedalSync().links[n]?.patchId;
    const linkLabel = linkedPatch ? 'Change My patch link' : 'Link to My patch';
    const isSelected = n === selected;
    const name = m.state === 'ok' ? d.name || '(no name)' : m.state === 'loading' ? 'Reading…' : m.state === 'empty' ? '(empty)' : `Unreadable: ${m.error}`;
    const meta = m.state === 'ok' ? `${d.effects.length} fx · ${d.dspTotal.toFixed(1)}%${linked && !linked.error ? ' · changed' : ''}` : '';
    const drag = canArrange() && renaming !== n;
    return `<li class="usb-mem${isSelected ? ' is-selected' : ''}${drag ? ' is-draggable' : ''}" data-n="${n}" data-state="${m.state}"${drag ? ' draggable="true"' : ''}>
      <button class="usb-mem-main" data-act="select" aria-pressed="${isSelected}" ${m.state === 'loading' ? 'disabled' : ''}>
        <span class="usb-num">${n}</span><span class="usb-name">${escapeHtml(name)}</span><span class="usb-meta">${escapeHtml(meta)}</span>${drag ? '<span class="usb-grip" aria-hidden="true" title="Drag to another place">⠿</span>' : ''}
      </button>
      ${isSelected && m.state === 'error' ? `<div class="usb-mem-detail">
        <p class="usb-warn">${escapeHtml(m.error || 'This memory could not be read.')} It cannot be shown, renamed or moved${m.memory ? '' : '; nothing was received from the pedal, so it cannot be cleared either'}.</p>
        <div class="usb-row">
          <button class="btn btn-sm btn-warning usb-read-again" data-act="reread" ${connected && !busy ? '' : 'disabled'}>Read again</button>
          <button class="btn btn-sm btn-danger usb-clear" data-act="clear" ${connected && !busy && m.memory ? '' : 'disabled'} title="A backup of what the memory holds now is kept first">Clear patch</button>
        </div>
      </div>` : ''}
      ${isSelected && m.state === 'ok' ? `<div class="usb-mem-detail">
        ${m.crcOk ? '' : `<p class="usb-warn">The pedal sent this memory with a checksum mismatch: it is shown, but it cannot be renamed, moved or replaced until it is read correctly.</p><div class="usb-row"><button class="btn btn-sm btn-warning usb-read-again" data-act="reread" ${connected && !busy ? '' : 'disabled'}>Read again</button></div>`}
        ${linked?.error ? `<p class="usb-warn">This linked patch cannot be updated: ${escapeHtml(linked.error)}</p>` : linked ? `<p class="usb-warn">This memory changed since it was last linked to <b>${escapeHtml(linked.entry.name)}</b>.</p><div class="usb-row"><button class="btn btn-sm btn-primary" data-act="sync">Review changes</button></div>` : ''}
        ${chainCards(d)}
        ${renaming === n ? `<form class="usb-row usb-rename" data-rename="${n}">
          <label>New name <input class="form-control form-control--sm" name="name" maxlength="28" value="${escapeHtml(d.name)}" required spellcheck="false" autocomplete="off" /></label>
          <button class="btn btn-sm btn-primary" type="submit">Rename on the pedal</button>
          <button class="btn btn-sm btn-invisible" type="button" data-act="rename-cancel">Cancel</button>
        </form>` : ''}
        <div class="usb-row">
          <a class="btn btn-sm btn-primary" href="${PATCHLINK.url(toPatch(d))}&m=${n}" data-act="edit">Edit in builder</a>
          <button class="btn btn-sm" data-act="link">${linkLabel}</button>
          <button class="btn btn-sm" data-act="rename" ${connected && !busy && m.crcOk ? '' : 'disabled'}>Rename</button>
          <button class="btn btn-sm" data-act="copy">Copy to My patches</button>
          <button class="btn btn-sm" data-act="download">Download .zptc</button>
          <button class="btn btn-sm btn-invisible" data-act="reread">Read again</button>
          <button class="btn btn-sm btn-danger usb-clear" data-act="clear" ${connected && !busy && (d.effects.length || d.name !== CLEARED_NAME) ? '' : 'disabled'} title="Saves the memory as an empty patch, after a backup of this one">Clear patch</button>
        </div>
      </div>` : ''}
    </li>`;
  }
  // Not connected: a memory of the saved list. A readable one opens to its effects, and can be copied or downloaded
  // (what needs the pedal stays out of this list)
  let staleRows = null;
  function staleHtml(r) {
    const open = r.n === staleOpen && !!r.decoded;
    return `<li class="usb-mem is-stale${open ? ' is-selected' : ''}" data-n="${r.n}" data-state="${r.state}">
      <button class="usb-mem-main" data-act="stale-open" aria-pressed="${open}" ${r.decoded ? '' : 'disabled'}>
        <span class="usb-num">${r.n}</span><span class="usb-name">${escapeHtml(r.name)}</span><span class="usb-meta">${escapeHtml(r.meta)}</span>
      </button>
      ${open ? `<div class="usb-mem-detail">
        ${chainCards(r.decoded)}
        <div class="usb-row">
          <button class="btn btn-sm" data-act="copy">Copy to My patches</button>
          <button class="btn btn-sm" data-act="download">Download .zptc</button>
        </div>
      </div>` : ''}
    </li>`;
  }
  function renderMemories() {
    const hint = $('#usb-pedal-hint');
    const last = !connected && lastRead();
    hint.textContent = PEDAL_HINT;
    delete hint.dataset.kind;
    if (last) {
      const when = new Date(last.at).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      hint.textContent = `Not connected: the patches and their effects as last read on ${when}. Select a patch to see its effects. They may have changed on the pedal since; connect it to work on them.`;
      hint.dataset.kind = 'stale';
      staleRows = last.rows;
      $('#usb-pedal-count').textContent = last.rows.length;
      $('#usb-memories').innerHTML = last.rows.map(staleHtml).join('');
      return;
    }
    staleRows = null;
    const count = info?.count ?? 0;
    $('#usb-pedal-count').textContent = count;
    $('#usb-memories').innerHTML = !connected ? '<li class="usb-empty">Connect the pedal to see its patch memories.</li>'
      : !count ? '<li class="usb-empty">The pedal did not report its patch memories.</li>'
      : Array.from({ length: count }, (_, i) => memoryHtml(i + 1)).join('');
  }
  function renderMemory(n) {
    const item = $(`#usb-memories [data-n="${n}"]`);
    if (item) item.outerHTML = memoryHtml(n);
  }
  function select(n) {
    const previous = selected;
    selected = selected === n ? null : n;
    if (previous) renderMemory(previous);
    if (selected) renderMemory(selected);
    renderLocals();
  }

  $('#usb-memories').addEventListener('click', async event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const n = Number(button.closest('[data-n]').dataset.n);
    const m = connected ? memories.get(n) : staleRows?.find(r => r.n === n); // saved copy while the pedal is not connected
    switch (button.dataset.act) {
      case 'stale-open': {
        const previous = staleOpen;
        staleOpen = staleOpen === n ? null : n;
        for (const k of new Set([previous, staleOpen])) {
          const row = staleRows.find(r => r.n === k);
          if (row) $(`#usb-memories [data-n="${k}"]`).outerHTML = staleHtml(row);
        }
        $(`#usb-memories [data-n="${n}"] .usb-mem-main`)?.focus();
        break;
      }
      case 'select': renaming = null; select(n); break;
      case 'link': await linkExistingMemory(n); break;
      case 'edit': // remember where the patch comes from, so the builder can send it back to this memory
        try { localStorage.setItem(EDIT_KEY, JSON.stringify({ memory: n, name: m.decoded.name, base: toBase64(m.data), at: new Date().toISOString(), pending: true })); } catch {}
        break;
      case 'rename': renaming = n; renderMemory(n); $(`[data-rename="${n}"] input`)?.select(); break;
      case 'rename-cancel': renaming = null; renderMemory(n); break;
      case 'download': download(m.data, `${String(n).padStart(3, '0')} ${fileName(m.decoded.name)}.zptc`); break;
      case 'clear': send(n, ZPTC.encode({ name: CLEARED_NAME, empty: true, effects: [] }).file, true); break;
      case 'reread': await readOne(n); renderMemory(n); status(`Memory ${n} read again`, 'ok'); break;
      case 'sync': await syncMemory(n); break;
      case 'copy': {
        const patch = toPatch(m.decoded);
        const list = readLibrary();
        const entry = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: freeName(patch.name, list), effects: patch.effects, output: null, updatedAt: new Date().toISOString() };
        list.unshift(entry);
        if (!storeLibrary(list)) return;
        linkMemory(n, entry.id, patch);
        renderLocals();
        status(`“${entry.name}” copied to My patches`, 'ok');
        pushUndo(`Copied “${entry.name}” to My patches`, async () => {
          const gone = removePatch(entry.id);
          renderLocals();
          return { ok: true, text: gone ? `“${entry.name}” removed from My patches` : `“${entry.name}” is not in My patches any more` };
        }, { toast: true });
        break;
      }
    }
  });

  // Rename: the same patch re-encoded with the new name (raw values, slots and patch data kept), then written
  // through the usual backup → confirm → write → read-back flow
  function renamed(bytes, name) {
    if (!ZPTC.roundtrip(bytes)) throw new Error('This patch cannot be re-encoded byte for byte yet, so it is not renamed.');
    const spec = ZPTC.decode(bytes);
    return ZPTC.encode({ ...spec, name, shortName: name, empty: !spec.effects.length, effects: spec.effects.map(({ id, on, raw, tail }) => ({ id, on, raw, tail })) }).file;
  }
  $('#usb-memories').addEventListener('submit', event => {
    const form = event.target.closest('[data-rename]');
    if (!form) return;
    event.preventDefault();
    const n = Number(form.dataset.rename);
    const name = form.elements.name.value.trim();
    const m = memories.get(n);
    if (!name || !ZPTC.NAME_CHARS.test(name)) { status('Use letters, digits, spaces and ! % & \' + , - . = _ only.', 'danger'); return; }
    if (name === m.decoded.name) { renaming = null; renderMemory(n); return; }
    let bytes;
    try { bytes = renamed(m.data, name); } catch (error) { status(error.message, 'danger'); return; }
    renaming = null;
    send(n, bytes, false, `Renamed “${m.decoded.name}” to “${name}”`);
  });

  const activeEdit = () => { const edit = readJson(EDIT_KEY, null); return edit?.memory && !edit.pending ? edit : null; };

  // ---- My patches in storage -------------------------------------------------------------------------
  const readLibrary = () => { const list = readJson(LIBRARY_KEY, []); return Array.isArray(list) ? list : []; };
  // Same rules as the builder's writeLibrary: a patch that is gone from the list is remembered as deleted (an account deletes it
  // on the other devices too), and one that comes back after a deletion counts as a new edit, so the deletion does not win
  function storeLibrary(list) {
    const now = new Date().toISOString();
    const saved = readJson(DELETED_KEY, {});
    const deleted = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const ids = new Set(list.map(e => e.id));
    readLibrary().forEach(e => { if (!ids.has(e.id)) deleted[e.id] = now; });
    list.forEach(e => { if (deleted[e.id]) { delete deleted[e.id]; e.updatedAt = now; } });
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(list)); localStorage.setItem(DELETED_KEY, JSON.stringify(deleted)); }
    catch { status('This browser does not allow this site to store data.', 'danger'); return false; }
    if (typeof ACCOUNT !== 'undefined') ACCOUNT.changed();
    return true;
  }

  // ---- pedal → My patches links ---------------------------------------------------------------------
  // The association is deliberately local: memory 12 belongs to this physical pedal, not to every
  // device where the account's patch library is synced.
  function readPedalSync() {
    const saved = readJson(PEDAL_SYNC_KEY, {});
    const links = saved && typeof saved.links === 'object' && !Array.isArray(saved.links) ? saved.links : {};
    return { enabled: saved?.enabled === true, links };
  }
  function writePedalSync(sync) {
    try { localStorage.setItem(PEDAL_SYNC_KEY, JSON.stringify(sync)); return true; }
    catch { status('This browser does not allow pedal sync settings to be saved.', 'danger'); return false; }
  }
  const pedalSyncEnabled = () => readPedalSync().enabled;
  const patchForEntry = entry => ({ name: entry.name, effects: entry.effects || [] });
  function canonicalPatch(patch) {
    return JSON.stringify({
      name: String(patch.name || ''),
      effects: (patch.effects || []).map(effect => ({
        index: effect.index,
        on: effect.on !== false,
        values: Object.fromEntries(Object.entries(effect.values || {}).sort(([a], [b]) => a.localeCompare(b)))
      }))
    });
  }
  function patchDiff(from, to) {
    const changes = [];
    if (String(from.name || '') !== String(to.name || '')) changes.push(`name: “${from.name || '(empty)'}” → “${to.name || '(empty)'}”`);
    const max = Math.max(from.effects?.length || 0, to.effects?.length || 0);
    for (let i = 0; i < max; i++) {
      const a = from.effects?.[i], b = to.effects?.[i];
      if (!a || !b) { changes.push(`effect ${i + 1}: ${a ? 'removed' : 'added'}`); continue; }
      const aName = EFFECTS_DATA[a.index]?.[0] || `effect ${a.index}`;
      const bName = EFFECTS_DATA[b.index]?.[0] || `effect ${b.index}`;
      if (aName !== bName) { changes.push(`effect ${i + 1}: ${aName} → ${bName}`); continue; }
      if ((a.on !== false) !== (b.on !== false)) changes.push(`${aName}: ${b.on === false ? 'turned off' : 'turned on'}`);
      const params = new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})]);
      for (const name of params) if (JSON.stringify(a.values?.[name]) !== JSON.stringify(b.values?.[name])) changes.push(`${aName} ${name}: changed`);
    }
    return { count: changes.length, changes };
  }
  function syncInfo(number) {
    const link = readPedalSync().links[number];
    if (!link?.patchId || !link.pedalBaseline) return null;
    const entry = readLibrary().find(item => item.id === link.patchId);
    const memory = memories.get(number);
    if (!entry || memory?.state !== 'ok' || !memory.crcOk) return null;
    let pedalPatch;
    try { pedalPatch = toPatch(memory.decoded, { strict: true }); }
    catch (error) { return { error: error.message, link, entry }; }
    if (canonicalPatch(pedalPatch) === link.pedalBaseline) return null;
    const libraryPatch = patchForEntry(entry);
    return {
      number, link, entry, pedalPatch, libraryPatch,
      changes: patchDiff(libraryPatch, pedalPatch),
      conflict: link.libraryBaseline && canonicalPatch(libraryPatch) !== link.libraryBaseline
    };
  }
  function linkMemory(number, patchId, patch, libraryPatch = patch) {
    const sync = readPedalSync();
    sync.links[number] = { patchId, pedalBaseline: canonicalPatch(patch), libraryBaseline: canonicalPatch(libraryPatch), updatedAt: new Date().toISOString() };
    writePedalSync(sync);
  }
  function unlinkMemory(number) {
    const sync = readPedalSync();
    if (!sync.links[number]) return;
    delete sync.links[number];
    writePedalSync(sync);
  }
  async function linkExistingMemory(number) {
    const memory = memories.get(number);
    if (memory?.state !== 'ok' || !memory.crcOk) { status('Read the memory correctly before linking it to My patches.', 'danger'); return; }
    const list = readLibrary();
    if (!list.length) { status('There are no My patches to link.', 'danger'); return; }
    let pedalPatch;
    try { pedalPatch = toPatch(memory.decoded, { strict: true }); }
    catch (error) { status(error.message, 'danger'); return; }
    const current = readPedalSync().links[number]?.patchId;
    const body = `<p>Link memory ${number} (“${escapeHtml(memory.decoded.name)}”) to an existing My patch. Nothing on the pedal or in My patches changes.</p>
      <label class="field"><span class="field-label">My patch</span><select class="form-control" id="usb-link-patch">${list.map(entry => `<option value="${escapeHtml(entry.id)}"${entry.id === current ? ' selected' : ''}>${escapeHtml(entry.name)}${validDate(entry.updatedAt) ? ` — saved ${escapeHtml(when(entry.updatedAt))}` : ''}</option>`).join('')}</select></label>
      <p class="field-hint">If the pedal version differs, it will be marked as changed and you can review it before updating the saved patch.</p>`;
    if (!await confirmWrite(body, 'Link', 'Link memory', false)) return;
    const patchId = $('#usb-link-patch')?.value;
    const entry = list.find(item => item.id === patchId);
    if (!entry) { status('The selected My patch is no longer available.', 'danger'); return; }
    const baseline = canonicalPatch(patchForEntry(entry));
    const sync = readPedalSync();
    sync.links[number] = { patchId: entry.id, pedalBaseline: baseline, libraryBaseline: baseline, updatedAt: new Date().toISOString() };
    if (!writePedalSync(sync)) return;
    renderMemories();
    status(`Memory ${number} linked to “${entry.name}”`, 'ok');
    if (pedalSyncEnabled()) await offerLinkedChanges([number]);
  }
  function remapLinksAfterArrange(plan) {
    const sync = readPedalSync();
    const links = {};
    Object.entries(sync.links).forEach(([memory, link]) => {
      const from = Number(memory);
      const target = plan.indexOf(from);
      if (target >= 0) links[target + 1] = link;
    });
    sync.links = links;
    writePedalSync(sync);
  }
  function syncSettingText() {
    const input = $('#usb-sync-changes');
    if (input) input.checked = pedalSyncEnabled();
  }
  // A name that no patch in the list has yet: "Name", then "Name 2", "Name 3"…
  function freeName(name, list) {
    const taken = new Set(list.map(e => String(e.name).toLowerCase()));
    let free = name;
    for (let i = 2; taken.has(free.toLowerCase()); i++) free = `${name.slice(0, 28 - ` ${i}`.length)} ${i}`;
    return free;
  }
  // Takes a patch out of My patches; gives the entry and the place it had, or null when it is not there or cannot be stored
  function removePatch(id) {
    const list = readLibrary();
    const index = list.findIndex(e => e.id === id);
    if (index === -1) return null;
    const [entry] = list.splice(index, 1);
    return storeLibrary(list) ? { entry, index } : null;
  }
  async function deletePatch(id) {
    const found = readLibrary().find(e => e.id === id);
    if (!found) return;
    const yes = await confirmWrite(`<p>Delete <b>${escapeHtml(found.name)}</b> from My patches?</p><p>Nothing on the pedal changes. Undo brings the patch back for as long as you stay on this page.</p>`, 'Delete', 'Delete patch');
    if (!yes) return;
    const gone = removePatch(id);
    if (!gone) return;
    renderLocals();
    status(`“${gone.entry.name}” deleted from My patches`, 'ok');
    pushUndo(`Deleted “${gone.entry.name}”`, async () => {
      const list = readLibrary();
      if (list.some(e => e.id === gone.entry.id)) return { ok: true, text: `“${gone.entry.name}” is already in My patches` };
      list.splice(Math.min(gone.index, list.length), 0, { ...gone.entry, name: freeName(gone.entry.name, list) }); // the name may have been taken meanwhile
      if (!storeLibrary(list)) return { ok: false, text: 'This browser does not allow this site to store data.' };
      renderLocals();
      return { ok: true, text: `“${gone.entry.name}” is back in My patches` };
    }, { toast: true });
  }
  async function deleteDraft() {
    const draft = readJson(DRAFT_KEY, null);
    if (!draft?.effects?.length) return;
    const name = draft.name || '(no name)';
    const edit = readJson(EDIT_KEY, null);
    const yes = await confirmWrite(`<p>Delete the builder draft <b>${escapeHtml(name)}</b>?</p><p>Nothing in My patches or on the pedal changes.</p>`, 'Delete', 'Delete draft');
    if (!yes) return;
    try {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(EDIT_KEY);
    } catch { status('This browser does not allow this site to delete the builder draft.', 'danger'); return; }
    renderLocals();
    status(`“${name}” deleted from the builder`, 'ok');
    pushUndo(`Deleted builder draft “${name}”`, async () => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        if (edit) localStorage.setItem(EDIT_KEY, JSON.stringify(edit));
      } catch { return { ok: false, text: 'This browser does not allow this site to restore the builder draft.' }; }
      renderLocals();
      return { ok: true, text: `“${name}” is back in the builder` };
    }, { toast: true });
  }

  // ---- local patches ---------------------------------------------------------------------------------
  // [{ key, name, label, chain, bytes | error }]: the builder's open patch, a chosen .zptc file, then My patches
  function localItems() {
    const items = [];
    const make = (key, label, getPatch) => {
      try {
        const patch = getPatch();
        const chain = patch.effects.filter(e => EFFECTS_DATA[e.index]).map(e => EFFECTS_DATA[e.index][0]);
        const edit = key === 'draft' ? activeEdit() : null;
        // The builder already holds its own patch (draft); the others open in it through a patch link
        const href = key === 'draft' ? 'builder.html' : PATCHLINK.url(patch);
        try { items.push({ key, label, href, name: patch.name || '(no name)', chain, bytes: toFile(patch, edit?.memory ? fromBase64(edit.base) : null), memory: edit?.memory ?? null, patchId: key.startsWith('lib:') ? key.slice('lib:'.length) : null }); }
        catch (error) { items.push({ key, label, href, name: patch.name || '(no name)', chain, error: error.message }); }
      } catch {}
    };
    if (fileItem) {
      try { const d = ZPTC.decode(fileItem.bytes); items.push({ key: 'file', label: `File ${fileItem.fileName}`, href: PATCHLINK.url(toPatch(d)), name: d.name, chain: d.effects.map(e => e.effect), bytes: fileItem.bytes }); }
      catch (error) { items.push({ key: 'file', label: `File ${fileItem.fileName}`, name: fileItem.fileName, chain: [], error: error.message }); }
    }
    const draft = readJson(DRAFT_KEY, null);
    const edit = activeEdit();
    if (draft?.effects?.length) make('draft', edit?.memory ? `Open in the builder · editing memory ${edit.memory}` : 'Open in the builder', () => draft);
    readJson(LIBRARY_KEY, []).forEach(entry => make(`lib:${entry.id}`, entry.updatedAt ? `Saved ${when(entry.updatedAt)}` : '', () => entry));
    return items;
  }
  function renderLocals() {
    updateArrangeButton();
    renderUndo(); // busy and connected change the same moments as this list
    const items = localItems();
    $('#usb-local-count').textContent = items.filter(i => i.key.startsWith('lib:')).length;
    const target = selected && memories.get(selected)?.state !== 'loading' ? selected : null;
    $('#usb-locals').innerHTML = items.length ? items.map(item => `<li class="usb-local" data-key="${escapeHtml(item.key)}">
        <div class="usb-local-main"><span class="usb-name">${escapeHtml(item.name)}</span><small>${escapeHtml(item.label)}</small>
          <span class="usb-chain-line">${escapeHtml(item.error || chainText(item.chain))}</span></div>
        <span class="usb-local-actions">
          <button class="btn btn-sm btn-icon btn-invisible btn-danger usb-delete"${item.key === 'draft' || item.key.startsWith('lib:') ? ' data-act="delete"' : ' disabled'} aria-label="${item.key === 'draft' ? `Delete ${escapeHtml(item.name)} draft` : `Delete ${escapeHtml(item.name)} from My patches`}" title="${item.key === 'draft' ? 'Delete builder draft' : item.key.startsWith('lib:') ? 'Delete from My patches' : 'Only saved patches can be deleted'}">${ICON_TRASH}</button>
          ${item.href ? `<a class="btn btn-sm usb-edit" href="${escapeHtml(item.href)}" data-act="edit-local" title="Open this patch in the patch builder">Edit</a>` : '<button class="btn btn-sm usb-edit" disabled title="This file cannot be opened in the patch builder">Edit</button>'}
          <button class="btn btn-sm btn-icon usb-send${target ? ' btn-primary' : ''}" data-act="send" ${!connected || !target || item.error || busy ? 'disabled' : ''}
            aria-label="${target ? `Send to memory ${target}` : 'Send to a memory'}"
            title="${!connected ? 'Connect the pedal first' : busy ? 'Wait until the pedal has been read' : !target ? 'Select a memory on the right first' : `Send to memory ${target}`}">${ICON_SEND}</button>
        </span>
      </li>`).join('') : '<li class="usb-empty">No patches yet. Build one in the <a href="builder.html">patch builder</a> and save it, or send a <code>.zptc</code> file.</li>';
  }
  $('#usb-locals').addEventListener('click', event => {
    const trash = event.target.closest('[data-act="delete"]');
    if (trash) {
      const key = trash.closest('[data-key]').dataset.key;
      if (key === 'draft') deleteDraft();
      else if (key.startsWith('lib:')) deletePatch(key.slice('lib:'.length));
      return;
    }
    const button = event.target.closest('[data-act="send"]');
    if (!button || !selected) return;
    const item = localItems().find(i => i.key === button.closest('[data-key]').dataset.key);
    if (item?.bytes) send(selected, item.bytes, false, '', item.patchId || null);
  });
  $('#usb-sync-changes').addEventListener('change', event => {
    const sync = readPedalSync();
    sync.enabled = event.target.checked;
    if (!writePedalSync(sync)) event.target.checked = !event.target.checked;
    if (event.target.checked) offerLinkedChanges(Array.from({ length: info?.count || 0 }, (_, i) => i + 1));
  });
  $('#usb-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    fileItem = { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    renderLocals();
    status(selected ? `“${file.name}” ready: press its send button to write it to memory ${selected}` : `“${file.name}” ready: select a memory on the right, then press its send button`);
  });
  window.addEventListener('storage', event => { if (event.key === LIBRARY_KEY || event.key === DRAFT_KEY) renderLocals(); });
  window.addEventListener('focus', renderLocals);
  window.addEventListener('account-synced', event => { if (event.detail.pedal === PEDAL.id) { renderLocals(); renderBackups(); } });

  // ---- writing ---------------------------------------------------------------------------------------
  const storedBackups = () => { const list = readJson(BACKUP_KEY, []); return Array.isArray(list) ? list.filter(validBackup) : []; };
  const readBackups = () => storedBackups().filter(b => !b.deleted);
  // The last MAX_BACKUPS, and no more than about 190 kB so the list still fits in an account (see account-sync.mjs).
  // The deletion records of the last 90 days are kept next to them.
  const writeBackups = (list, graves = storedBackups().filter(b => b.deleted)) => {
    const kept = list.slice(0, MAX_BACKUPS);
    const recent = graves.filter(g => Date.now() - Date.parse(g.at) < GRAVE_MS);
    while (kept.length > 1 && JSON.stringify([...kept, ...recent]).length > 190_000) kept.pop();
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify([...kept, ...recent])); return true; } catch { return false; }
  };
  const removeBackups = ids => {
    const at = new Date().toISOString();
    const live = readBackups();
    return writeBackups(live.filter(b => !ids.includes(b.id)), [...storedBackups().filter(b => b.deleted), ...live.filter(b => ids.includes(b.id)).map(b => ({ id: b.id, deleted: true, at }))]);
  };
  function renderBackups() {
    const list = readBackups();
    $('#usb-backup-count').textContent = list.length;
    $('#usb-backups-clear').disabled = !list.length;
    $('#usb-backups').innerHTML = list.length ? list.map(b => b.group ? `<li data-id="${escapeHtml(b.id)}">
        <span><b>${b.group.length} memories</b> · ${escapeHtml(b.name)} <small>${escapeHtml(when(b.at))}</small></span>
        <span class="usb-row"><button class="btn btn-sm" data-backup="restore" ${connected && info && !busy ? '' : 'disabled'}>Restore all ${b.group.length}</button><button class="btn btn-sm btn-invisible" data-backup="delete" aria-label="Delete this backup">Delete</button></span>
      </li>` : `<li data-id="${escapeHtml(b.id)}">
        <span><b>Memory ${b.memory}</b> · ${escapeHtml(b.name)} <small>${escapeHtml(when(b.at))}</small></span>
        <span class="usb-row"><button class="btn btn-sm" data-backup="download">Download</button><button class="btn btn-sm" data-backup="restore" ${connected && info ? '' : 'disabled'}>Restore to memory ${b.memory}</button><button class="btn btn-sm btn-invisible" data-backup="delete" aria-label="Delete this backup">Delete</button></span>
      </li>`).join('') : '<li class="usb-empty">No backups yet.</li>';
  }

  // ---- undo ------------------------------------------------------------------------------------------
  // What was done on this page can be taken back, newest first: deleting or copying a patch in My patches, everything written to the
  // pedal (a patch, a new name, a cleared memory, a new order, a restored backup) and, while a new order is planned, each move.
  // The list lives in the page and is gone when the visitor leaves it. Deleting backups is not on it: that asks first.
  // A change to the pedal is undone like any write to it: the memory is read, backed up, confirmed, written and read back.
  const MAX_UNDO = 20;
  const undoStack = []; // [{ label, needsPedal, run: async () → { ok, text } | { cancelled: true } }], newest last
  let undoing = false;
  function pushUndo(label, run, { needsPedal = false, toast = false } = {}) {
    const entry = { label, needsPedal, run };
    undoStack.push(entry);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    renderUndo();
    if (toast) DIALOGS.toast(label, { action: 'Undo', onAction: () => { if (undoStack.at(-1) === entry && !arranging) undo(); } });
  }
  function renderUndo() {
    const top = undoStack.at(-1);
    let label = 'Nothing to undo yet', enabled = false, hint = 'Nothing to undo';
    if (arranging) {
      enabled = arranging.history.length > 0;
      label = enabled ? 'Last move in the new order' : 'No move to undo yet';
    } else if (top) {
      label = `${top.label}${undoStack.length > 1 ? ` · ${undoStack.length - 1} earlier` : ''}`;
      enabled = !undoing && (!top.needsPedal || (connected && !busy)); // a patch in My patches does not need the pedal
      hint = top.needsPedal && !connected ? 'Connect the pedal to undo this change' : top.needsPedal && busy ? 'Wait until the pedal is free' : '';
    }
    $('#usb-undo').disabled = !enabled;
    $('#usb-undo').title = enabled ? 'Undo (Ctrl/⌘ + Z)' : hint;
    $('#usb-undo-text').textContent = label;
  }
  async function undo() {
    if (arranging) { undoMove(); return; }
    const entry = undoStack.at(-1);
    if (!entry || undoing || (entry.needsPedal && busy)) return;
    if (entry.needsPedal && !connected) { status('Connect the pedal to undo this change', 'danger'); return; }
    undoing = true;
    if (entry.needsPedal) busy = true; // nothing else talks to the pedal while it is put back
    renderLocals();
    let r;
    try { r = await entry.run(); } catch (error) { r = { ok: false, text: error.message }; }
    undoing = false;
    if (entry.needsPedal) busy = false;
    if (r.ok) undoStack.pop(); // a change that could not be undone stays on the list, to try again
    if (entry.needsPedal) renderMemories(); // the rows rewritten while busy are not draggable yet
    renderLocals();
    renderBackups();
    if (r.cancelled) { status('Nothing changed'); return; }
    if (entry.needsPedal) { result(r.ok, r.text); status(r.ok ? 'Undone' : 'Check the pedal', r.ok ? 'ok' : 'danger'); }
    else { status(r.text, r.ok ? 'ok' : 'danger'); DIALOGS.toast(r.text); }
  }
  // What a memory holds now, read fresh, so that a write to it can be undone; null when it cannot be read safely
  async function snapshotOf(number) {
    await readOne(number);
    const m = memories.get(number);
    return m.state === 'ok' && m.crcOk ? { number, before: m.memory, name: m.decoded.name || '(no name)' } : null;
  }
  // Puts back what memories held before a change. changes: [{ number, before: the whole memory as it was, name, wrote: the PTCF
  // file the change put there }]. Asks first, and tells when a memory is no longer what the change left (the pedal was edited since).
  async function undoWrites(changes) {
    const now = [];
    for (const [k, c] of changes.entries()) {
      status(`Reading memory ${c.number} (${k + 1} of ${changes.length})`);
      await readOne(c.number);
      renderMemory(c.number);
      const m = memories.get(c.number);
      if (!m.memory) return { ok: false, text: `Memory ${c.number} could not be read, so nothing was written.` };
      now.push({ memory: c.number, name: m.decoded?.name || '(unreadable)', data: toBase64(m.memory), edited: !(m.state === 'ok' && sameBytes(m.data, c.wrote)) });
    }
    const shown = changes.slice(0, 12).map((c, k) => `<li>Memory ${c.number}: <b>${escapeHtml(c.name)}</b> replaces <b>${escapeHtml(now[k].name)}</b>${now[k].edited ? ' (the pedal was changed since)' : ''}</li>`).join('');
    const yes = await confirmWrite(`<p>Undo: put ${changes.length === 1 ? 'the previous patch' : `the previous ${changes.length} patches`} back?</p><ul>${shown}${changes.length > 12 ? `<li>and ${changes.length - 12} more</li>` : ''}</ul>
      <p>A backup of ${changes.length === 1 ? 'what the memory holds' : 'what these memories hold'} now is kept in Backups.</p>`, changes.length === 1 ? `Put back in memory ${changes[0].number}` : `Put back ${changes.length} memories`, 'Undo');
    if (!yes) return { cancelled: true };
    const at = new Date().toISOString();
    const entry = changes.length === 1 ? { id: `${Date.now()}`, memory: now[0].memory, name: now[0].name, at, data: now[0].data }
      : { id: `${Date.now()}-undo`, memory: now[0].memory, name: `Before undoing ${changes.length} memories`, at, group: now.map(({ memory, name, data }) => ({ memory, name, data })) };
    if (!writeBackups([entry, ...readBackups()])) return { ok: false, text: 'This browser could not keep the backup, so nothing was written.' };
    renderBackups();
    for (const [k, c] of changes.entries()) {
      status(`Writing memory ${c.number} (${k + 1} of ${changes.length})`);
      const r = await writeAndCheck(c.number, c.before);
      if (!r.ok) return { ok: false, text: changes.length === 1 ? r.text : `${r.text} Stopped after ${k} of ${changes.length} memories: restore “${entry.name}” in Backups to go back.` };
    }
    return { ok: true, text: changes.length === 1 ? `Undone: memory ${changes[0].number} holds “${changes[0].name}” again, read back and identical.` : `Undone: ${changes.length} memories hold what they did before, each read back and identical.` };
  }
  $('#usb-undo').addEventListener('click', undo);
  // Ctrl/⌘ + Z, unless a text field is being edited (it has its own undo) or a dialog is open
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (document.querySelector('dialog[open]') || event.target.closest?.('textarea, select, [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"])')) return;
    event.preventDefault();
    undo();
  });

  // ---- arranging the pedal ---------------------------------------------------------------------------
  // A new order is planned in the page first: plan[i] is the memory whose patch goes to memory i + 1. Selected patches
  // move as a block. Writing keeps one backup of every memory that changes, checks that the pedal still holds what was
  // read, then writes and reads back each memory in turn.
  let arranging = null; // { plan: [memory numbers], history: [earlier plans, for Undo], snap: Map(memory → { data: PTCF bytes, memory: bytes, name }), selection: Set, anchor }
  const allRead = () => info && [...Array(info.count).keys()].every(i => { const m = memories.get(i + 1); return m?.state === 'ok' && m.crcOk; });
  function updateArrangeButton() {
    const button = $('#usb-arrange');
    button.disabled = !connected || busy || !allRead();
    button.title = !connected ? 'Connect the pedal first' : busy ? 'Wait until the pedal is free' : !allRead() ? 'Every memory must be read correctly first: press Read again' : 'Change the order of the patches on the pedal';
  }
  const canArrange = () => connected && !busy && allRead();
  function startArranging() {
    if (!connected || busy || !allRead()) return;
    const snap = new Map();
    for (let n = 1; n <= info.count; n++) { const m = memories.get(n); snap.set(n, { data: m.data, memory: m.memory, name: m.decoded.name || '(no name)' }); }
    arranging = { plan: Array.from({ length: info.count }, (_, i) => i + 1), history: [], snap, selection: new Set(), anchor: null };
    busy = true; // nothing else talks to the pedal or changes it while a new order is planned
    selected = null;
    $('#usb-memories').hidden = true;
    $('#usb-arrange-panel').hidden = false;
    $('#usb-pedal-hint').hidden = true;
    renderArrange();
    renderLocals();
    renderBackups();
  }
  function stopArranging() {
    arranging = null;
    busy = false;
    $('#usb-memories').hidden = false;
    $('#usb-arrange-panel').hidden = true;
    $('#usb-pedal-hint').hidden = false;
    renderMemories();
    renderLocals();
    renderBackups();
  }
  const changesOf = plan => plan.map((from, i) => ({ to: i + 1, from })).filter(c => c.to !== c.from);
  // Every change of the plan goes through here, so that Undo can go back one move at a time (plans are replaced, never edited)
  function setPlan(plan) {
    if (sameBytes(plan, arranging.plan)) return;
    arranging.history.push(arranging.plan);
    if (arranging.history.length > 100) arranging.history.shift();
    arranging.plan = plan;
  }
  function undoMove() {
    const plan = arranging.history.pop();
    if (!plan) return;
    arranging.plan = plan;
    renderArrange();
  }
  function renderArrange(focusId) {
    const { plan, snap, selection } = arranging;
    $('#usb-arrange-list').innerHTML = plan.map((from, i) => `<li class="usb-arr-item${selection.has(from) ? ' is-checked' : ''}${from !== i + 1 ? ' is-moved' : ''}" draggable="true" data-from="${from}" tabindex="-1">
        <input type="checkbox" ${selection.has(from) ? 'checked' : ''} aria-label="Select ${escapeHtml(snap.get(from).name)}" />
        <span class="usb-num">${i + 1}</span><span class="usb-name">${escapeHtml(snap.get(from).name)}</span>
        <span class="usb-meta">${from !== i + 1 ? `from ${from}` : ''}</span><span class="usb-grip" aria-hidden="true">⠿</span>
      </li>`).join('');
    const changes = changesOf(plan);
    $('#usb-arr-selected').textContent = selection.size ? `${selection.size} selected` : 'No patch selected';
    for (const id of ['#usb-arr-up', '#usb-arr-down', '#usb-arr-to', '#usb-arr-none']) $(id).disabled = !selection.size;
    $('#usb-arr-pos').max = info.count;
    $('#usb-arr-changes').textContent = changes.length ? `${changes.length} ${changes.length === 1 ? 'memory changes' : 'memories change'}` : 'No changes yet';
    $('#usb-arr-write').disabled = !changes.length;
    $('#usb-arr-write').textContent = changes.length ? `Write ${changes.length} ${changes.length === 1 ? 'memory' : 'memories'}` : 'Write to the pedal';
    $('#usb-arr-reset').disabled = !changes.length;
    renderUndo();
    if (focusId) $(`#usb-arrange-list [data-from="${focusId}"]`)?.focus();
  }
  // Puts the selected patches, in their current order, at index k of the list without them
  function placeBlock(k) {
    const { plan, selection } = arranging;
    const block = plan.filter(id => selection.has(id));
    const rest = plan.filter(id => !selection.has(id));
    k = Math.max(0, Math.min(k, rest.length));
    setPlan([...rest.slice(0, k), ...block, ...rest.slice(k)]);
  }
  function shift(dir) {
    const { plan, selection } = arranging;
    const p = [...plan];
    const order = p.map((id, i) => (selection.has(id) ? i : -1)).filter(i => i >= 0);
    for (const i of dir < 0 ? order : order.reverse()) {
      const j = i + dir;
      if (j >= 0 && j < p.length && !selection.has(p[j])) [p[i], p[j]] = [p[j], p[i]];
    }
    setPlan(p);
  }
  function choose(from, { range = false, toggle = true } = {}) {
    const { plan, selection } = arranging;
    if (range && arranging.anchor != null) {
      const [x, y] = [plan.indexOf(arranging.anchor), plan.indexOf(from)].sort((a, b) => a - b);
      for (const id of plan.slice(x, y + 1)) selection.add(id);
    } else if (toggle) {
      if (selection.has(from)) selection.delete(from); else selection.add(from);
      arranging.anchor = from;
    }
  }
  $('#usb-arrange').addEventListener('click', startArranging);
  $('#usb-arr-cancel').addEventListener('click', stopArranging);
  $('#usb-arr-reset').addEventListener('click', () => { setPlan(Array.from({ length: info.count }, (_, i) => i + 1)); renderArrange(); });
  $('#usb-arr-none').addEventListener('click', () => { arranging.selection.clear(); renderArrange(); });
  $('#usb-arr-up').addEventListener('click', () => { shift(-1); renderArrange(); });
  $('#usb-arr-down').addEventListener('click', () => { shift(1); renderArrange(); });
  $('#usb-arr-to').addEventListener('click', () => {
    const to = Number($('#usb-arr-pos').value);
    if (!Number.isInteger(to) || to < 1 || to > info.count) { status(`Choose a memory from 1 to ${info.count}.`, 'danger'); return; }
    placeBlock(to - 1);
    renderArrange();
    $(`#usb-arrange-list [data-from="${arranging.plan[to - 1]}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  const list = $('#usb-arrange-list');
  list.addEventListener('click', event => {
    const item = event.target.closest('[data-from]');
    if (!item) return;
    choose(Number(item.dataset.from), { range: event.shiftKey });
    renderArrange();
  });
  list.addEventListener('keydown', event => {
    const item = event.target.closest('[data-from]');
    if (!item || !arranging.selection.size || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    shift(event.key === 'ArrowUp' ? -1 : 1);
    renderArrange(Number(item.dataset.from));
  });
  // Drag and drop: dragging a patch that is not selected moves only that patch
  const dropMarks = () => list.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  const dropSide = (item, event) => { const r = item.getBoundingClientRect(); return event.clientY < r.top + r.height / 2 ? 'before' : 'after'; };
  list.addEventListener('dragstart', event => {
    const item = event.target.closest('[data-from]');
    if (!item) return;
    const from = Number(item.dataset.from);
    if (!arranging.selection.has(from)) { arranging.selection = new Set([from]); arranging.anchor = from; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(from));
    requestAnimationFrame(() => list.querySelectorAll('.usb-arr-item').forEach(el => el.classList.toggle('is-dragging', arranging.selection.has(Number(el.dataset.from)))));
  });
  list.addEventListener('dragover', event => {
    const item = event.target.closest('[data-from]');
    if (!item) return;
    event.preventDefault();
    dropMarks();
    if (!arranging.selection.has(Number(item.dataset.from))) item.classList.add(`drop-${dropSide(item, event)}`);
  });
  list.addEventListener('dragleave', event => { if (!list.contains(event.relatedTarget)) dropMarks(); });
  list.addEventListener('drop', event => {
    event.preventDefault();
    const item = event.target.closest('[data-from]');
    dropMarks();
    if (!item || arranging.selection.has(Number(item.dataset.from))) return;
    const rest = arranging.plan.filter(id => !arranging.selection.has(id));
    placeBlock(rest.indexOf(Number(item.dataset.from)) + (dropSide(item, event) === 'after' ? 1 : 0));
    renderArrange();
  });
  list.addEventListener('dragend', () => { dropMarks(); renderArrange(); });

  // Dragging a memory in the list itself: the first drop opens the new order (with its Write button) and applies the move
  let dragged = null;
  const memList = $('#usb-memories');
  const memMarks = () => memList.querySelectorAll('.drop-before, .drop-after, .is-dragging').forEach(el => el.classList.remove('drop-before', 'drop-after', 'is-dragging'));
  memList.addEventListener('dragstart', event => {
    const row = event.target.closest?.('.usb-mem');
    if (!row || !canArrange() || renaming === Number(row.dataset.n)) { event.preventDefault(); return; }
    dragged = Number(row.dataset.n);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(dragged));
    row.classList.add('is-dragging');
  });
  memList.addEventListener('dragover', event => {
    const row = event.target.closest('.usb-mem');
    if (dragged === null || !row) return;
    event.preventDefault();
    memMarks();
    if (Number(row.dataset.n) !== dragged) row.classList.add(`drop-${dropSide(row, event)}`);
    else row.classList.add('is-dragging');
  });
  memList.addEventListener('dragleave', event => { if (!memList.contains(event.relatedTarget)) memMarks(); });
  memList.addEventListener('drop', event => {
    event.preventDefault();
    const row = event.target.closest('.usb-mem');
    const from = dragged;
    dragged = null;
    const side = row ? dropSide(row, event) : 'after';
    memMarks();
    if (!row || from === null || Number(row.dataset.n) === from || !canArrange()) return;
    const target = Number(row.dataset.n);
    startArranging();
    arranging.selection = new Set([from]);
    arranging.anchor = from;
    const rest = arranging.plan.filter(id => id !== from);
    placeBlock(rest.indexOf(target) + (side === 'after' ? 1 : 0));
    renderArrange(from);
    $(`#usb-arrange-list [data-from="${from}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  memList.addEventListener('dragend', () => { dragged = null; memMarks(); });

  $('#usb-arr-write').addEventListener('click', async () => {
    const { plan, snap } = arranging;
    const changes = changesOf(plan);
    if (!changes.length) return;
    const shown = changes.slice(0, 12).map(c => `<li>Memory ${c.to}: <b>${escapeHtml(snap.get(c.from).name)}</b> (now in ${c.from})</li>`).join('');
    const yes = await confirmWrite(`<p>Write the new order? ${changes.length} ${changes.length === 1 ? 'memory changes' : 'memories change'}:</p><ul>${shown}${changes.length > 12 ? `<li>and ${changes.length - 12} more</li>` : ''}</ul>
      <p>A backup of these memories as they are now is kept in Backups, as one entry you can restore at once.</p>`, `Write ${changes.length} ${changes.length === 1 ? 'memory' : 'memories'}`);
    if (!yes) return;
    result(true, '');
    // The pedal must still hold what was read when arranging started
    for (const [k, c] of changes.entries()) {
      status(`Checking memory ${c.to} (${k + 1} of ${changes.length})`);
      await readOne(c.to);
      const now = memories.get(c.to);
      const expected = snap.get(c.to);
      if (now.state !== 'ok' || !now.crcOk || !sameBytes(now.data, expected.data)) {
        const reason = now.state !== 'ok' ? `could not be read (${now.error || now.state})` : !now.crcOk ? 'returned a checksum mismatch' : 'changed on the pedal';
        result(false, `Memory ${c.to} ${reason} since it was read: nothing was written. Read it again before arranging again.`, { type: 'reread', memory: c.to });
        status('Nothing written', 'danger');
        stopArranging();
        return;
      }
    }
    const at = new Date().toISOString();
    const stored = writeBackups([{ id: `${Date.now()}-arrange`, memory: changes[0].to, name: `Before rearranging ${changes.length} memories`, at,
      group: changes.map(c => ({ memory: c.to, name: snap.get(c.to).name, data: toBase64(snap.get(c.to).memory) })) }, ...readBackups()]);
    if (!stored) { result(false, 'This browser could not keep the backup, so nothing was written.'); status('Nothing written', 'danger'); return; }
    renderBackups();
    for (const [k, c] of changes.entries()) {
      status(`Writing memory ${c.to} (${k + 1} of ${changes.length})`);
      const r = await writeAndCheck(c.to, snap.get(c.from).memory);
      if (!r.ok) {
        result(false, `${r.text} Stopped after ${k} of ${changes.length} memories: restore “Before rearranging ${changes.length} memories” in Backups to go back.`);
        status('Check the pedal', 'danger');
        stopArranging();
        return;
      }
    }
    result(true, `New order written: ${changes.length} ${changes.length === 1 ? 'memory' : 'memories'}, each read back and identical.`);
    remapLinksAfterArrange(plan);
    status('Arranged', 'ok');
    pushUndo(`Rearranged ${changes.length} ${changes.length === 1 ? 'memory' : 'memories'}`,
      () => undoWrites(changes.map(c => ({ number: c.to, before: snap.get(c.to).memory, name: snap.get(c.to).name, wrote: ptcfOf(snap.get(c.from).memory) }))), { needsPedal: true });
    stopArranging();
  });

  // Resolves true when the user confirms
  function confirmWrite(html, action, title = 'Write to the pedal', danger = true) {
    const dialog = $('#usb-confirm');
    $('#usb-confirm-title').textContent = title;
    $('#usb-confirm-body').innerHTML = html;
    $('#usb-confirm-yes').textContent = action;
    $('#usb-confirm-yes').classList.toggle('btn-danger', danger);
    $('#usb-confirm-yes').classList.toggle('btn-primary', !danger);
    $('#usb-confirm-keep').hidden = true;
    $('#usb-confirm-new').hidden = true;
    dialog.showModal();
    return new Promise(resolve => {
      dialog.onclick = event => {
        const choice = event.target.closest('[data-confirm]')?.dataset.confirm;
        if (!choice && event.target !== dialog) return;
        dialog.close();
        resolve(choice === 'yes');
      };
      dialog.oncancel = () => resolve(false);
    });
  }

  function confirmSync(info) {
    const dialog = $('#usb-confirm');
    const changes = info.changes.changes.slice(0, 10).map(change => `<li>${escapeHtml(change)}</li>`).join('');
    const more = info.changes.count > 10 ? `<li>and ${info.changes.count - 10} more changes</li>` : '';
    $('#usb-confirm-title').textContent = 'Update My patch';
    $('#usb-confirm-body').innerHTML = `<p>Memory ${info.number} has changed on the pedal since it was linked to <b>${escapeHtml(info.entry.name)}</b>.</p>
      ${info.conflict ? '<p class="usb-warn">The copy in My patches has also changed since the last link. Updating will replace that copy with the pedal version.</p>' : ''}
      <ul>${changes || '<li>The patch content changed.</li>'}${more}</ul>
      <p>Choose whether to replace the saved patch, keep it, or save the pedal version as a new patch.</p>`;
    $('#usb-confirm-yes').textContent = 'Update My patch';
    $('#usb-confirm-yes').classList.add('btn-danger');
    $('#usb-confirm-yes').classList.remove('btn-primary');
    $('#usb-confirm-keep').hidden = false;
    $('#usb-confirm-new').hidden = false;
    dialog.showModal();
    return new Promise(resolve => {
      dialog.onclick = event => {
        const choice = event.target.closest('[data-confirm]')?.dataset.confirm;
        if (!choice && event.target !== dialog) return;
        dialog.close();
        resolve(choice || 'no');
      };
      dialog.oncancel = () => resolve('no');
    });
  }

  function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
  function restoreLibraryEntry(before, beforeSync) {
    const list = readLibrary();
    const index = list.findIndex(entry => entry.id === before.id);
    if (index === -1) list.unshift(before);
    else list[index] = before;
    if (!storeLibrary(list)) return false;
    writePedalSync(beforeSync);
    renderLocals();
    renderMemories();
    return true;
  }
  async function syncMemory(number, provided = null) {
    const found = provided || syncInfo(number);
    if (!found) return;
    if (found.error) { status(found.error, 'danger'); return; }
    const choice = await confirmSync(found);
    if (choice === 'no') { status('Nothing changed'); return; }
    const beforeSync = cloneJson(readPedalSync());
    const before = cloneJson(found.entry);
    const list = readLibrary();
    const entry = list.find(item => item.id === found.entry.id);
    if (!entry) { status('The linked patch is no longer in My patches.', 'danger'); return; }
    if (choice === 'new') {
      const copy = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: freeName(found.pedalPatch.name, list), effects: cloneJson(found.pedalPatch.effects), output: null, updatedAt: new Date().toISOString() };
      list.unshift(copy);
      if (!storeLibrary(list)) return;
      linkMemory(number, copy.id, found.pedalPatch);
      renderLocals();
      renderMemories();
      status(`“${copy.name}” saved as a new My patch`, 'ok');
      pushUndo(`Saved “${copy.name}” as a new My patch`, async () => {
        const now = readLibrary();
        if (!storeLibrary(now.filter(item => item.id !== copy.id))) return { ok: false, text: 'This browser does not allow this site to store data.' };
        writePedalSync(beforeSync);
        renderLocals();
        renderMemories();
        return { ok: true, text: `“${copy.name}” removed from My patches` };
      }, { toast: true });
      return;
    }
    if (choice === 'keep') {
      const sync = readPedalSync();
      sync.links[number] = { ...found.link, pedalBaseline: canonicalPatch(found.pedalPatch), libraryBaseline: canonicalPatch(patchForEntry(entry)), updatedAt: new Date().toISOString() };
      writePedalSync(sync);
      renderMemories();
      status(`Kept “${entry.name}” in My patches`, 'ok');
      return;
    }
    Object.assign(entry, { name: found.pedalPatch.name, effects: cloneJson(found.pedalPatch.effects), updatedAt: new Date().toISOString() });
    if (!storeLibrary(list)) return;
    linkMemory(number, entry.id, found.pedalPatch);
    renderLocals();
    renderMemories();
    status(`Updated “${entry.name}” from memory ${number}`, 'ok');
    pushUndo(`Updated “${entry.name}” from the pedal`, async () => {
      const restored = restoreLibraryEntry(before, beforeSync);
      return { ok: restored, text: restored ? `“${before.name}” restored in My patches` : 'This browser does not allow this site to save the previous patch.' };
    }, { toast: true });
  }

  async function offerLinkedChanges(numbers) {
    if (!pedalSyncEnabled()) return;
    for (const number of numbers) {
      const found = syncInfo(number);
      if (found && !found.error) await syncMemory(number, found);
    }
  }

  // Writes bytes to a memory, reads it back into the list and compares the PTCF data
  async function writeAndCheck(number, bytes) {
    const sent = await step(`Writing memory ${number}`, () => PEDALMIDI.writeMemory(number, info, bytes));
    if (!sent.ok && !/No answer/.test(sent.error?.message || '')) return { ok: false, text: `Writing failed: ${sent.error.message}` };
    await readOne(number);
    renderMemory(number);
    const back = memories.get(number);
    if (back.state !== 'ok') return { ok: false, text: `Memory ${number} could not be read back (${back.error || back.state}): check it on the pedal.` };
    const ok = back.crcOk && sameBytes(back.data, ptcfOf(bytes));
    note(`Read back memory ${number}: ${ok ? 'identical' : 'DIFFERENT'} (${back.data.length} bytes)`);
    return ok ? { ok: true, text: `Memory ${number} now holds “${back.decoded.name}”: read back and identical.` }
      : { ok: false, text: `Memory ${number} was read back but differs from what was sent. Restore the backup if the patch is wrong.` };
  }

  // label: what the change is called on the Undo list (a rename passes its own)
  async function send(number, bytes, clearing = false, label = '', sourcePatchId = null) {
    if (busy) return;
    busy = true;
    renderLocals();
    try { await sendNow(number, bytes, clearing, label, sourcePatchId); } finally { busy = false; renderLocals(); }
  }
  async function sendNow(number, bytes, clearing = false, label = '', sourcePatchId = null) {
    result(true, '');
    let d;
    try { d = ZPTC.decode(bytes); } catch (error) { status(`Not a patch: ${error.message}`, 'danger'); return; }
    if (d.effects.length > ZPTC.MAX_EFFECTS) { status(`A patch holds at most ${ZPTC.MAX_EFFECTS} effects; this one has ${d.effects.length}.`, 'danger'); return; }
    // A full chain goes without the BLANK slot that starts a file: the pedal holds at most 6 entries and would drop the last effect
    const sendable = ZPTC.forPedal(bytes);
    const noBlank = sendable !== bytes;
    bytes = sendable;
    if (bytes.length > info.size) { status(`The patch has ${bytes.length} bytes; a memory holds ${info.size}.`, 'danger'); return; }
    // 1. Backup of the memory about to be replaced (read fresh, not from the list)
    await step(`Backing up memory ${number}`, () => readOne(number));
    renderMemory(number);
    const old = memories.get(number);
    // A memory that cannot be decoded (or whose checksum failed) can still be cleared: what the pedal sent is backed up as it is
    const readable = old.state === 'ok' && old.crcOk;
    if (!readable && !(clearing && old.memory)) { status(`Memory ${number} could not be read safely, so nothing was written.`, 'danger'); return; }
    const oldName = old.decoded?.name || (readable ? '(no name)' : '(unreadable)');
    const stored = writeBackups([{ id: `${Date.now()}`, memory: number, name: oldName, at: new Date().toISOString(), data: toBase64(old.memory) }, ...readBackups()]);
    download(old.data || old.memory, `backup ${String(number).padStart(3, '0')} ${fileName(oldName)}.zptc`);
    renderBackups();
    // 2. Confirmation
    status('Waiting for your confirmation');
    const yes = await confirmWrite(`<p>${clearing ? `Clear <b>memory ${number}</b>: it is saved as an empty patch, with no effects, named <input class="form-control form-control--sm" id="usb-clear-name" maxlength="28" value="${escapeHtml(d.name)}" spellcheck="false" autocomplete="off" aria-label="Name of the empty patch" />.` : `Write <b>${escapeHtml(d.name)}</b> (${d.effects.length} effects, DSP ${d.dspTotal.toFixed(1)}%) to <b>memory ${number}</b>?`}</p>
      <p>It replaces <b>${escapeHtml(oldName)}</b>. A backup of it ${stored ? 'is in Backups on this page and ' : ''}was downloaded as a <code>.zptc</code> file.</p>
      ${noBlank ? `<p>The file starts with a BLANK slot, and ${ZPTC.MAX_EFFECTS} effects fill every slot of the pedal: the BLANK is left out.</p>` : ''}
      ${d.dspTotal > 100 ? '<p class="usb-warn">The estimated DSP load is over 100%: the pedal will show PROCESS OVERFLOW.</p>' : ''}`, clearing ? `Clear memory ${number}` : `Write to memory ${number}`);
    if (!yes) { status('Nothing written'); return; }
    if (clearing) { // the name proposed is Empty; the user may have changed it
      const name = ($('#usb-clear-name')?.value || '').trim() || CLEARED_NAME;
      try { bytes = ZPTC.encode({ name, shortName: name, empty: true, effects: [] }).file; } catch (error) { status(`${error.message}; nothing was written.`, 'danger'); return; }
    }
    // 3. Write and read back
    const r = await writeAndCheck(number, bytes);
    result(r.ok, r.text);
    status(r.ok ? (clearing ? 'Cleared' : 'Written') : 'Check the pedal', r.ok ? 'ok' : 'danger');
    if (r.ok && sourcePatchId) {
      try { linkMemory(number, sourcePatchId, toPatch(ZPTC.decode(ptcfOf(bytes)), { strict: true })); renderMemory(number); }
      catch (error) { status(`Written, but the My patch link could not be saved: ${error.message}`, 'danger'); }
    } else if (r.ok && clearing) { unlinkMemory(number); renderMemory(number); }
    // A memory that could not be read as a valid patch is only kept in Backups: writing its raw bytes back cannot be read back to check
    if (r.ok && readable) pushUndo(label || (clearing ? `Cleared memory ${number}` : `Wrote “${d.name}” to memory ${number}`),
      () => undoWrites([{ number, before: old.memory, name: oldName, wrote: ptcfOf(bytes) }]), { needsPedal: true });
  }

  $('#usb-backups').addEventListener('click', async event => {
    const button = event.target.closest('[data-backup]');
    if (!button) return;
    const list = readBackups();
    const backup = list.find(b => b.id === button.closest('li').dataset.id);
    if (!backup) return;
    const memory = backup.group ? null : fromBase64(backup.data); // an "arrange" backup holds several memories (group)
    if (button.dataset.backup === 'download') download(ptcfOf(memory), `backup ${String(backup.memory).padStart(3, '0')} ${fileName(backup.name)}.zptc`);
    if (button.dataset.backup === 'delete') { removeBackups([backup.id]); renderBackups(); }
    if (button.dataset.backup === 'restore' && backup.group) {
      const yes = await confirmWrite(`<p>Put back the ${backup.group.length} memories of <b>${escapeHtml(backup.name)}</b> (${escapeHtml(when(backup.at))})?</p><p>Memories ${backup.group.map(g => g.memory).join(', ')} get back what they held then.</p>`, `Restore ${backup.group.length} memories`);
      if (!yes || busy) return;
      busy = true;
      renderLocals();
      try {
        const before = []; // what the memories hold now, so that Undo can put it back
        for (const g of backup.group) before.push(await snapshotOf(g.memory));
        for (const [k, g] of backup.group.entries()) {
          status(`Restoring memory ${g.memory} (${k + 1} of ${backup.group.length})`);
          const r = await writeAndCheck(g.memory, fromBase64(g.data));
          if (!r.ok) { result(false, `${r.text} Stopped after ${k} of ${backup.group.length} memories.`); status('Check the pedal', 'danger'); return; }
        }
        result(true, `${backup.group.length} memories restored: each read back and identical.`);
        status('Restored', 'ok');
        if (before.every(Boolean)) pushUndo(`Restored “${backup.name}”`, () => undoWrites(before.map((b, k) => ({ ...b, wrote: ptcfOf(fromBase64(backup.group[k].data)) }))), { needsPedal: true });
      } finally { busy = false; renderLocals(); renderBackups(); }
      return;
    }
    if (button.dataset.backup === 'restore') {
      const yes = await confirmWrite(`<p>Put <b>${escapeHtml(backup.name)}</b> (backup of ${escapeHtml(when(backup.at))}) back into <b>memory ${backup.memory}</b>?</p><p>It replaces what that memory holds now.</p>`, `Restore memory ${backup.memory}`);
      if (!yes || busy) return;
      busy = true;
      const before = await snapshotOf(backup.memory); // what the memory holds now, so that Undo can put it back
      const r = await writeAndCheck(backup.memory, memory).finally(() => { busy = false; renderLocals(); });
      result(r.ok, r.ok ? r.text.replace('now holds', 'holds its backup again,') : r.text);
      status(r.ok ? 'Restored' : 'Check the pedal', r.ok ? 'ok' : 'danger');
      if (r.ok && before) pushUndo(`Restored “${backup.name}” to memory ${backup.memory}`, () => undoWrites([{ ...before, wrote: ptcfOf(memory) }]), { needsPedal: true });
    }
  });

  $('#usb-backups-clear').addEventListener('click', async () => {
    const list = readBackups();
    if (!list.length) return;
    const count = `${list.length} ${list.length === 1 ? 'backup' : 'backups'}`;
    const yes = await confirmWrite(`<p>Delete all <b>${count}</b>?</p>
      <p>They hold the patches the pedal had before each write. Once deleted they cannot be restored from this page, and if you are signed in they are deleted from your account too. The <code>.zptc</code> files that were downloaded with them are not touched.</p>`,
      `Delete ${list.length === 1 ? 'the backup' : `all ${list.length}`}`, 'Delete all backups');
    if (!yes) return;
    removeBackups(readBackups().map(b => b.id));
    renderBackups();
    status(`${count} deleted`, 'ok');
  });

  // MIDI log full screen: the whole box, through the Fullscreen API when the browser has it (Esc leaves), else the window
  const logBox = $('#usb-log-box');
  const logFull = $('#usb-log-full');
  function setLogFull(on) {
    if (on) logBox.open = true;
    logBox.classList.toggle('is-full', on);
    logFull.setAttribute('aria-pressed', String(on));
    logFull.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
    logFull.title = on ? 'Leave full screen (Esc)' : 'Full screen';
    if (on && logBox.requestFullscreen) logBox.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement === logBox) document.exitFullscreen().catch(() => {});
  }
  logFull.addEventListener('click', () => setLogFull(!logBox.classList.contains('is-full')));
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && logBox.classList.contains('is-full')) setLogFull(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && logBox.classList.contains('is-full') && !document.fullscreenElement && !$('#usb-confirm').open) setLogFull(false); });

  $('#usb-copy-log').addEventListener('click', () => navigator.clipboard?.writeText($('#usb-log').textContent).then(() => status('Log copied', 'ok')));
  $('#usb-clear-log').addEventListener('click', () => { lines.length = 0; showLog(); });
  if (!PEDALMIDI.supported()) status(NO_MIDI, 'danger');
  setConnected(false);
  if (pendingSend) {
    status(`Connect the pedal to send the builder's patch to memory ${pendingSend}`);
    $('#usb-connect').click(); // works without a click when MIDI access was granted before; otherwise press Connect
  } else autoConnect();
})();
