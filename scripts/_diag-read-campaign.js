// READ-ONLY diagnostic: fetch stored config for a campaign via internal API
const fs = require('fs');
const BASE = 'https://eu1.dashboard.clevertap.com/886-894-RK5Z';
const ID = process.argv[2] || '1782816044';

function auth() {
  const a = JSON.parse(fs.readFileSync('auth.json'));
  const ck = a.cookies.filter(c => c.domain.includes('clevertap.com'))
    .map(c => `${c.name}=${c.value}`).join('; ');
  const csrf = a.cookies.find(c => c.name === 'csrf')?.value;
  return { ck, csrf };
}
async function get(path) {
  const { ck, csrf } = auth();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}uc=1&requestTs=${Date.now()}`;
  const r = await fetch(url, { headers: {
    'Accept': 'application/json, text/plain, */*',
    'X-CleverTap-CSRF-Token': csrf,
    'Origin': 'https://eu1.dashboard.clevertap.com',
    'Referer': `${BASE}/campaigns/campaign/${ID}/edit`,
    'Cookie': ck,
  }});
  const t = await r.text();
  return { status: r.status, body: t.slice(0, 60) };
}
(async () => {
  const candidates = [
    `/json/notification/whatsApp/get?id=${ID}`,
    `/json/notification/get?id=${ID}`,
    `/json/notification/whatsApp/load?id=${ID}`,
    `/json/targets/get?id=${ID}`,
    `/json/notification/whatsApp/save?edit=true&id=${ID}`,
  ];
  for (const p of candidates) {
    try {
      const { status, body } = await get(p);
      const ok = status === 200 && body.trim().startsWith('{');
      console.log(`${ok ? '✅' : '  '} [${status}] ${p}\n      ${body}`);
      if (ok) {
        // refetch full and dump key content fields
        const { ck, csrf } = auth();
        const sep = p.includes('?') ? '&' : '?';
        const r = await fetch(`${BASE}${p}${sep}uc=1&requestTs=${Date.now()}`, { headers: {
          'Accept':'application/json','X-CleverTap-CSRF-Token':csrf,
          'Origin':'https://eu1.dashboard.clevertap.com','Referer':`${BASE}/campaigns/campaign/${ID}/edit`,'Cookie':ck }});
        const j = await r.json();
        const msg = j?.qm?.msg || j?.msg || j?.notification?.qm?.msg;
        console.log('\n--- stored msg ---');
        console.log(JSON.stringify(msg, null, 2).slice(0, 2500));
        return;
      }
    } catch (e) { console.log(`  [ERR] ${p} ${e.message}`); }
  }
})();
