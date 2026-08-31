// Sheet-driven CleverTap WhatsApp campaign creation via internal API
// Reads Campaigns tab → fetches template → builds payload → posts → marks DONE
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const os = require('os');

const SHEET_ID = '1KF-ItkIUuvhgh64HGIQ6_HUDXMroQqCvYuz8Pk1oYUg';
const BASE = 'https://eu1.dashboard.clevertap.com/886-894-RK5Z';
const PROVIDERS = { Karix_WA_promo: 1706874134, Karix_WA_promo_2: 1782730103 };
let PROVIDER_ID = PROVIDERS.Karix_WA_promo; // Karix
const RATE_LIMIT_MS = 6000;

// ---------- Auth ----------
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

// ---------- CleverTap API helpers ----------
async function ctFetch(path, options = {}) {
  const { cookieHeader, csrf } = loadCleverTapAuth();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}uc=1&requestTs=${Date.now()}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Origin': 'https://eu1.dashboard.clevertap.com',
      'Referer': `${BASE}/campaigns/campaign/new/whatsapp`,
      'X-CleverTap-CSRF-Token': csrf,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Cookie': cookieHeader,
      ...(options.headers || {}),
    },
  });
}

async function fetchTemplates() {
  const res = await ctFetch(`/json/account/whatsApp/templates/getWhatsAppTemplates&_id=${PROVIDER_ID}&isNewFormat=true`);
  const text = await res.text();
  const fail = detectAuthFailure(res.status, text);
  if (fail) authError(fail);
  const data = JSON.parse(text);
  return data.templates || [];
}

async function fetchTags() {
  const res = await ctFetch('/json/tags/getAllTags');
  const text = await res.text();
  const fail = detectAuthFailure(res.status, text);
  if (fail) authError(fail);
  return JSON.parse(text); // [{_id, name}]
}

// segmentsById: Map<segmentId, seg> where seg.sa is the internal alias number
// the query engine actually evaluates against (distinct from the public _id).
async function fetchSegments() {
  const res = await ctFetch('/json/genericTargetData/getSegmentsForTargetingType?targetingType=whatsApp');
  const text = await res.text();
  const fail = detectAuthFailure(res.status, text);
  if (fail) authError(fail);
  const data = JSON.parse(text);
  const all = [...(data.ctApiSegments || []), ...(data.pbsSegments || [])];
  return new Map(all.map(seg => [seg._id, seg]));
}

function findTagId(tags, label) {
  if (!label) return null;
  const t = tags.find(x => x.name.toLowerCase() === label.toLowerCase());
  return t ? t._id : null;
}

// ---------- Validation (Phase 1) ----------
// Liquid-aware space check: strip {{ ... }} tags first (UTMs legitimately use
// spaces inside {{ Campaign.campaignId | default: "0_0" }}), then flag spaces.
function hasBadSpace(url) {
  if (!url) return false;
  return /\s/.test(String(url).replace(/\{\{.*?\}\}/g, ''));
}

function validateRow(row, templates, tags) {
  const errors = [];
  const warnings = [];
  const tName = row.get('Template Name');
  const tmpl = templates.find(t => t._id === tName);

  if (!tmpl) {
    errors.push(`template '${tName}' not found in provider ${PROVIDER_ID}`);
    return { errors, warnings, template: null };
  }

  // Template approval status
  const tStatus = (tmpl.status || tmpl.approval_status || '').toUpperCase();
  if (tStatus && tStatus !== 'APPROVED' && tStatus !== 'ENABLED') {
    errors.push(`template '${tName}' is ${tStatus}, not APPROVED`);
  }

  const fmt = tmpl.format || {};
  const bodyText = fmt.body?.text || '';
  const varNums = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map(m => parseInt(m[1]));

  // Var count: body needs N vars, Var 1..N must be filled
  const maxVar = varNums.length ? Math.max(...varNums) : 0;
  const filledVars = ['Var 1', 'Var 2', 'Var 3', 'Var 4']
    .map(k => row.get(k))
    .filter(v => v !== undefined && v !== null && v !== '');
  if (filledVars.length < maxVar) {
    errors.push(`needs ${maxVar} var(s), got ${filledVars.length} — fill Var 1..${maxVar}`);
  }

  // Body repeats the same {{N}} placeholder
  if (varNums.length !== new Set(varNums).size) {
    const placeholders = (bodyText.match(/\{\{\d+\}\}/g) || []).join(' ');
    errors.push(`body repeats a placeholder (${placeholders}) — each {{N}} may appear once`);
  }

  // Header image mandatory
  if (fmt.header && fmt.header.type === 1 && !row.get('Header URL')) {
    errors.push('template has image header but Header URL (col R) is blank');
  }

  // Deep URLs — no spaces (outside Liquid)
  const deepUrls = [row.get('Deep URL 1'), row.get('Deep URL 2')];
  deepUrls.forEach((u, i) => {
    if (hasBadSpace(u)) errors.push(`Deep URL ${i + 1} has a space outside {{ }} Liquid`);
  });

  // Dynamic button URLs need a Deep URL
  const dynBtns = (fmt.buttons || []).filter(b => b.action?.url_type === 'dynamic');
  for (let bi = 0; bi < dynBtns.length; bi++) {
    if (!deepUrls[bi]) errors.push(`button ${bi + 1} is dynamic — fill Deep URL ${bi + 1}`);
  }

  // Label — warn only (filled but doesn't resolve to a tag)
  const labelName = row.get('Label');
  if (labelName && !findTagId(tags, labelName)) {
    warnings.push(`label "${labelName}" not found — will send without a tag`);
  }

  return { errors, warnings, template: tmpl };
}

