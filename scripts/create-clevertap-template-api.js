// CleverTap WhatsApp template creation via direct API (replaces Playwright create-templates.js)
// Reads Bulk Automation tab → POSTs to Karix FIRST with HEADER+IMAGE → then to CleverTap.
// Karix-first ordering ensures Meta-side template is registered with the IMAGE header before
// CleverTap's saveWhatsAppTemplate tries to forward a headerless copy.
require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const os = require('os');

const SHEET_ID = '1KF-ItkIUuvhgh64HGIQ6_HUDXMroQqCvYuz8Pk1oYUg';
const BASE = 'https://eu1.dashboard.clevertap.com/886-894-RK5Z';
// CleverTap-side provider connector (Karix REST calls below are unaffected — same WABA either way).
const PROVIDERS = { Karix_WA_promo: 1706874134, Karix_WA_promo_2: 1782730103 };
let PROVIDER_ID = PROVIDERS.Karix_WA_promo;
const RATE_LIMIT_MS = 2000;

// Karix (forwards to Meta) — needed because CleverTap stores header type 1 locally
// but does not forward a HEADER component to Karix at template time.
const KARIX_BASE = 'https://rcsgui.karix.solutions';
const KARIX_KEY = process.env.KARIX_KEY;
if (!KARIX_KEY) {
  console.error('\n❌ Missing KARIX_KEY — set it in .env (see .env.example)\n');
  process.exit(1);
}
const WABA_ID = '240863819102601';
const KARIX_HEADERS = { 'Authentication': `Bearer ${KARIX_KEY}` };
const HEADER_IMAGE_DRIVE_ID = '1YOWIj0RHsvJB_O4f51It9g2VhGAgZb2B';

function authError(reason) {
  console.error('\n❌ AUTH ERROR — ' + reason);
  console.error('   Fix: cd ~/Desktop/Engineering/clevertap-playwright && node scripts/save-auth.js');
  console.error('   Then re-run this script.\n');
  process.exit(1);
}

function loadCleverTapAuth() {
  if (!fs.existsSync('auth.json')) authError('auth.json file missing');
  const auth = JSON.parse(fs.readFileSync('auth.json'));
  const ctCookies = auth.cookies.filter(c => c.domain.includes('clevertap.com'));
  if (!ctCookies.length) authError('no CleverTap cookies in auth.json');
  const cookieHeader = ctCookies.map(c => `${c.name}=${c.value}`).join('; ');
  const csrf = auth.cookies.find(c => c.name === 'csrf')?.value;
  if (!csrf) authError('CSRF cookie missing in auth.json');
  return { cookieHeader, csrf };
}

function detectAuthFailure(status, body) {
  if (status === 401 || status === 403) return `HTTP ${status} (session expired)`;
  if (typeof body === 'string' && (body.includes('refreshPage') || body.toLowerCase().includes('<!doctype html'))) {
    return 'CleverTap returned refreshPage() — session expired';
  }
  return null;
}

function getSheetsAuth() {
  const tokenFile = `${os.homedir()}/.google_workspace_mcp/credentials/b.swaroop@lenskart.com.json`;
  const { client_id, client_secret, refresh_token, token, expiry } = JSON.parse(fs.readFileSync(tokenFile));
  const client = new OAuth2Client(client_id, client_secret);
  client.setCredentials({ access_token: token, refresh_token, expiry_date: new Date(expiry).getTime() });
  return client;
}

