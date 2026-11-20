const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────
const RECOVERY_CODE = process.env.RECOVERY_CODE || '2aas0givut';

// Fallback usernames if accounts.txt is not present:
const FALLBACK_USERNAMES = [
  'Thdr'
];

function getPermanentUsernames() {
  const accountsFile = path.join(__dirname, '..', 'accounts.txt');
  if (fs.existsSync(accountsFile)) {
    const list = fs.readFileSync(accountsFile, 'utf8')
      .split(/[\r\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return FALLBACK_USERNAMES;
}

const USERNAMES = (process.env.USERS && process.env.USERS.trim().length > 0)
  ? process.env.USERS.split(',').map(u => u.trim()).filter(Boolean)
  : getPermanentUsernames();
const TG_TOKEN   = process.env.TG_TOKEN   || '8794354513:AAHKXWAM9K_xPE6i4z25LLyrinKx9t4v4ho';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '1548646919';

const ITEM_MAP = {
  'mastic':   'Clay',
  'lockpick': 'Skey',
  'fball':    'FCB',
  'rball':    'RBB',
  'eball':    'EBB',
  'sring':    'Rings',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(text) {
  if (process.env.DRY_RUN) { console.log('\n[DRY_RUN] Would send:\n' + text); return; }
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        console.log(`✅ Sent to Telegram (attempt ${attempt})`);
        return true;
      }
      console.error(`Telegram attempt ${attempt} failed (${res.status}):`, json.description || 'Bad Gateway/Error');
    } catch (e) {
      console.error(`Telegram attempt ${attempt} network error:`, e.message);
    }
    await sleep(4000);
  }
}

// ─── FIND SEARCH FRAME ────────────────────────────────────────
async function findSearchFrame(page) {
  for (const frame of page.frames()) {
    try {
      const inp = await frame.$('input#search_input-text, input[name="search_input"]');
      if (inp) return { frame, inp };
    } catch(e) {}
  }
  return null;
}

// ─── LOGIN ────────────────────────────────────────────────────
// Proven in headless debugging: dialog only opens after the cookie banner is
// accepted, the page is network-idle, and the click is a REAL Playwright click.
async function shot(page, name) {
  await page.screenshot({ path: `${name}.png` }).catch(() => {});
}

async function login(page) {
  console.log('🔐 Logging in...');
  await page.goto('https://galaxy.mobstudio.ru/web/', { waitUntil: 'networkidle', timeout: 60000 })
    .catch(e => console.log('  (goto warning)', e.message));
  await sleep(4000);

  const alreadyLoggedIn = await page.evaluate(() => !!document.querySelector('.mdc-drawer__content'));
  if (alreadyLoggedIn) { console.log('✅ Already logged in'); return; }

  // 1. Accept cookie banner (if present)
  await page.locator('a.mdc-button', { hasText: /^\s*accept\s*$/i }).first()
    .click({ timeout: 4000 }).catch(() => {});
  await sleep(1500);

  // 2. Click "I have an account" (real click) and wait for the dialog input
  let input = null;
  for (let attempt = 1; attempt <= 3 && !input; attempt++) {
    console.log(`  👉 Clicking "I have an account" (attempt ${attempt})...`);
    await page.locator('a.mdc-button', { hasText: /have an account/i }).first()
      .click({ timeout: 8000 }).catch(e => console.log('  click warn:', e.message));
    input = await page.waitForSelector('input', { state: 'visible', timeout: 6000 }).catch(() => null);
  }
  if (!input) {
    await shot(page, 'screenshot');
    throw new Error('Recovery code input not found');
  }

  // 3. Fill recovery code (nativeSetter keeps Vue reactive)
  console.log('  👉 Filling recovery code...');
  await page.evaluate((code) => {
    const inp = Array.from(document.querySelectorAll('input')).find(i => i.offsetParent !== null);
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, code);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, RECOVERY_CODE);
  await sleep(1000);

  // 4. Accept
  console.log('  👉 Clicking Accept...');
  const acceptBtn = page.locator('[data-mdc-dialog-action="accept"]').first();
  await acceptBtn.click({ timeout: 6000 }).catch(async () => {
    await page.evaluate(() => {
      const b = document.querySelector('[data-mdc-dialog-action="accept"]');
      if (b) b.click();
    });
  });

  // 5. Wait for the logged-in drawer to show up
  const ok = await page.waitForSelector('.mdc-drawer__content', { timeout: 25000 }).catch(() => null);
  await sleep(2000);
  await page.evaluate(() => {
    document.querySelectorAll('.mdc-dialog__scrim').forEach(el => { el.style.display = 'none'; el.style.pointerEvents = 'none'; });
    document.querySelectorAll('.mdc-dialog').forEach(el => { el.classList.remove('mdc-dialog--open'); el.style.display = 'none'; });
  });
  if (!ok) { await shot(page, 'screenshot'); throw new Error('Login did not complete (no drawer)'); }
  console.log('✅ Login complete');
}

// ─── SEARCH USER ──────────────────────────────────────────────
async function waitForSearchFrame(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const f = await findSearchFrame(page);
    if (f) return f;
    await sleep(500);
  }
  return null;
}

