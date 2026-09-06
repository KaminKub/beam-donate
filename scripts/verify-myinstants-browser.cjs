// Isolated browser component smoke: real markup/CSS/functions, stubbed API and
// unrelated audio/payment state. This is not authenticated or payment acceptance.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const cut = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
const mp3 = 'https://www.myinstants.com/media/sounds/example.mp3';
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const width of [320, 360, 1280]) {
      for (const kind of ['dashboard', 'donate']) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 900 });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.setRequestInterception(true);
        page.on('request', request => request.abort());
        const dashboard = kind === 'dashboard';
        const html = read(dashboard ? 'public/dashboard/index.html' : 'public/donate-template/index.html');
        const markup = dashboard ? cut(html, '  <!-- MyInstants Sound Browser Modal -->', '  <!-- Download Transactions Modal -->') : cut(html, '  <!-- Tier Sound Picker Modal -->', '  <!-- YouTube Tier Sound Modal -->');
        await page.setContent(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${markup}<input id="customSoundUrl"><input id="timerCustomSoundUrl"><button id="btnDonate">Donate</button></body></html>`);
        await page.addStyleTag({ content: read(dashboard ? 'public/dashboard/admin.css' : 'public/assets/style.css') });
        for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) await page.addStyleTag({ content: style[1] });
        await page.addScriptTag({ content: `
          let mode='blocked', requests=0, staleResolve;
          window.fetch=async()=>{requests++;if(mode==='deferred')return new Promise(r=>staleResolve=r);return {ok:mode==='empty'||mode==='results',status:mode==='blocked'?503:200,json:async()=>({code:mode==='blocked'?'UPSTREAM_BLOCKED':'OK',results:mode==='results'?[{name:'Example',mp3Url:'${mp3}'}]:[]})};};
          const soundPlayer={cleanup(){}};const soundCache=null;function showNotification(){}
          let selectedTierSoundUrl=null,selectedTierSoundIsTemp=false,selectedTierSoundLabel='',currentSoundSource=null;
          function clearTierSoundSource(){}function updateSoundSourceUI(s){currentSoundSource=s;}function renderTierOwnAudioStatus(){}function stopTierSoundPreview(){}function renderTierSoundLibraryList(){}
          function isOverloadResponse(r,d){return r.status===503&&d.error==='SYSTEM_BUSY';}
        ` });
        const js = read(dashboard ? 'public/dashboard/dashboard.js' : 'public/donate-template/app.js');
        await page.addScriptTag({ content: cut(js, 'function escapeHtml(', dashboard ? 'function getStatusBadgeClass(' : 'function getTierOwnAudioStatusLabel(') });
        const code = dashboard ? cut(js, '// ========== Sound Browser Functions', '// ========== Expandable Settings Cards') :
          cut(js, 'let currentPreviewAudio =', '// ========== YouTube Tier Sound') + cut(js, 'async function searchTierSoundCatalog(', 'function resetTierSoundSelection(');
        await page.addScriptTag({ content: code });
        const open = dashboard ? "openSoundBrowser('customSoundUrl')" : "openTierSoundPicker('catalog')";
        const close = dashboard ? 'closeSoundBrowser()' : 'closeTierSoundPicker()';
        const input = dashboard ? '#manualSoundUrl' : '#tierCatalogManualUrl';
        const list = dashboard ? '#soundResults' : '#tierSoundCatalogList';
        await page.evaluate(open);
        await page.waitForSelector(input, { visible: true });
        assert.match(await page.$eval(list, el => el.textContent), /ไม่พร้อมชั่วคราว/);
        assert.equal(await page.$eval(`${list} a`, el => new URL(el.href).hostname), 'www.myinstants.com');
        const bounds = await page.$eval(input, el => { const r = el.getBoundingClientRect();return {left:r.left,right:r.right}; });
        assert.ok(bounds.left >= 0 && bounds.right <= width + 1, `${kind} ${width}: input overflow ${JSON.stringify(bounds)}`);
        await page.type(input, 'https://evil.example/media/sounds/example.mp3');
        await page.focus(input);
        await page.keyboard.press('Enter');
        assert.equal(await page.$eval(input, el => el.validity.valid), false);
        await page.$eval(input, (el, url) => {el.value=url;el.dispatchEvent(new Event('input'));}, mp3);
        await page.keyboard.press('Enter');
        if (dashboard) await page.click('.btn-select-sound');
        assert.equal(await page.evaluate(dashboard ? "document.getElementById('customSoundUrl').value" : 'selectedTierSoundUrl'), mp3);
        assert.equal(await page.$eval('#btnDonate', el => el.disabled), false);
        await page.evaluate("mode='empty';" + open);
        await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('ไม่พบเสียง'), {}, list);
        await page.evaluate("mode='results';" + close + ';' + open);
        await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('Example'), {}, list);
        // Old pending failure cannot overwrite a new result after close/reopen.
        await page.evaluate("mode='deferred';" + close + ';' + open);
        await page.evaluate("mode='results';" + close + ';' + open);
        await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('Example'), {}, list);
        await page.evaluate("staleResolve({ok:false,status:503,json:async()=>({results:[]})})");
        assert.match(await page.$eval(list, el => el.textContent), /Example/);
        if (dashboard) {
          await page.evaluate("mode='blocked';closeSoundBrowser();openSoundBrowser('timerCustomSoundUrl')");
          await page.waitForSelector(input, { visible: true });
          await page.type(input, mp3);
          await page.focus(input);
          await page.keyboard.press('Enter');
          await page.click('.btn-select-sound');
          assert.equal(await page.$eval('#timerCustomSoundUrl', el => el.value), mp3);
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${kind} ${width}px: fallback, URL guard, keyboard selection, empty/results, stale response, no page errors`);
        await page.close();
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
