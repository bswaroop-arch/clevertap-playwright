// Bulk upload images from a folder to CleverTap's CDN.
// Outputs filename -> public URL to console and to "Header URLs" sheet tab.
// Usage: node scripts/upload-headers.js [folder]
//        default folder: ~/Desktop/wa-headers/
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHEET_ID = '1KF-ItkIUuvhgh64HGIQ6_HUDXMroQqCvYuz8Pk1oYUg';
const TAB_NAME = 'Header URLs';
const BASE = 'https://eu1.dashboard.clevertap.com/886-894-RK5Z';
const FOLDER = process.argv[2] || path.join(os.homedir(), 'Desktop', 'wa-headers');
const RATE_LIMIT_MS = 800;

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

function getSheetsAuth() {
  const tokenFile = `${os.homedir()}/.google_workspace_mcp/credentials/b.swaroop@lenskart.com.json`;
  const { client_id, client_secret, refresh_token, token, expiry } = JSON.parse(fs.readFileSync(tokenFile));
  const client = new OAuth2Client(client_id, client_secret);
  client.setCredentials({ access_token: token, refresh_token, expiry_date: new Date(expiry).getTime() });
  return client;
}

function mimeFor(ext) {
  return ({
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  })[ext.toLowerCase()] || 'image/jpeg';
}

async function ctInitUpload(contentType) {
  const { cookieHeader, csrf } = loadCleverTapAuth();
  const url = `${BASE}/json/cdn/campaigns/image?uc=1&requestTs=${Date.now()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://eu1.dashboard.clevertap.com',
      'Referer': `${BASE}/campaigns/campaign/new/whatsapp`,
      'X-CleverTap-CSRF-Token': csrf,
      'Cookie': cookieHeader,
    },
    body: JSON.stringify({ content_type: contentType, processToStreamable: true }),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || text.includes('refreshPage')) {
    authError(res.status === 401 || res.status === 403 ? `HTTP ${res.status} (session expired)` : 'CleverTap returned refreshPage() — session expired');
  }
  if (!res.ok) {
    throw new Error(`CT init failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  if (!data.signedUrl || !data.image?.url) {
    throw new Error(`CT init missing fields: ${text.slice(0, 200)}`);
  }
  return { signedUrl: data.signedUrl, cdnUrl: data.image.url };
}

async function s3PutImage(signedUrl, buf, contentType) {
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buf,
  });
  if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function uploadOne(filePath, fileName) {
  const ext = path.extname(fileName);
  const contentType = mimeFor(ext);
  const { signedUrl, cdnUrl } = await ctInitUpload(contentType);
  const buf = fs.readFileSync(filePath);
  await s3PutImage(signedUrl, buf, contentType);
  return cdnUrl;
}

async function writeToSheet(rows) {
  const doc = new GoogleSpreadsheet(SHEET_ID, getSheetsAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[TAB_NAME];
  if (!sheet) {
    sheet = await doc.addSheet({ title: TAB_NAME, headerValues: ['filename', 'url', 'uploaded_at'] });
  } else {
    await sheet.loadHeaderRow();
    if (!sheet.headerValues.length) await sheet.setHeaderRow(['filename', 'url', 'uploaded_at']);
  }
  const now = new Date().toISOString();
  for (const r of rows) {
    await sheet.addRow({ filename: r.file, url: r.url || '', uploaded_at: r.url ? now : '' });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(FOLDER)) {
    console.error(`Folder not found: ${FOLDER}`);
    console.error('Create it and put images inside, or pass a different path.');
    process.exit(1);
  }
  const files = fs.readdirSync(FOLDER).filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f));
  if (!files.length) {
    console.log('No images found in', FOLDER);
    return;
  }
  console.log(`Uploading ${files.length} image(s) from ${FOLDER}\n`);

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    process.stdout.write(`[${i + 1}/${files.length}] ${f} ... `);
    try {
      const url = await uploadOne(path.join(FOLDER, f), f);
      console.log(url);
      results.push({ file: f, url });
    } catch (e) {
      console.log(`ERROR — ${e.message}`);
      results.push({ file: f, url: '', error: e.message });
    }
    if (i < files.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log('\n=== Writing to sheet ===');
  try {
    await writeToSheet(results);
    console.log(`Wrote ${results.length} rows to "${TAB_NAME}" tab.`);
  } catch (e) {
    console.log(`Sheet write failed: ${e.message}`);
    console.log('URLs above are still valid — copy from terminal output.');
  }
})();