async function openSearchScreen(page) {
  // Already open?
  let found = await findSearchFrame(page);
  if (found) return found;

  for (let attempt = 1; attempt <= 3 && !found; attempt++) {
    const item = page.locator('.mdc-drawer__content a.mdc-list-item', { hasText: /^\s*search\s*$/i }).first();
    await item.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await item.click({ timeout: 6000 }).catch(e => console.log('  drawer click warn:', e.message.slice(0, 80)));
    found = await waitForSearchFrame(page, 20000);
  }
  return found;
}

async function searchUser(page, username) {
  console.log(`  🔍 Searching: ${username}`);

  const found = await openSearchScreen(page);
  if (!found) {
    console.log('  ❌ Search input not found');
    await shot(page, `fail_search_${username}`);
    return false;
  }

  // Wait until the search frame is fully mounted (otherwise a late re-render wipes the input)
  for (let i = 0; i < 20; i++) {
    const mounted = await found.frame.evaluate(() => /recommended|ratings|privileges/i.test(document.body.innerText)).catch(() => false);
    if (mounted) break;
    await sleep(500);
  }
  await sleep(1500);

  // Real (trusted) mouse + keyboard events; verify the text survives, retry if wiped
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const cur = (await findSearchFrame(page)) || found;
    await cur.inp.click();
    await sleep(300);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(300);
    await page.keyboard.type(username, { delay: 90 });
    await sleep(1500);
    const typed = await cur.inp.inputValue().catch(() => '?');
    console.log(`  ⌨️  Input now: "${typed}" (attempt ${attempt})`);
    ok = typed.toLowerCase() === username.toLowerCase();
  }
  // Synthetic Enter only (a REAL Enter natively submits the form and reloads the frame, wiping results)
  const cur2 = (await findSearchFrame(page)) || found;
  await cur2.frame.evaluate(() => {
    const inp = document.querySelector('input#search_input-text') || document.querySelector('input[name="search_input"]');
    if (!inp) return;
    const form = inp.closest('form');
    if (form) form.addEventListener('submit', e => e.preventDefault(), true);
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    inp.dispatchEvent(new KeyboardEvent('keydown', opts));
    inp.dispatchEvent(new KeyboardEvent('keypress', opts));
    inp.dispatchEvent(new KeyboardEvent('keyup', opts));
  });

  console.log(`  ✅ Typed "${username}", waiting for results...`);
  await sleep(5000);
  return true;
}

// ─── CLICK RESULT CARD ────────────────────────────────────────
async function profileOpenFor(page, username) {
  for (const f of page.frames()) {
    if (!/page_action=whois/.test(f.url())) continue;
    const txt = await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (txt.toUpperCase().includes(username.toUpperCase())) return f;
  }
  return null;
}

async function clickCard(page, username) {
  console.log(`  📋 Looking for card: ${username}`);
  let lastClick = 0;

  for (let attempt = 0; attempt < 60; attempt++) {   // up to ~30s
    // Success: profile already opened (search may jump straight to it, or our click landed)
    if (await profileOpenFor(page, username)) {
      console.log(`  ✅ Profile open for ${username}`);
      await sleep(5000); // let profile content finish loading
      return true;
    }

    // Click a matching card (at most once every 8s)
    if (Date.now() - lastClick > 8000) {
      for (const frame of page.frames()) {
        try {
          const found = await frame.evaluate((uname) => {
            const cards = Array.from(document.querySelectorAll('.user_list__item__inner, .user_list_item_web'));
            let card = cards.find(el => {
              const txt = el.textContent.trim().toUpperCase();
              return txt.startsWith(uname.toUpperCase()) || new RegExp('\\b' + uname + '\\b', 'i').test(txt);
            });
            if (!card) {
              card = cards.find(el => el.textContent.toUpperCase().includes(uname.toUpperCase()));
            }
            if (card) {
              ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                card.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true }));
              });
              if (card.click) card.click();
              return true;
            }
            return false;
          }, username);
          if (found) { console.log(`  🖱️  Clicked card for ${username}`); lastClick = Date.now(); break; }
        } catch (e) { lastClick = Date.now(); /* frame navigated mid-click = click landed */ }
      }
    }
    await sleep(500);
  }
  console.log(`  ❌ Card not found for ${username}`);
  await shot(page, `fail_card_${username}`);
  for (const f of page.frames()) {
    const info = await f.evaluate(() => ({
      url: location.href,
      lists: Array.from(document.querySelectorAll('[class*="user_list"], [class*="search"]')).slice(0, 8).map(e => `${e.tagName}.${String(e.className).slice(0, 60)} :: ${e.textContent.trim().slice(0, 40)}`),
      text: document.body ? document.body.innerText.slice(0, 200).replace(/\n/g, ' | ') : ''
    })).catch(() => null);
    if (info) console.log('  DIAG frame:', JSON.stringify(info));
  }
  return false;
}