// ---------- Payload builders ----------
const HEADER_TYPE_MAP = { 0: 'Text', 1: 'Image', 2: 'Video', 3: 'Document' };

function todayYYYYMMDD() {
  const d = new Date();
  return parseInt(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

function parseScheduleDateTime(date, time) {
  // Returns YYYYMMDDHHMM as integer. Defaults to 30 days from now if not provided.
  let d;
  if (date) {
    d = new Date(date);
    if (time) {
      const m = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (m) {
        let h = parseInt(m[1]);
        const min = parseInt(m[2]);
        const ampm = (m[3] || '').toUpperCase();
        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        d.setHours(h, min, 0, 0);
      }
    }
  } else {
    d = new Date();
    d.setDate(d.getDate() + 30);
  }
  const pad = n => String(n).padStart(2, '0');
  return parseInt(`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`);
}

function buildWhoQuery(segmentId, segmentsById) {
  const today = todayYYYYMMDD();
  const seg = segmentsById.get(parseInt(segmentId));
  if (!seg) throw new Error(`segment ${segmentId} not found in getSegmentsForTargetingType — cannot resolve its "sa" value`);
  return {
    f: today,
    t: today,
    u: 1,
    ev: -1,
    wc: {
      arr: [{
        sx: {
          o: 15,
          v: [seg.sa],
          meta_for_ui: { segIds: [parseInt(segmentId)] }
        }
      }],
      and: false
    },
    p: []
  };
}

function buildMsg(template, row) {
  const fmt = template.format;
  const msg = {
    _id: template._id,
    templateId: template._id,
    content_api_namespaces: [],
    locale: template.locale || 'en',
    customProps: [],
  };

  // Header — text passes through; image uses Header URL column if filled
  if (fmt.header) {
    if (fmt.header.type === 0 && fmt.header.text) {
      msg.header = { type: 'Text', text: fmt.header.text };
    } else if (fmt.header.type === 1) {
      const url = row.get('Header URL');
      if (url) {
        msg.header = {
          type: 'Image',
          media: {
            url,
            content_type: 'image/jpeg',
            key: '',
            processing: false,
            fileName: '',
          },
        };
      }
    }
  }

  // Body
  if (fmt.body) {
    const vars = ['Var 1', 'Var 2', 'Var 3', 'Var 4']
      .map(k => row.get(k))
      .filter(v => v !== undefined && v !== null && v !== '');
    msg.body = {
      type: 'Text',
      text: fmt.body.text || '',
      replacements: vars,
    };
  }

  // Footer
  if (fmt.footer && fmt.footer.text) {
    msg.footer = { type: 'Text', text: fmt.footer.text };
  }

  // Buttons — fill replacements from Deep URL 1 / Deep URL 2
  if (fmt.buttons && fmt.buttons.length) {
    const deepUrls = [row.get('Deep URL 1'), row.get('Deep URL 2')];
    msg.buttons = fmt.buttons.map((btn, i) => {
      const out = {
        text: btn.text,
        button_type: btn.button_type || 'call_to_action',
        action_type: btn.action_type || 'visit_website',
        action: { ...btn.action },
      };
      const dynamic = btn.action?.url_type === 'dynamic';
      const val = deepUrls[i];
      if (dynamic && val) out.replacements = [val];
      else out.replacements = [];
      return out;
    });
  }

  return msg;
}

function buildPayload(template, row, tags, segmentsById) {
  const segmentId = row.get('Segment ID');
  if (!segmentId) throw new Error('Segment ID missing');
  const whoQuery = buildWhoQuery(segmentId, segmentsById);
  const msg = buildMsg(template, row);
  const startDT = parseScheduleDateTime(row.get('Schedule Date'), row.get('Schedule Time'));
  const lmt = parseInt(row.get('Max Users')) || 100000;
  const convDays = parseInt(row.get('Conversion Days')) || 3;

  const labelName = row.get('Label');
  const tagId = findTagId(tags, labelName);
  if (labelName && !tagId) console.warn(`  (warn: label "${labelName}" not found — skipping)`);

  return {
    tagIdList: tagId ? [tagId] : [],
    name: row.get('Campaign Name'),
    convGoal: {
      rp: 0,
      ct: String(convDays * 24 * 60),
      cq: { ev: 5, s: [], e: [], i: [], ed: {}, tags: {}, qm_dt: {}, c: {} },
      displayValue: convDays,
      displayUnit: 'Days',
    },
    channel: 'whatsapp',
    provider_id: PROVIDER_ID,
    qm: {
      whoQuery,
      segmentType: 'batch',
      segmentName: 'Custom Segment',
      segmentId: 'adhoc',
      campaignType: 'single',
      msg,
      provider_id: PROVIDER_ID,
      provider_nickname: 'generic',
      recommendationList: [],
      editorConfigured: true,
      sendInUserTz: false,
      userTzWrapAround: true,
      senderTz: null,
      startDateTime: startDT,
      endDateTime: startDT,
      neverEnd: false,
    },
    q: whoQuery,
    evq: whoQuery,
    estimated: null,
    segment_definition: `( User is present in segments with IDs ${segmentId} )`,
    dollar_same_definition: '',
    scg: (() => {
      const v = String(row.get('Apply CG') || '').trim().toLowerCase();
      return v === 'yes' || v === 'true' || v === '1';
    })(),
    lmt,
    msg,
    provider_nickname: 'generic',
    isNewFormat: true,
    isPivot: false,
    type: 10,
    tgt_status: 0,
    dnd: false,
    device: [0],
    deviceTypes: [0],
    content_api_info: {},
    selectedCatalogs: {},
    recommendationFilters: {},
    advance_settings: { throttlingSetting: { throttlingApplied: true } },
    maxPer5Mins: 500000,
    sendInUserTz: false,
    userTzWrapAround: true,
    senderTz: null,
    cfc_setting: { exclude_global: false, always: true, entryLimitsValue: null },
    target_type: 1,
    startNow: false,
    startDateTime: startDT,
    endDateTime: startDT,
    neverEnd: false,
    precompute: false,
    tr_cap: true,
    newCampaignUI: true,
    dependenciesVerified: { '0': true },
    source: 'Campaign Dashboard',
  };
}

async function saveDraft(payload) {
  const res = await ctFetch(`/json/notification/whatsApp/save?saveAsDraft=false&clone=false&edit=false&oc=false`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ---------- Main ----------
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

  const doc = new GoogleSpreadsheet(SHEET_ID, getSheetsAuth());
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Campaigns'];
  const rows = await sheet.getRows();
  const pending = rows.filter(r => r.get('Status') !== 'DONE' && r.get('Campaign Name'));

  if (!pending.length) { console.log('No pending campaigns.'); return; }
  console.log(`Found ${pending.length} pending campaign(s). Fetching templates...`);

  const [templates, tags, segmentsById] = await Promise.all([fetchTemplates(), fetchTags(), fetchSegments()]);
  console.log(`Loaded ${templates.length} templates, ${tags.length} tags, ${segmentsById.size} segments.\n`);

  // ---------- Phase 1: validate every row, no API writes ----------
  console.log('Validating...\n');
  const valid = [];
  let invalidCount = 0;
  for (const row of pending) {
    const name = row.get('Campaign Name');
    const label = `Row ${row.rowNumber}  ${name}`;
    const { errors, warnings, template } = validateRow(row, templates, tags);

    if (errors.length) {
      invalidCount++;
      console.log(`✗ ${label}`);
      errors.forEach(e => console.log(`    ${e}`));
      row.set('Status', `INVALID: ${errors.join('; ')}`.slice(0, 200));
      await row.save();
    } else {
      if (warnings.length) {
        console.log(`⚠ ${label}`);
        warnings.forEach(w => console.log(`    ${w}`));
      }
      valid.push({ row, template });
    }
  }

  console.log(`\n${valid.length}/${pending.length} OK · ${invalidCount} invalid.`);
  if (!valid.length) { console.log('Nothing to create.'); return; }

  // ---------- Phase 2: create drafts for valid rows ----------
  console.log(`\nCreating ${valid.length} draft(s)...\n`);
  for (let i = 0; i < valid.length; i++) {
    const { row, template } = valid[i];
    const name = row.get('Campaign Name');
    process.stdout.write(`[${i + 1}/${valid.length}] ${name} ... `);

    try {
      const payload = buildPayload(template, row, tags, segmentsById);
      const result = await saveDraft(payload);

      if (result.success) {
        console.log(`DONE (id ${result._id})`);
        row.set('Status', 'DONE');
        row.set('Campaign ID', String(result._id));
      } else {
        const fullDump = JSON.stringify(result).slice(0, 400);
        const reason = result.error || result.errorMessage || result.message || fullDump;
        console.log(`ERROR — ${reason}`);
        console.log(`  Full response: ${fullDump}`);
        row.set('Status', `ERROR: ${reason}`.slice(0, 200));
      }
    } catch (e) {
      console.log(`ERROR — ${e.message}`);
      row.set('Status', `ERROR: ${e.message}`.slice(0, 200));
    }
    await row.save();

    if (i < valid.length - 1) await sleep(RATE_LIMIT_MS); // CleverTap rate limit
  }

  console.log('\nFinished.');
})();
