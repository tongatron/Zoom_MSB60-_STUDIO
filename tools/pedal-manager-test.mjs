// Pedal manager in a real browser against the simulated pedal: Clear patch on a readable memory and on a memory the
// page cannot decode (it proposes the name Empty, keeps a backup first), the delete button of My patches, Undo (patches, writes to
// the pedal, the moves of a new order, and pedal → My patches update confirmation) and no native browser dialog anywhere. Run: PW_CHANNEL=chrome node tools/pedal-manager-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { fakePedal } from './fake-pedal.mjs';

const PORT = 8109;
const server = spawn('node', ['deploy/server.mjs'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: fs.mkdtempSync('/tmp/pm-test-') }, stdio: 'ignore' });
await new Promise(resolve => setTimeout(resolve, 1500));
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const stop = child => new Promise(resolve => {
  if (child.exitCode !== null) return resolve();
  const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  child.kill();
});
let passed = 0;
// A fake Web MIDI access wired to the simulated pedal (runs in the page); MIDI access counts as already granted
function mockMidi({ source, patches, options = {} }) {
  localStorage.setItem('account-welcome', 'ignored');
  const answer = eval(`(${source})`)(patches.map(p => new Uint8Array(p)), { device: 0x6e, ...options });
  const input = { id: 'in', name: 'ZOOM MS Plus Series', open: async () => {}, onmidimessage: null };
  const output = { id: 'out', name: 'ZOOM MS Plus Series', open: async () => {}, send: message => { const r = answer(message); if (r) setTimeout(() => input.onmidimessage?.({ data: new Uint8Array(r) }), 1); } };
  navigator.requestMIDIAccess = async () => ({ inputs: new Map([['in', input]]), outputs: new Map([['out', output]]), onstatechange: null });
  Object.defineProperty(navigator, 'permissions', { value: { query: async () => ({ state: 'granted' }) }, configurable: true });
}
const nativeDialogs = []; // alert, confirm and prompt of the browser: the pages must never raise one
const watch = page => { page.on('dialog', dialog => { nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`); dialog.dismiss(); }); return page; };
const test = async (name, fn) => { try { await fn(); passed++; console.log(`✓ ${name}`); } catch (error) { process.exitCode = 1; console.log(`✗ ${name}\n  ${error.message}`); } };

try {
  const good = [...fs.readFileSync('patches/01base.zptc')];
  let firstName = '';
  const garbage = Array(848).fill(88); // not a PTCF file: the page cannot decode it
  const page = watch(await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })).newPage());
  await page.addInitScript(mockMidi, { source: fakePedal.toString(), patches: [good, garbage] });
  await page.goto(`http://localhost:${PORT}/ms-60b/pedal-manager.html`);
  await page.click('#usb-connect');
  await page.locator('#usb-memories li[data-state="ok"]').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#usb-memories li[data-state="loading"]'), null, { timeout: 60000 });

  await test('a memory that cannot be decoded still offers Read again and Clear patch', async () => {
    await page.locator('#usb-memories li[data-n="2"] .usb-mem-main').click();
    const detail = page.locator('#usb-memories li[data-n="2"] .usb-mem-detail');
    assert.match(await detail.innerText(), /Not a PTCF file/);
    assert.equal(await detail.locator('[data-act="clear"]').isEnabled(), true);
  });
  await test('Clear patch proposes the name Empty, backs up the memory first and writes it', async () => {
    const download = page.waitForEvent('download');
    await page.locator('#usb-memories li[data-n="2"] [data-act="clear"]').click();
    assert.equal(await page.inputValue('#usb-clear-name'), 'Empty');
    await page.fill('#usb-clear-name', 'Nothing');
    await page.click('#usb-confirm-yes');
    assert.match((await download).suggestedFilename(), /^backup 002/);
    await page.waitForFunction(() => /Cleared/.test(document.querySelector('#usb-status')?.textContent || ''), null, { timeout: 20000 });
    assert.match(await page.locator('#usb-memories li[data-n="2"] .usb-name').innerText(), /Nothing/);
    assert.equal(await page.locator('#usb-backups li').count() > 0, true, 'the backup is listed');
  });
  await test('a readable patch is cleared as Empty and then has nothing left to clear', async () => {
    await page.waitForTimeout(800); // the first write is finished: the page takes no new write while it is busy
    firstName = await page.locator('#usb-memories li[data-n="1"] .usb-name').innerText();
    await page.locator('#usb-memories li[data-n="1"] .usb-mem-main').click();
    const clear = page.locator('#usb-memories li[data-n="1"] [data-act="clear"]');
    assert.equal(await clear.isEnabled(), true);
    const download = page.waitForEvent('download');
    await clear.click();
    await page.waitForSelector('#usb-confirm[open]');
    assert.equal(await page.inputValue('#usb-clear-name'), 'Empty');
    await page.click('#usb-confirm-yes');
    await download;
    await page.waitForFunction(() => /Empty/.test(document.querySelector('#usb-memories li[data-n="1"] .usb-name')?.textContent || ''), null, { timeout: 20000 });
    assert.equal(await page.locator('#usb-memories li[data-n="1"] [data-act="clear"]').isDisabled(), true);
  });

  // Memory 2 held a file the page cannot decode, so clearing it is only kept in Backups; clearing memory 1 can be undone
  await test('Cancel in the Undo question changes nothing and keeps the change on the list', async () => {
    assert.equal(await page.locator('#usb-undo-text').innerText(), 'Cleared memory 1');
    await page.click('#usb-undo');
    await page.waitForSelector('#usb-confirm[open]');
    assert.equal(await page.locator('#usb-confirm-title').textContent(), 'Undo');
    await page.click('#usb-confirm [data-confirm="no"]');
    assert.match(await page.locator('#usb-memories li[data-n="1"] .usb-name').innerText(), /Empty/);
    assert.equal(await page.locator('#usb-undo-text').innerText(), 'Cleared memory 1');
    assert.equal(await page.locator('#usb-undo').isEnabled(), true);
  });
  await test('without the pedal the Undo of a write to it waits for the connection', async () => {
    await page.click('#usb-disconnect');
    await page.locator('#usb-connect:not([hidden])').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('#usb-undo').isDisabled(), true);
    assert.match(await page.locator('#usb-undo').getAttribute('title'), /Connect the pedal/);
    await page.click('#usb-connect');
    await page.waitForFunction(() => !document.querySelector('#usb-memories li[data-state="loading"]') && document.querySelector('#usb-memories li[data-state="ok"]'), null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('#usb-undo').disabled, null, { timeout: 20000 });
  });
  await test('Undo puts the cleared patch back, keeps a backup of what it replaces and reads it back', async () => {
    const backups = await page.locator('#usb-backups li').count();
    await page.click('#usb-undo');
    await page.waitForSelector('#usb-confirm[open]');
    const body = await page.locator('#usb-confirm-body').innerText();
    assert.ok(body.includes(`Memory 1: ${firstName} replaces Empty`), body);
    await page.click('#usb-confirm-yes');
    await page.waitForFunction(() => /Undone/.test(document.querySelector('#usb-status')?.textContent || ''), null, { timeout: 20000 });
    assert.equal(await page.locator('#usb-memories li[data-n="1"] .usb-name').innerText(), firstName);
    assert.equal(await page.locator('#usb-backups li').count(), backups + 1, 'what it replaced is in Backups');
    assert.match(await page.locator('#usb-result').innerText(), /read back and identical/);
    assert.equal(await page.locator('#usb-undo').isDisabled(), true, 'nothing left to undo');
  });

  // Dragging a memory in the list opens the new order with its Write button
  const other = [...fs.readFileSync('patches/06FLIP.zptc')];
  const page2 = watch(await (await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })).newPage());
  await page2.addInitScript(mockMidi, { source: fakePedal.toString(), patches: [good, other], options: { volatilePadding: true } });
  await page2.goto(`http://localhost:${PORT}/ms-60b/pedal-manager.html`);
  await page2.click('#usb-connect');
  await page2.waitForFunction(() => document.querySelectorAll('#usb-memories li[data-state="ok"]').length === 100, null, { timeout: 90000 });
  const nameOf = n => page2.locator(`#usb-memories li[data-n="${n}"] .usb-name`).innerText();
  await test('the memories have no Move to… or Swap with… buttons, and Clear patch is red', async () => {
    await page2.locator('#usb-memories li[data-n="1"] .usb-mem-main').click();
    const detail = page2.locator('#usb-memories li[data-n="1"] .usb-mem-detail');
    assert.equal(await detail.getByText(/Move to|Swap with/).count(), 0);
    assert.equal(await detail.locator('[data-act="clear"]').evaluate(el => getComputedStyle(el).color + '|' + getComputedStyle(el).borderTopColor), 'rgb(248, 81, 73)|rgb(248, 81, 73)');
  });
  const [first, second] = [await nameOf(1), await nameOf(2)];
  assert.notEqual(first, second, 'the two test patches have different names');
  await test('dragging memory 1 under memory 2 plans the change and Write saves it, read back', async () => {
    await page2.locator('#usb-memories li[data-n="1"] .usb-mem-main').click(); // close the detail
    await page2.locator('#usb-memories li[data-n="1"]').dragTo(page2.locator('#usb-memories li[data-n="2"]'), { targetPosition: { x: 100, y: 30 } });
    await page2.locator('#usb-arrange-panel:not([hidden])').waitFor();
    assert.match(await page2.locator('#usb-arr-changes').innerText(), /2 memories change/);
    await page2.click('#usb-arr-write');
    await page2.click('#usb-confirm-yes');
    await page2.waitForFunction(() => /Arranged/.test(document.querySelector('#usb-status')?.textContent || ''), null, { timeout: 60000 });
    assert.deepEqual([await nameOf(1), await nameOf(2)], [second, first]);
  });
  await test('Undo puts the old order back: both memories hold their patches again', async () => {
    assert.equal(await page2.locator('#usb-undo-text').innerText(), 'Rearranged 2 memories');
    await page2.click('#usb-undo');
    await page2.waitForSelector('#usb-confirm[open]');
    await page2.click('#usb-confirm-yes');
    await page2.waitForFunction(() => /Undone/.test(document.querySelector('#usb-status')?.textContent || ''), null, { timeout: 60000 });
    assert.deepEqual([await nameOf(1), await nameOf(2)], [first, second]);
  });
  await test('while a new order is planned, Undo goes back one move at a time', async () => {
    await page2.locator('#usb-memories li[data-n="1"]').dragTo(page2.locator('#usb-memories li[data-n="2"]'), { targetPosition: { x: 100, y: 30 } });
    await page2.locator('#usb-arrange-panel:not([hidden])').waitFor();
    assert.equal(await page2.locator('#usb-undo-text').innerText(), 'Last move in the new order');
    await page2.click('#usb-undo');
    assert.match(await page2.locator('#usb-arr-changes').innerText(), /No changes yet/);
    assert.equal(await page2.locator('#usb-undo').isDisabled(), true);
    await page2.click('#usb-arr-cancel');
  });

  // The connection is made again by itself on a new page, and stays off after Disconnect
  const page3 = watch(await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage());
  await page3.addInitScript(mockMidi, { source: fakePedal.toString(), patches: [good, other] });
  await page3.addInitScript(() => localStorage.setItem('ms60b-library', JSON.stringify([{ id: 'p1', name: 'My patch', effects: [{ index: 0, on: true, values: {} }], updatedAt: new Date().toISOString() }])));
  await page3.addInitScript(() => localStorage.setItem('ms60b-builder', JSON.stringify({ name: 'Draft patch', effects: [{ index: 0, on: true, values: {} }] })));
  await page3.addInitScript(() => localStorage.setItem('ms60b-usb-backups', JSON.stringify([null, { id: 'bad', at: 'not-a-date', data: 'not-base64' }])));
  await page3.goto(`http://localhost:${PORT}/ms-60b/pedal-manager.html`);
  await test('corrupted local USB backups are ignored without breaking the manager', async () => {
    assert.equal(await page3.locator('#usb-backup-count').innerText(), '0');
    assert.equal(await page3.locator('#usb-backups-clear').isDisabled(), true);
  });
  await test('before each send button My patches has an Edit button that opens the patch in the builder', async () => {
    const edit = page3.locator('#usb-locals li[data-key="lib:p1"] .usb-edit');
    assert.equal(await edit.innerText(), 'Edit');
    assert.match(await edit.getAttribute('href'), /^builder\.html#p=/);
    assert.equal(await edit.evaluate(el => el.nextElementSibling.matches('[data-act="send"]')), true, 'it sits just before the send button');
  });
  await test('the open builder draft can be deleted without touching saved patches', async () => {
    const row = page3.locator('#usb-locals li[data-key="draft"]');
    const trash = row.locator('[data-act="delete"]');
    assert.equal(await trash.isEnabled(), true);
    assert.equal(await trash.getAttribute('title'), 'Delete builder draft');
    await trash.click();
    await page3.waitForSelector('#usb-confirm[open]');
    assert.equal(await page3.locator('#usb-confirm-title').textContent(), 'Delete draft');
    await page3.click('#usb-confirm-yes');
    assert.equal(await row.count(), 0);
    assert.equal(await page3.evaluate(() => localStorage.getItem('ms60b-builder')), null);
    assert.equal(await page3.locator('#usb-local-count').innerText(), '1');
    await page3.click('#usb-undo');
    await row.waitFor();
    assert.equal(await page3.evaluate(() => JSON.parse(localStorage.getItem('ms60b-builder')).name), 'Draft patch');
  });
  await test('My patches has a trash button before Edit; it asks first and Delete takes the patch out', async () => {
    const row = page3.locator('#usb-locals li[data-key="lib:p1"]');
    const trash = row.locator('[data-act="delete"]');
    assert.match(await trash.getAttribute('aria-label'), /^Delete My patch from My patches$/);
    assert.equal(await trash.evaluate(el => el.nextElementSibling.matches('.usb-edit')), true, 'it sits just before Edit');
    await trash.click();
    await page3.waitForSelector('#usb-confirm[open]');
    assert.equal(await page3.locator('#usb-confirm-title').textContent(), 'Delete patch');
    await page3.click('#usb-confirm [data-confirm="no"]');
    assert.equal(await row.count(), 1, 'Cancel keeps the patch');
    await trash.click();
    await page3.click('#usb-confirm-yes');
    assert.equal(await row.count(), 0);
    assert.equal(await page3.locator('#usb-local-count').innerText(), '0');
    assert.deepEqual(await page3.evaluate(() => [JSON.parse(localStorage.getItem('ms60b-library')).length, Object.keys(JSON.parse(localStorage.getItem('ms60b-deleted'))).join()]), [0, 'p1'], 'remembered as deleted, like in the builder');
  });
  await test('Undo brings the deleted patch back (message button, then Ctrl+Z) and clears the deletion', async () => {
    const row = page3.locator('#usb-locals li[data-key="lib:p1"]');
    assert.equal(await page3.locator('#usb-undo-text').innerText(), 'Deleted “My patch”');
    await page3.locator('.dialogs-toast [data-toast="action"]').click();
    assert.equal(await row.count(), 1, 'the Undo button of the message');
    assert.equal(await page3.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ms60b-deleted'))).length), 0);
    await row.locator('[data-act="delete"]').click();
    await page3.click('#usb-confirm-yes');
    assert.equal(await row.count(), 0);
    await page3.keyboard.press('Control+z');
    await row.waitFor();
    assert.equal(await page3.locator('#usb-undo').isDisabled(), true, 'nothing left to undo');
  });
  await test('the pedal connects by itself after the first connection, also on a new page', async () => {
    await page3.click('#usb-connect');
    await page3.locator('#usb-disconnect:not([hidden])').waitFor({ timeout: 20000 });
    await page3.goto(`http://localhost:${PORT}/ms-60b/guide.html`);
    await page3.goto(`http://localhost:${PORT}/ms-60b/pedal-manager.html`);
    await page3.locator('#usb-disconnect:not([hidden])').waitFor({ timeout: 20000 });
    await page3.locator('#usb-memories li[data-state="ok"]').first().waitFor({ timeout: 20000 });
  });
  await test('after Disconnect the next visit does not connect by itself', async () => {
    await page3.click('#usb-disconnect');
    await page3.goto(`http://localhost:${PORT}/ms-60b/pedal-manager.html`);
    await page3.waitForTimeout(1500);
    assert.equal(await page3.locator('#usb-connect').isVisible(), true);
  });
  await test('Copy to My patches can be undone', async () => {
    await page3.click('#usb-connect');
    await page3.locator('#usb-memories li[data-state="ok"]').first().waitFor({ timeout: 20000 });
    await page3.locator('#usb-memories li[data-n="1"] .usb-mem-main').click();
    await page3.locator('#usb-memories li[data-n="1"] [data-act="link"]').click();
    await page3.selectOption('#usb-link-patch', 'p1');
    await page3.click('#usb-confirm-yes');
    assert.equal(await page3.evaluate(() => JSON.parse(localStorage.getItem('ms60b-pedal-sync')).links[1].patchId), 'p1');
    assert.equal(await page3.locator('#usb-memories li[data-n="1"] [data-act="link"]').innerText(), 'Change My patch link');
    await page3.locator('#usb-memories li[data-n="1"] .usb-mem-main').click();
    await page3.locator('#usb-memories li[data-n="1"] .usb-mem-main').click();
    await page3.locator('#usb-memories li[data-n="1"] [data-act="copy"]').click();
    assert.equal(await page3.locator('#usb-local-count').innerText(), '2');
    const copiedId = await page3.evaluate(() => JSON.parse(localStorage.getItem('ms60b-library')).find(p => p.id !== 'p1').id);
    await page3.evaluate(id => localStorage.setItem('ms60b-pedal-sync', JSON.stringify({ enabled: false, links: { 1: { patchId: id, pedalBaseline: 'changed', libraryBaseline: 'changed' } } })), copiedId);
    await page3.locator('#usb-memories li[data-n="1"] .usb-mem-main').click();
    await page3.locator('#usb-memories li[data-n="1"] .usb-mem-main').click();
    await page3.locator('#usb-memories li[data-n="1"] [data-act="sync"]').click();
    await page3.waitForSelector('#usb-confirm[open]');
    assert.equal(await page3.locator('#usb-confirm-title').innerText(), 'Update My patch');
    await page3.click('#usb-confirm-yes');
    await page3.waitForFunction(id => JSON.parse(localStorage.getItem('ms60b-pedal-sync')).links[1].patchId === id, copiedId);
    assert.match(await page3.locator('#usb-status').innerText(), /Updated/);
    await page3.click('#usb-undo');
    await page3.waitForFunction(id => JSON.parse(localStorage.getItem('ms60b-pedal-sync')).links[1].pedalBaseline === 'changed', copiedId);
    assert.match(await page3.locator('#usb-undo-text').innerText(), /^Copied “.+” to My patches$/);
    await page3.click('#usb-undo');
    assert.equal(await page3.locator('#usb-local-count').innerText(), '1');
  });
  await test('no page raised an alert, a confirm or a prompt of the browser', async () => {
    assert.deepEqual(nativeDialogs, []);
  });
} finally {
  await stop(server);
  await browser.close();
}
console.log(`${passed} passed`);