// ─── CLICK GAME ITEMS ARROW ───────────────────────────────────
async function clickArrow(page) {
  console.log('  🎮 Waiting for Game Items arrow...');
  for (let attempt = 0; attempt < 50; attempt++) {    // up to ~25s
    // Success: inventory page already open (the click navigated the frame)
    if (page.frames().some(f => /page_action=show_inventory/.test(f.url()))) {
      console.log('  ✅ Inventory page open');
      await sleep(4000);
      return true;
    }
    for (const frame of page.frames()) {
      if (!/page_action=whois/.test(frame.url())) continue;
      try {
        const clicked = await frame.evaluate(() => {
          const arrow = document.querySelector('a.user_info_section_title.additional_margin') ||
                        document.querySelector('a.user_info_section_title');
          if (!arrow) return false;
          arrow.scrollIntoView({ block: 'center' });
          const icon = arrow.querySelector('.component_svg_icon, svg') || arrow;
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
            icon.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true }));
            arrow.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true }));
          });
          if (icon.click) icon.click();
          if (arrow.click) arrow.click();
          return true;
        });
        if (clicked) {
          console.log('  ✅ Arrow clicked');
          await sleep(5000);
          return true;
        }
      } catch (e) {}
    }
    await sleep(500);
  }
  console.log('  ⚠️ Arrow not found, trying to scrape anyway');
  await shot(page, 'fail_arrow');
  for (const f of page.frames()) {
    const info = await f.evaluate(() => ({
      url: location.href,
      anchors: Array.from(document.querySelectorAll('a')).slice(0, 20).map(a => `${a.className.toString().slice(0, 45)} :: ${a.textContent.trim().slice(0, 30)}`),
      prize: Array.from(document.querySelectorAll('img')).filter(i => /prize/.test(i.src)).length,
      text: document.body ? document.body.innerText.slice(0, 300).replace(/\n/g, ' | ') : ''
    })).catch(() => null);
    if (info && (info.prize > 0 || /page_action/.test(info.url))) console.log('  DIAG frame:', JSON.stringify(info, null, 1));
  }
  return false;
}

// ─── SCRAPE ITEMS ─────────────────────────────────────────────
async function scrapeItems(page) {
  console.log('  📦 Scraping items...');
  const counts = { Clay: 0, Skey: 0, FCB: 0, RBB: 0, EBB: 0, Rings: 0 };

  for (const frame of page.frames()) {
    try {
      const items = await frame.evaluate(() => {
        const results = { Clay: 0, Skey: 0, FCB: 0, RBB: 0, EBB: 0, Rings: 0 };
        let foundAny = false;

        function resolveName(filename) {
          if (filename.includes('mastic')) return 'Clay';
          // Match standard skeleton key (Отмычка), exclude diamond / gold / master lockpicks
          if (/^lockpick|^cb_lockpick/i.test(filename) || (filename.includes('lockpick') && !filename.includes('diamond') && !filename.includes('gold') && !filename.includes('master'))) {
            return 'Skey';
          }
          if (filename.includes('fball')) return 'FCB';
          if (filename.includes('rball')) return 'RBB';
          if (filename.includes('eball')) return 'EBB';
          if (filename.includes('sring')) return 'Rings';
          return null;
        }

        // 1. Direct Galaxy Web structure: .s__game_item
        const gameItems = document.querySelectorAll('.s__game_item, .s__game_countable_item');
        if (gameItems && gameItems.length > 0) {
          gameItems.forEach(el => {
            const img = el.querySelector('img');
            if (!img) return;
            const src = img.src || img.getAttribute('data-src') || '';
            if (!src.includes('prize_icons')) return;
            const filename = src.split('/').pop().toLowerCase();
            const name = resolveName(filename);
            if (!name) return;

            const countEl = el.querySelector('.s__count');
            let qty = 0;
            if (countEl) {
              qty = parseInt(countEl.textContent.trim(), 10) || 0;
            } else {
              const m = el.textContent.match(/\d+/);
              if (m) qty = parseInt(m[0], 10) || 0;
            }
            results[name] = (results[name] || 0) + qty;
            foundAny = true;
          });
          if (foundAny) return results;
        }

        // 2. Fallback wrappers
        const wrappers = Array.from(document.querySelectorAll('div, a, span')).filter(el => {
          try {
            const hasImg = el.querySelector('img');
            const hasText = /\d+/.test(el.textContent.trim());
            const isSmall = el.offsetWidth > 15 && el.offsetWidth < 140;
            return hasImg && hasText && isSmall && el.children.length <= 4;
          } catch(e) { return false; }
        });

        wrappers.forEach(el => {
          const img = el.querySelector('img');
          if (!img) return;
          const src = img.src || '';
          if (!src.includes('prize_icons')) return;
          const filename = src.split('/').pop().toLowerCase();
          const name = resolveName(filename);
          if (!name) return;
          const nums = el.textContent.match(/\d+/);
          if (nums) {
            const qty = parseInt(nums[0], 10) || 0;
            results[name] = (results[name] || 0) + qty;
            foundAny = true;
          }
        });

        return foundAny ? results : null;
      });

      if (items && Object.keys(items).length > 0) {
        Object.assign(counts, items);
        console.log('  ✅ Items:', counts);
        return counts;
      }
    } catch(e) {}
  }
  return counts;
}

