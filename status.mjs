// AERA server status → Discord. Runs every 5 minutes on GitHub Actions, so it keeps working when Railway is down.
// Keeps ONE status message in the channel up to date and sends a DM when something goes down or comes back.
// Secrets/variables (GitHub → Settings → Secrets and variables → Actions):
//   DISCORD_BOT_TOKEN (secret)  STATUS_CHANNEL_ID (variable)  ALERT_USER_ID (variable)
const TOKEN = process.env.DISCORD_BOT_TOKEN, CH = process.env.STATUS_CHANNEL_ID, ALERT = process.env.ALERT_USER_ID;
const API = process.env.DISCORD_API || 'https://discord.com/api/v10';
const TARGETS = [
  { id: 'web', name: 'Website (dev-dsue.de)', url: process.env.WEB_URL || 'https://www.dev-dsue.de/' },
  { id: 'aera', name: 'AERA Online (Login, Ranked, Multiplayer)', url: process.env.AERA_URL || 'https://www.dev-dsue.de/api/aera/status', json: true },
];
if (!TOKEN || !CH) { console.error('DISCORD_BOT_TOKEN or STATUS_CHANNEL_ID missing'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function probe(t) {
  const t0 = Date.now();
  try {
    const r = await fetch(t.url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'aera-status' } });
    const ms = Date.now() - t0;
    if (!r.ok) return { up: false, why: 'HTTP ' + r.status, ms };
    if (t.json) { try { await r.json(); } catch { return { up: false, why: 'keine gültige Antwort', ms }; } }
    return { up: true, ms };
  } catch (e) { return { up: false, why: e.name === 'TimeoutError' ? 'keine Antwort (15 s)' : 'nicht erreichbar', ms: Date.now() - t0 }; }
}
// down only if it fails twice, 20 s apart (no alarm for a single hiccup)
async function check(t) { const a = await probe(t); if (a.up) return a; await sleep(20000); return probe(t); }

async function dc(method, path, body) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(API + path, { method, headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep((j.retry_after || 1) * 1000 + 200); continue; }
    if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return r.status === 204 ? null : r.json();
  }
  throw new Error('Discord rate limit');
}
const fmt = ms => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dur = ms => { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };

const me = await dc('GET', '/users/@me');
const msgs = await dc('GET', `/channels/${CH}/messages?limit=50`);
const mine = msgs.find(m => m.author && m.author.id === me.id && m.embeds && m.embeds[0] && /^AERA Serverstatus/.test(m.embeds[0].title || ''));
let prev = {};
// the last state rides along in the title link (#s=…), invisible in Discord
try { const u = mine && mine.embeds[0].url; const m = u && u.match(/#s=([A-Za-z0-9_-]+)$/); if (m) prev = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { prev = {}; }

const now = Date.now(), state = {}, changes = [];
const res = await Promise.all(TARGETS.map(check));
TARGETS.forEach((t, i) => {
  const r = res[i], p = prev[t.id];
  const since = p && p.up === r.up ? p.since : now;
  state[t.id] = { up: r.up, since };
  if (p && p.up !== r.up) changes.push({ t, r, was: now - p.since });
});
const allUp = res.every(r => r.up);
const embed = {
  title: 'AERA Serverstatus',
  url: 'https://www.dev-dsue.de/#s=' + Buffer.from(JSON.stringify(state)).toString('base64url'),
  color: allUp ? 0x3ecf8e : 0xff5d5d,
  description: allUp ? '🟢 Alles läuft.' : '🔴 Es gibt eine Störung.',
  fields: TARGETS.map((t, i) => ({ name: t.name, value: res[i].up ? `🟢 online · ${res[i].ms} ms · seit ${fmt(state[t.id].since)}` : `🔴 **offline** (${res[i].why}) · seit ${fmt(state[t.id].since)}` })),
  footer: { text: 'Zuletzt geprüft ' + fmt(now) + ' · alle 5 Minuten' },
};
if (mine) await dc('PATCH', `/channels/${CH}/messages/${mine.id}`, { embeds: [embed] });
else await dc('POST', `/channels/${CH}/messages`, { embeds: [embed] });

if (changes.length && ALERT) {
  const dm = await dc('POST', '/users/@me/channels', { recipient_id: ALERT });
  const lines = changes.map(c => c.r.up ? `🟢 **${c.t.name}** ist wieder online (war ${dur(c.was)} weg).` : `🔴 **${c.t.name}** ist offline: ${c.r.why}.`);
  await dc('POST', `/channels/${dm.id}/messages`, { content: lines.join('\n') + (changes.some(c => !c.r.up) ? '\nTipp: bei Railway nach Abrechnung/Deploy schauen.' : '') });
}
console.log(TARGETS.map((t, i) => t.id + ':' + (res[i].up ? 'up' : 'down ' + res[i].why)).join('  '), changes.length ? '→ DM' : '');