async function ctPost(path, body) {
  const { cookieHeader, csrf } = loadCleverTapAuth();
  const url = `${BASE}${path}?uc=1&requestTs=${Date.now()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Origin': 'https://eu1.dashboard.clevertap.com',
      'Referer': `${BASE}/account-setup/campaigns-journeys/channels/whatsapp/providers/${PROVIDER_ID}/new-template`,
      'X-CleverTap-CSRF-Token': csrf,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Cookie': cookieHeader,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const fail = detectAuthFailure(res.status, text);
  if (fail) authError(fail);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

async function fetchDriveImage(oauth) {
  const tok = (await oauth.getAccessToken()).token;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${HEADER_IMAGE_DRIVE_ID}?alt=media`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!r.ok) throw new Error(`Drive download failed ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function karixUploadMedia(imgBuf) {
  const boundary = '----KarixCT' + Math.random().toString(36).slice(2);
  const fileName = 'header.jpg';
  const fileType = 'image/jpeg';
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n${fileType}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`,
  ].join('\r\n');
  const body = Buffer.concat([Buffer.from(parts), imgBuf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await fetch(`${KARIX_BASE}/api/v1.0/template/${WABA_ID}/media`, {
    method: 'POST',
    headers: { ...KARIX_HEADERS, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Karix media upload ${r.status}: ${JSON.stringify(j)}`);
  const handle = j?.response?.fileHandle;
  if (!handle) throw new Error(`No fileHandle: ${JSON.stringify(j)}`);
  return handle;
}

async function karixCreateTemplate(row, fileHandle) {
  const body = row.get('body') || '';
  const varNums = (body.match(/\{\{(\d+)\}\}/g) || []).map(v => parseInt(v.replace(/[{}]/g, ''), 10));
  const maxVar = varNums.length ? Math.max(...varNums) : 0;
  const bodyComp = { type: 'BODY', text: body };
  if (maxVar > 0) bodyComp.example = { body_text: [Array(maxVar).fill('sample')] };

  const buttons = [];
  if (row.get('button1_text')) buttons.push({ type: 'URL', text: row.get('button1_text'), url: row.get('button1_url') || 'https://1kx.in/{{1}}' });
  if (row.get('button2_text')) buttons.push({ type: 'URL', text: row.get('button2_text'), url: row.get('button2_url') || 'https://1kx.in/{{1}}' });

  const headerOpt = (row.get('header_option') || 'IMAGE').toString().trim().toUpperCase();
  // Header per row: IMAGE (default) uses the batch image handle; NONE omits the header.
  // TEXT/VIDEO/DOCUMENT are not wired yet (need a header_text / per-row media source) — they fall back to IMAGE.
  const components = [
    ...(headerOpt === 'NONE' ? [] : [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: [fileHandle] } }]),
    bodyComp,
    ...(row.get('footer') ? [{ type: 'FOOTER', text: row.get('footer') }] : []),
    ...(buttons.length ? [{
      type: 'BUTTONS',
      buttons: buttons.map(b => b.url && b.url.includes('{{') ? { ...b, example: ['https://1kx.in/sample'] } : b),
    }] : []),
  ];

  const payload = {
    template_name: row.get('template_name'),
    language: row.get('language') || 'en',
    category: (row.get('category') || 'MARKETING').toString().trim().toUpperCase(),
    components,
    ttl: { days: parseInt(row.get('ttl_days')) || 30, hours: 0 },
  };

  const r = await fetch(`${KARIX_BASE}/api/v1.0/template/${WABA_ID}`, {
    method: 'POST',
    headers: { ...KARIX_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Karix create ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.templateId || j?.data?.templateId || j?.response?.templateId;
}

function buildPayload(row) {
  const headerOpt = (row.get('header_option') || 'IMAGE').toString().trim().toUpperCase();
  const payload = {
    provider_id: PROVIDER_ID,
    type: 'basic', // template_type column captured in sheet; Carousel/LTO mapping pending (guarded in main loop)
    _id: row.get('template_name'),
    body: { type: 0, text: row.get('body') || '' },
    locale: row.get('language') || 'en',
  };
  // Header: IMAGE (default) => type 1; NONE => omit header. Other values fall back to image.
  if (headerOpt !== 'NONE') payload.header = { type: 1 }; // 1 = Image (CleverTap pulls default from provider)

  const footer = row.get('footer');
  if (footer) payload.footer = { type: 0, text: footer };

  const buttons = [];
  const b1 = row.get('button1_text');
  if (b1) {
    buttons.push({
      text: b1,
      button_type: 'call_to_action',
      action_type: 'visit_website',
      action: { url_type: 'dynamic', url: row.get('button1_url') || 'https://1kx.in/{{1}}' },
    });
  }
  const b2 = row.get('button2_text');
  if (b2) {
    buttons.push({
      text: b2,
      button_type: 'call_to_action',
      action_type: 'visit_website',
      action: { url_type: 'dynamic', url: row.get('button2_url') || 'https://1kx.in/{{1}}' },
    });
  }
  if (buttons.length) payload.buttons = buttons;

  return payload;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function promptProvider() {
  return new Promise(resolve => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Which CleverTap provider? [1] Karix_WA_promo (default)  [2] Karix_WA_promo_2: ', answer => {
      rl.close();
      resolve(answer.trim() === '2' ? 'Karix_WA_promo_2' : 'Karix_WA_promo');
    });
  });
}

(async () => {
  const providerName = await promptProvider();
  PROVIDER_ID = PROVIDERS[providerName];
  console.log(`Using provider: ${providerName} (provider_id ${PROVIDER_ID})\n`);

  const oauth = getSheetsAuth();
  const doc = new GoogleSpreadsheet(SHEET_ID, oauth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Bulk Automation'];
  const rows = await sheet.getRows();
  const pending = rows.filter(r => {
    if (!r.get('template_name')) return false;
    const ct = String(r.get('clevertap_status') || '');
    if (ct.startsWith('DONE')) return false;
    return true;
  });

  if (!pending.length) { console.log('No pending templates.'); return; }
  console.log(`Found ${pending.length} pending template(s).\n`);

  // Generate ONE Karix file handle for the whole batch (handle valid ~7 days)
  let fileHandle = null;
  const needsKarix = pending.some(r => !r.get('template_id'));
  if (needsKarix) {
    try {
      process.stdout.write('Generating Karix image handle... ');
      const imgBuf = await fetchDriveImage(oauth);
      fileHandle = await karixUploadMedia(imgBuf);
      console.log('OK');
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      console.log('Karix submissions will be skipped this run.');
    }
  }

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const name = row.get('template_name');
    process.stdout.write(`[${i + 1}/${pending.length}] ${name} ... `);

    // template_type guard: only "Default" (or blank) is supported by this sheet's columns.
    // Carousel / Limited Time Offer are structurally different Meta templates (need card/offer fields) — skip cleanly.
    const tType = (row.get('template_type') || 'Default').toString().trim().toLowerCase();
    if (tType !== 'default') {
      console.log(`SKIP — template_type "${row.get('template_type')}" not supported yet (needs Carousel/LTO fields)`);
      row.set('rejection_reason', `template_type ${row.get('template_type')} not supported (needs carousel/LTO fields)`);
      await row.save();
      if (i < pending.length - 1) await sleep(RATE_LIMIT_MS);
      continue;
    }

    // 1) Karix FIRST with HEADER+IMAGE (skip if already has template_id)
    if (!row.get('template_id')) {
      if (!fileHandle) {
        process.stdout.write('Karix=SKIP(no_handle) ');
      } else {
        try {
          const karixId = await karixCreateTemplate(row, fileHandle);
          if (karixId) {
            process.stdout.write(`Karix=${karixId} `);
            row.set('template_id', karixId);
            row.set('status', 'submitted');
            row.set('rejection_reason', '');
          } else {
            process.stdout.write('Karix=NO_ID ');
            row.set('rejection_reason', 'Karix returned no templateId');
          }
        } catch (e) {
          const msg = String(e.message);
          if (msg.includes('1003') || msg.toLowerCase().includes('already exist')) {
            process.stdout.write('Karix=REUSED ');
            row.set('status', 'submitted');
            row.set('rejection_reason', 'already submitted (reused)');
            row.set('clevertap_status', 'DONE (reused)');
            await row.save();
            console.log('');
            if (i < pending.length - 1) await sleep(RATE_LIMIT_MS);
            continue;
          }
          console.log(`Karix ERROR — ${msg.slice(0, 200)}`);
          row.set('rejection_reason', msg.slice(0, 200));
          await row.save();
          if (i < pending.length - 1) await sleep(RATE_LIMIT_MS);
          continue;
        }
      }
    } else {
      process.stdout.write(`Karix=${row.get('template_id')}(skip) `);
    }

    // 2) CleverTap saveWhatsAppTemplate (skip if already DONE)
    if (row.get('clevertap_status') !== 'DONE') {
      try {
        const payload = buildPayload(row);
        const { status, body } = await ctPost('/json/account/whatsApp/templates/saveWhatsAppTemplate', payload);

        const ok = status === 200 && body?.Web?.success === true;
        if (ok) {
          console.log('CT=DONE');
          row.set('clevertap_status', 'DONE');
        } else {
          const fullDump = JSON.stringify(body).slice(0, 300);
          const reason = body?.Web?.reason || body?.error || fullDump;
          // Karix already has the template (we created it with HEADER+IMAGE in step 1).
          // CT will pick it up on its next auto-sync from Karix.
          console.log(`CT ERROR — ${reason}`);
          row.set('clevertap_status', `ERROR: ${reason}`.slice(0, 200));
        }
      } catch (e) {
        console.log(`CT ERROR — ${e.message}`);
        row.set('clevertap_status', `ERROR: ${e.message}`.slice(0, 200));
      }
    } else {
      console.log('CT=DONE(skip)');
    }

    await row.save();
    if (i < pending.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log('\nFinished.');
})();