// ─── PROCESS ONE USER ─────────────────────────────────────────
async function processUser(page, username) {
  console.log(`\n━━━ 👤 ${username} ━━━`);
  const searched = await searchUser(page, username);
  if (!searched) return { user: username, Clay: 0, Skey: 0, FCB: 0, RBB: 0, EBB: 0, Rings: 0 };

  const cardOk = await clickCard(page, username);
  if (!cardOk) return { user: username, Clay: 0, Skey: 0, FCB: 0, RBB: 0, EBB: 0, Rings: 0 };

  await clickArrow(page);
  let items = await scrapeItems(page);
  for (let i = 0; i < 5 && Object.values(items).every(v => v === 0); i++) {
    await sleep(4000);
    items = await scrapeItems(page);
  }

  await sleep(3000); // pause before next
  return { user: username, ...items };
}

// ─── FORMAT MESSAGE ───────────────────────────────────────────
function formatBatchMessage(batchResults, batchNum, totalBatches, totalAllUsers, elapsed, allResultsSoFar) {
  const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const batchLabel = totalBatches > 1 ? ` (Half ${batchNum}/${totalBatches})` : '';
  const lines = [
    `🌌 *Galaxy Spectator Results${batchLabel}*`,
    `🕐 ${time} (${elapsed}s)`,
    '```',
    'User        Clay Skey FCB  RBB  EBB  Rings',
    '─────────────────────────────────────────',
  ];

  let totalClay = 0, totalSkey = 0, totalFCB = 0, totalRBB = 0, totalEBB = 0, totalRings = 0;

  batchResults.forEach(r => {
    totalClay  += (r.Clay || 0);
    totalSkey  += (r.Skey || 0);
    totalFCB   += (r.FCB || 0);
    totalRBB   += (r.RBB || 0);
    totalEBB   += (r.EBB || 0);
    totalRings += (r.Rings || 0);

    const name = r.user.padEnd(11);
    lines.push(`${name}${String(r.Clay).padEnd(5)}${String(r.Skey).padEnd(5)}${String(r.FCB).padEnd(5)}${String(r.RBB).padEnd(5)}${String(r.EBB).padEnd(5)}${r.Rings}`);
  });

  lines.push('─────────────────────────────────────────');
  const totalLabel = 'TOTAL'.padEnd(11);
  lines.push(`${totalLabel}${String(totalClay).padEnd(5)}${String(totalSkey).padEnd(5)}${String(totalFCB).padEnd(5)}${String(totalRBB).padEnd(5)}${String(totalEBB).padEnd(5)}${totalRings}`);
  lines.push('```');

  // Money calculation: Skey, Clay, FCB, EBB
  const batchMoney = (
    (totalSkey * 3.5 * 1.1) +
    (totalClay * 3.5 * 1.1) +
    (totalFCB * 1.1) +
    (totalEBB * 3.7 * 1.1)
  ).toFixed(2);
  lines.push(`💰 *Total Money:* \`${batchMoney}\` (Skey: ${totalSkey}, Clay: ${totalClay}, FCB: ${totalFCB}, EBB: ${totalEBB})`);

  if (totalBatches > 1) {
    lines.push(`✅ Batch ${batchNum}/${totalBatches} Done! (${allResultsSoFar.length}/${totalAllUsers} accounts checked)`);
    if (batchNum === totalBatches) {
      // Grand total across all batches
      let grandClay = 0, grandSkey = 0, grandFCB = 0, grandEBB = 0;
      allResultsSoFar.forEach(r => {
        grandClay += (r.Clay || 0);
        grandSkey += (r.Skey || 0);
        grandFCB  += (r.FCB || 0);
        grandEBB  += (r.EBB || 0);
      });
      const grandMoney = (
        (grandSkey * 3.5 * 1.1) +
        (grandClay * 3.5 * 1.1) +
        (grandFCB * 1.1) +
        (grandEBB * 3.7 * 1.1)
      ).toFixed(2);
      lines.push(`\n🏆 *Grand Total Money (All ${totalAllUsers}):* \`${grandMoney}\``);
    }
  } else {
    lines.push(`✅ Done! ${batchResults.length}/${totalAllUsers} accounts checked`);
  }

  return lines.join('\n');
}


// ─── SCHEDULE CHECK (For hourly cron) ─────────────────────────
function shouldRunSchedule() {
  // If run via workflow_dispatch (manual or telegram bot), always run
  if (process.env.ACTION || process.env.USERS || process.env.HALF === 'true') {
    return true;
  }
  const scheduleFile = path.join(__dirname, '..', 'schedule.json');
  if (!fs.existsSync(scheduleFile)) {
    console.log('schedule.json not found, proceeding with run.');
    return true;
  }
  try {
    const config = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
    if (!config.enabled) {
      console.log('⏸️ Auto-check is OFF in schedule.json. Skipping scheduled run.');
      return false;
    }
    const intervalHours = Number(config.intervalHours) || 6;
    const lastRun = Number(config.lastRun) || 0;
    const now = Date.now();
    const elapsedHours = (now - lastRun) / (1000 * 60 * 60);

    // Give a 15-minute margin for cron drift
    if (elapsedHours < (intervalHours - 0.25)) {
      console.log("Auto-check interval not reached yet, skipping.");
      return false;
    }

    // Update lastRun timestamp in schedule.json and commit back
    config.lastRun = now;
    fs.writeFileSync(scheduleFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log("Auto-check interval reached. Starting check!");
    return true;
  } catch (err) {
    console.error('Error reading schedule.json:', err.message);
    return true;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  if (!shouldRunSchedule()) return;

  console.log('🚀 Galaxy Spectator starting...');
  const isHalfMode = (process.env.ACTION === 'Run Half Batch Check') || (process.env.HALF === 'true');
  console.log(`Mode: ${isHalfMode ? 'HALF-BATCH (2 halves)' : 'STANDARD (all at once)'}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  const allResults = [];

  try {
    await login(page);

    // Prepare batches
    let batches = [];
    if (isHalfMode && USERNAMES.length > 1) {
      const mid = Math.ceil(USERNAMES.length / 2);
      batches.push(USERNAMES.slice(0, mid));
      batches.push(USERNAMES.slice(mid));
    } else {
      batches.push(USERNAMES);
    }

    for (let bIndex = 0; bIndex < batches.length; bIndex++) {
      const currentBatch = batches[bIndex];
      const batchStartTime = Date.now();
      const batchResults = [];

      console.log(`\n▶️ Starting Batch ${bIndex + 1}/${batches.length} (${currentBatch.length} users)...`);

      for (const username of currentBatch) {
        try {
          const data = await processUser(page, username);
          batchResults.push(data);
          allResults.push(data);
        } catch(err) {
          console.error(`Error on ${username}:`, err.message);
          const fallback = { user: username, Clay: 0, Skey: 0, FCB: 0, RBB: 0, EBB: 0, Rings: 0 };
          batchResults.push(fallback);
          allResults.push(fallback);
        }
      }

      const elapsed = Math.round((Date.now() - batchStartTime) / 1000);
      const msg = formatBatchMessage(batchResults, bIndex + 1, batches.length, USERNAMES.length, elapsed, allResults);
      await sendTelegram(msg);

      if (bIndex < batches.length - 1) {
        console.log(`⏸️ Batch ${bIndex + 1} sent to Telegram. Pausing 3s before starting next batch...`);
        await sleep(3000);
      }
    }

  } catch(err) {
    console.error('Fatal error:', err);
    await sendTelegram(`❌ Galaxy Spectator failed: ${err.message}`);
  } finally {
    await browser.close();
  }
}

main();
