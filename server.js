// Sales Pipeline Autopilot — Infeara Revenue OS (blueprint v1.0, "Approved for build")
// Local-first web application: capture -> score -> route -> engage -> book -> report.
// Run: npm install && npm start   (http://localhost:8080)
const express = require('express');
const crypto = require('crypto');
const { db, audit, notify, hashEmail, traceId } = require('./src/db');
const { scoreLead, routeLead, SLA_MINUTES } = require('./src/scoring');
const workflow = require('./src/workflow');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- sessions (cookie-based, in-memory; local-only deployment) ----------
const sessions = new Map();
function sessionMiddleware(req, res, next) {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  req.user = sid && sessions.has(sid) ? sessions.get(sid) : null;
  req.sid = sid;
  next();
}
app.use(sessionMiddleware);

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Login required' });
  next();
}
const ROLE_RANK = { 'Read-only': 0, 'SDR': 1, 'Delivery Lead': 1, 'Sales Rep': 2, 'Sales Manager': 3, 'Admin': 4 };
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 'UNAUTHENTICATED' });
    if (!roles.includes(req.user.role) && req.user.role !== 'Admin')
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Role lacks permission' });
    next();
  };
}
function flagOn(k) { return db.prepare('SELECT enabled FROM feature_flag WHERE key=?').get(k)?.enabled === 1; }

// ---------- HTML shell (server-rendered admin, per blueprint: no SPA) ----------
function page(title, body, user) {
  const nav = user ? `<nav>
    <a href="/app">Cockpit</a><a href="/app/leads">Leads</a><a href="/app/pipeline">Pipeline</a>
    <a href="/app/tasks">Tasks</a><a href="/app/sequences">Sequences</a><a href="/app/bookings">Bookings</a>
    <a href="/app/reports">Reports</a><a href="/app/audit">Audit</a><a href="/app/settings">Settings</a>
    <span class="who">${user.full_name} (${user.role})</span><a href="/auth/logout">Logout</a></nav>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — Sales Pipeline Autopilot</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--bg:#0b1f1c;--panel:#10312b;--ink:#e8f2ef;--mut:#8fb3aa;--acc:#2fbf8f;--line:#1e4a40}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--acc);text-decoration:none}nav{display:flex;gap:14px;align-items:center;padding:10px 18px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
nav .who{margin-left:auto;color:var(--mut)}main{padding:20px;max-width:1200px;margin:0 auto}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
input,select,textarea{background:#0a2620;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px;width:100%}
button,.btn{background:var(--acc);color:#04231a;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;display:inline-block}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
label{display:block;color:var(--mut);font-size:12px;margin:10px 0 3px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}
.pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;font-weight:600}
.tA{background:#3ddc97;color:#04231a}.tB{background:#ffd166;color:#4a3200}.tC{background:#8ecae6;color:#08304a}.tD{background:#5a6b67;color:#dfe}
.flash{background:#123c33;border:1px solid var(--acc);padding:10px;border-radius:8px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.stat b{font-size:24px;display:block}.stat span{color:var(--mut);font-size:12px}
.mut{color:var(--mut)}.small{font-size:12px}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:180px}
</style></head><body>${nav}<main>${body}</main></body></html>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN');

// ---------- auth ----------
app.get('/auth/login', (req, res) => {
  res.send(page('Login', `<div class="card" style="max-width:380px;margin:60px auto">
    <h1>Sales Pipeline Autopilot</h1><p class="mut">Infeara Revenue OS · local-first</p>
    <form method="post" action="/auth/login">
      <label>Email</label><input name="email" required placeholder="rep1@infeara.local">
      <label>Password</label><input name="password" type="password" required placeholder="ChangeMe#2026">
      <div style="margin-top:14px"><button>Sign in</button></div></form>
    <p class="small mut">Seed users: admin@ / founder@ / sales.manager@ / rep1@ / rep2@ / sdr@ / delivery@ / viewer@ — all "infeara.local", password <code>ChangeMe#2026</code>. MFA enforced for Admin/Manager roles in prod.</p></div>`));
});
app.post('/auth/login', (req, res) => {
  const u = db.prepare('SELECT * FROM app_user WHERE email=? AND active=1').get(String(req.body.email || '').toLowerCase());
  const hash = crypto.createHash('sha256').update('autopilot:' + String(req.body.password || '')).digest('hex');
  if (!u || u.password_hash !== hash) { audit('anonymous', 'LOGIN_FAILED', 'app_user', u?.id, null); return res.status(401).send(page('Login', '<div class="card">Invalid credentials. <a href="/auth/login">Try again</a></div>')); }
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { id: u.id, email: u.email, full_name: u.full_name, role: u.role });
  audit(u.email, 'LOGIN', 'app_user', u.id, null);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
  res.redirect('/app');
});
app.get('/auth/logout', (req, res) => { if (req.sid) sessions.delete(req.sid); res.redirect('/auth/login'); });

// ---------- public: landing + capture form ----------
app.get('/', (req, res) => {
  const services = ['VAPT', 'Managed IT', 'Cloud', 'Network', 'Automation', 'ODC'];
  res.send(page('Book a conversation', `
    <div class="card" style="max-width:560px;margin:40px auto">
      <h1>Talk to Infeara about security, managed IT, cloud or automation</h1>
      <p class="mut">Chennai · remote-first · 24/7 support · 99.9% uptime SLA. Every enquiry is answered within 60 seconds.</p>
      <form method="post" action="/api/v1/public/leads">
        <input type="text" name="company_website" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off">
        <div class="row"><div><label>Full name *</label><input name="full_name" required></div>
        <div><label>Business email *</label><input name="email" type="email" required></div></div>
        <div class="row"><div><label>Phone</label><input name="phone"></div>
        <div><label>Company *</label><input name="company" required></div></div>
        <div class="row"><div><label>Service interest *</label><select name="service">${services.map(s => `<option>${s}</option>`).join('')}</select></div>
        <div><label>Team size</label><select name="team_size"><option>1-50</option><option>50-200</option><option>200-500</option><option>500+</option></select></div></div>
        <label>What prompted you to reach out?</label><textarea name="message" rows="3"></textarea>
        <label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="consent" value="true" required style="width:auto"> I agree to be contacted about my enquiry (DPDP Act 2023 notice v1.0). *</label>
        <div style="margin-top:14px"><button>Request a call</button></div>
      </form></div>`, null));
});

// ---------- public API: capture (slide 21-22) ----------
app.post('/api/v1/public/leads', (req, res) => {
  const b = req.body, trace = traceId();
  db.prepare('INSERT INTO capture_request (payload, validation, trace_id) VALUES (?,?,?)')
    .run(JSON.stringify({ ...b, consent: !!b.consent }), 'RECEIVED', trace);
  // Validation: strict allow-list, honeypot, consent mandatory
  if (b.company_website) return res.status(400).json({ code: 'SPAM', message: 'Rejected' });
  if (!b.full_name || !b.email || !b.company || !b.service)
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'full_name, email, company and service are required' });
  if (!b.consent) return res.status(422).json({ code: 'CONSENT_REQUIRED', message: 'Explicit consent is required (DPDP Act 2023)' });
  const email = String(b.email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid business email' });
  const eh = hashEmail(email);
  if (db.prepare('SELECT id FROM suppression WHERE email_hash=?').get(eh))
    return res.status(410).json({ code: 'UNSUBSCRIBED', message: 'This address has opted out' });

  const domain = email.split('@')[1];
  // De-duplication: exact email match merges into the existing lead
  let contact = db.prepare('SELECT * FROM contact WHERE email_hash=?').get(eh);
  const tx = db.transaction(() => {
    let company = db.prepare('SELECT * FROM company WHERE domain=?').get(domain);
    if (!company) company = db.prepare('INSERT INTO company (name, domain, city) VALUES (?,?,?)')
      .run(b.company, domain, 'Chennai').lastInsertRowid && db.prepare('SELECT * FROM company WHERE domain=?').get(domain);
    if (!contact) {
      const c = db.prepare('INSERT INTO contact (company_id, full_name, email_hash, phone_hash) VALUES (?,?,?,?)')
        .run(company.id, b.full_name, eh, b.phone ? hashEmail(b.phone) : null);
      contact = db.prepare('SELECT * FROM contact WHERE id=?').get(c.lastInsertRowid);
      db.prepare(`INSERT INTO consent_record (contact_id, purpose, notice_text, policy_version, lawful_basis, source, ip, user_agent)
                  VALUES (?,?,?,?,?,?,?,?)`)
        .run(contact.id, 'marketing_email', 'DPDP Act 2023 notice v1.0 — contact about my enquiry', 'v1.0', 'explicit_consent', 'website_form', req.ip, req.headers['user-agent'] || '');
    }
    const existing = db.prepare('SELECT * FROM lead WHERE contact_id=?').get(contact.id);
    if (existing) {
      db.prepare('INSERT INTO lead_source_touch (lead_id, source, landing_page) VALUES (?,?,?)').run(existing.id, 'website', '/');
      audit('system', 'LEAD_MERGED', 'lead', existing.id, null);
      return { merged: true, leadId: existing.id, contactId: contact.id };
    }
    // Enrich + score + route (slide 21 steps 4-6)
    const inferred = inferSignals(b);
    const { score, tier, breakdown } = scoreLead(inferred);
    const ownerId = routeLead(b.service, tier);
    const slaMin = SLA_MINUTES[tier];
    const lead = db.prepare(`INSERT INTO lead (contact_id, company_id, source, service, score, score_breakdown, tier, status, owner_id, created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(contact.id, company.id, 'website', b.service, score, breakdown, tier, 'NEW', ownerId);
    db.prepare('INSERT INTO lead_source_touch (lead_id, source, landing_page, utm) VALUES (?,?,?,?)')
      .run(lead.lastInsertRowid, 'website', '/', b.utm || null);
    // Auto-response within 60 seconds -> outbox row in the same transaction (outbox pattern)
    const tpl = db.prepare("SELECT * FROM email_template WHERE code='E7'").get(); // placeholder replaced below
    db.prepare(`INSERT INTO email_message (contact_id, template_code, from_address, subject, body_text, status, scheduled_at)
                VALUES (?,?,?,?,?,'QUEUED',datetime('now'))`)
      .run(contact.id, 'A-ACK', 'outreach@mail.infeara.local',
        `Thanks ${b.full_name.split(' ')[0]} — your ${b.service} enquiry is in`,
        `We received your enquiry. Book a slot directly: ${process.env.APP_BASE_URL || 'http://localhost:8080'}/book?lead=${lead.lastInsertRowid}\nWhat happens next: a rep will call within ${slaMin ? slaMin + ' minutes' : '24 hours'}.`);
    // First-touch task with SLA deadline
    if (ownerId && slaMin) {
      const due = new Date(Date.now() + slaMin * 60000).toISOString();
      workflow.createTask('First call', `Tier ${tier} lead (score ${score}). First touch SLA ${slaMin} min.`, due, 'HIGH', ownerId, null, 'lead', lead.lastInsertRowid);
    }
    audit('system', 'LEAD_CAPTURED', 'lead', lead.lastInsertRowid, null);
    return { merged: false, leadId: lead.lastInsertRowid, contactId: contact.id, score, tier, ownerId };
  });
  const result = tx();
  workflow.evaluate('LEAD_CREATED', { leadId: result.leadId, contactId: result.contactId, tier: result.tier || 'D', score: result.score || 0, ownerId: result.ownerId, routedTo: result.ownerId, entityType: 'lead' });
  res.status(202).json({ code: 'CAPTURED', trace_id: trace, lead_id: result.leadId, ...(result.merged ? { merged: true } : { score: result.score, tier: result.tier }), booking_link: `/book?lead=${result.leadId}` });
});

function inferSignals(b) {
  const ts = (b.team_size || '').match(/\d+/);
  return {
    budget: b.budget || (ts && +ts[0] > 200 ? 'approved' : 'small'),
    authority: 'champion', need: b.message ? 'active' : 'aware',
    timeline: 'quarter', engagement: 'opened',
  };
}

app.get('/api/v1/public/services', (req, res) => res.json({ services: ['VAPT', 'Managed IT', 'Cloud', 'Network', 'Automation', 'ODC'] }));

// ---------- public booking (slide 32-33) ----------
const SLOT_MIN = { 'Security review': 20, 'Managed IT review': 30, 'Cloud cost review': 30, 'Automation workshop': 45, 'ODC scoping call': 45, 'Discovery call': 30 };
const WORK_START = 9.5, WORK_END = 16.5, BUFFER_H = 0.25, DAILY_CAP = 6, LEAD_H = 4, HORIZON_DAYS = 20, LUNCH = [13, 14];

function genSlots(repId, type) {
  const dur = (SLOT_MIN[type] || 30) / 60;
  const now = new Date();
  const out = [];
  const booked = new Set(db.prepare("SELECT start_at_utc FROM meeting WHERE rep_id=? AND status='ACTIVE'").all(repId).map(r => r.start_at_utc));
  const held = new Set(db.prepare("SELECT starts_at_utc FROM meeting_slot WHERE rep_id=? AND status='HELD' AND datetime(starts_at_utc) > datetime('now')").all(repId).map(r => r.starts_at_utc));
  let days = 0;
  while (out.length < 40 && days < 40) {
    const d = new Date(now.getTime() + (days + 1) * 86400000);
    days++;
    const dow = d.getDay(); if (dow === 0 || dow === 6) continue; // Mon-Fri
    if (days > HORIZON_DAYS) break;
    const dayKey = d.toISOString().slice(0, 10);
    const dayCount = db.prepare("SELECT COUNT(*) c FROM meeting WHERE rep_id=? AND status='ACTIVE' AND date(start_at_utc)=?").get(repId, dayKey).c;
    if (dayCount >= DAILY_CAP) continue;
    const durMin = Math.round(dur * 60);
    for (let mins = 9 * 60 + 30; mins + durMin <= 16 * 60 + 30; mins += 30) { // 09:30–16:30 IST, 30-min grid
      if (mins >= LUNCH[0] * 60 && mins < LUNCH[1] * 60) continue; // lunch block 13:00-14:00 IST
      if (d.toDateString() === now.toDateString()) {
        const nowIst = (now.getUTCHours() + 5.5) + now.getUTCMinutes() / 60;
        if (mins / 60 < nowIst + LEAD_H) continue; // 4h lead time
      }
      // IST = UTC+5:30
      const utcMins = mins - 330;
      const startUTC = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(utcMins / 60), utcMins % 60, 0));
      if (startUTC <= now) continue;
      const key = startUTC.toISOString();
      if (booked.has(key) || held.has(key)) continue;
      out.push({ start_at_utc: key, start_ist: startUTC.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) });
      if (out.length >= 40) break;
    }
  }
  return out;
}

app.get('/api/v1/public/booking/availability', (req, res) => {
  const type = req.query.service || 'Discovery call';
  const repId = db.prepare("SELECT id FROM app_user WHERE role='Sales Rep' AND active=1 ORDER BY id LIMIT 1").get().id;
  res.json({ service: type, duration_min: SLOT_MIN[type] || 30, slots: genSlots(repId, type) });
});

app.post('/api/v1/public/booking', (req, res) => {
  const { lead_id, start_at_utc, full_name, email, consent } = req.body;
  const repId = db.prepare("SELECT id FROM app_user WHERE role='Sales Rep' AND active=1 ORDER BY id LIMIT 1").get().id;
  const start = new Date(start_at_utc);
  if (isNaN(start) || start <= new Date()) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid slot' });
  const end = new Date(start.getTime() + (SLOT_MIN[req.body.type] || 30) * 60000);
  // consent for booking terms
  if (!consent) return res.status(422).json({ code: 'CONSENT_REQUIRED', message: 'Booking-terms consent required' });
  try {
    const tx = db.transaction(() => {
      const m = db.prepare(`INSERT INTO meeting (lead_id, rep_id, type, start_at_utc, end_at_utc, status, booked_via)
                            VALUES (?,?,?,?,?, 'ACTIVE','public_page')`)
        .run(lead_id || null, repId, req.body.type || 'Discovery call', start.toISOString(), end.toISOString());
      db.prepare("UPDATE lead SET status='ENGAGED' WHERE id=?").run(lead_id);
      audit('public', 'MEETING_BOOKED', 'meeting', m.lastInsertRowid, null);
      return m.lastInsertRowid;
    });
    const meetingId = tx();
    workflow.evaluate('MEETING_BOOKED', { meetingId, contactId: db.prepare('SELECT contact_id FROM lead WHERE id=?').get(lead_id)?.contact_id, ownerId: repId, entityType: 'meeting' });
    res.status(201).json({ code: 'BOOKED', meeting_id: meetingId, ics: `/api/v1/public/meetings/${meetingId}/ics` });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ code: 'SLOT_TAKEN', message: 'Slot just booked — pick another' });
    throw e;
  }
});

app.get('/api/v1/public/meetings/:id/ics', (req, res) => {
  const m = db.prepare('SELECT * FROM meeting WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).end();
  const fmt = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace('Z', 'Z');
  res.setHeader('Content-Type', 'text/calendar');
  res.send(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:meeting-${m.id}@infeara.local\r\nDTSTART:${fmt(m.start_at_utc)}\r\nDTEND:${fmt(m.end_at_utc)}\r\nSUMMARY:${m.type} — Infeara\r\nDESCRIPTION:Agenda and join details follow by email.\r\nEND:VEVENT\r\nEND:VCALENDAR`);
});

app.post('/api/v1/public/unsubscribe', (req, res) => {
  const token = req.body.token || '';
  // signed token: sha256(email + secret)
  const secret = process.env.PII_ENCRYPTION_KEY || 'local-dev-key';
  const email = Buffer.from(token, 'base64url').toString();
  const ok = crypto.createHash('sha256').update(email + secret).digest('hex') === req.body.sig;
  if (!ok) return res.status(400).json({ code: 'VALIDATION_ERROR' });
  const eh = hashEmail(email);
  db.prepare('INSERT OR IGNORE INTO suppression (email_hash, reason) VALUES (?,?)').run(eh, 'unsubscribe');
  db.prepare('UPDATE consent_record SET withdrawn_at=datetime(\'now\') WHERE contact_id IN (SELECT id FROM contact WHERE email_hash=?)').run(eh);
  db.prepare("UPDATE enrollment SET status='STOPPED' WHERE contact_id IN (SELECT id FROM contact WHERE email_hash=?)").run(eh);
  audit('public', 'CONSENT_WITHDRAWN', 'contact', null, null);
  res.json({ code: 'UNSUBSCRIBED', message: 'Suppressed across all sequences within 24h' });
});

app.get('/health', (req, res) => res.json({ status: 'UP', datastore: 'sqlite-local', version: '1.0.0' }));

// ---------- booking page ----------
app.get('/book', (req, res) => {
  res.send(page('Book a meeting', `
    <div class="card" style="max-width:640px;margin:30px auto">
      <h1>Book a conversation</h1><p class="mut">Self-serve scheduling — real availability, instant confirmation with calendar invite.</p>
      <div class="row"><div><label>Conversation type</label><select id="type">${Object.keys(SLOT_MIN).map(t => `<option>${t}</option>`).join('')}</select></div></div>
      <button class="btn" onclick="loadSlots()">Show available slots</button>
      <div id="slots"></div>
      <form id="bookForm" style="display:none;margin-top:14px">
        <input type="hidden" id="start_at_utc"><input type="hidden" id="lead_id" value="${esc(req.query.lead || '')}">
        <div class="row"><div><label>Full name *</label><input id="full_name" required></div>
        <div><label>Business email *</label><input id="email" type="email" required></div></div>
        <label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" id="consent" style="width:auto"> I agree to the booking terms and privacy notice. *</label>
        <div style="margin-top:12px"><button class="btn">Confirm booking</button></div>
      </form></div>
    <script>
    async function loadSlots(){const t=document.getElementById('type').value;
      const r=await fetch('/api/v1/public/booking/availability?service='+encodeURIComponent(t));const j=await r.json();
      document.getElementById('slots').innerHTML='<table><tr><th>Slot (IST)</th><th></th></tr>'+j.slots.map(s=>'<tr><td>'+s.start_ist+'</td><td><button class="btn ghost" onclick="pick(\''+s.start_at_utc+'\')">Pick</button></td></tr>').join('')+'</table>';}
    function pick(s){document.getElementById('start_at_utc').value=s;document.getElementById('bookForm').style.display='block';}
    document.getElementById('bookForm')?.addEventListener('submit',async e=>{e.preventDefault();
      const r=await fetch('/api/v1/public/booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:document.getElementById('type').value,start_at_utc:document.getElementById('start_at_utc').value,lead_id:document.getElementById('lead_id').value||null,full_name:document.getElementById('full_name').value,email:document.getElementById('email').value,consent:document.getElementById('consent').checked})});
      const j=await r.json();alert(j.code==='BOOKED'?'Booked! Calendar invite: '+location.origin+j.ics:'Error: '+j.message);});
    </script>`, req.user));
});

// ---------- authenticated API (blueprint section 24) ----------
const api = express.Router();
api.use(requireLogin);

api.get('/leads', (req, res) => {
  const { tier, status, owner, service, q } = req.query;
  let sql = `SELECT l.*, c.full_name, c.email_hash, co.name company_name, u.full_name owner_name
             FROM lead l JOIN contact c ON c.id=l.contact_id LEFT JOIN company co ON co.id=l.company_id
             LEFT JOIN app_user u ON u.id=l.owner_id WHERE 1=1`;
  const args = [];
  if (tier) { sql += ' AND l.tier=?'; args.push(tier); }
  if (status) { sql += ' AND l.status=?'; args.push(status); }
  if (service) { sql += ' AND l.service=?'; args.push(service); }
  if (owner) { sql += ' AND l.owner_id=?'; args.push(owner); }
  if (q) { sql += ' AND (c.full_name LIKE ? OR co.name LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY l.score DESC, l.created_at DESC LIMIT 200';
  res.json(db.prepare(sql).all(...args));
});

api.post('/leads', requireRole('Sales Rep', 'Sales Manager', 'Admin'), (req, res) => {
  // manual research entry (slide 21)
  const b = req.body;
  if (!b.email || !b.full_name || !b.source) return res.status(400).json({ code: 'VALIDATION_ERROR' });
  const eh = hashEmail(b.email);
  if (db.prepare('SELECT id FROM suppression WHERE email_hash=?').get(eh)) return res.status(410).json({ code: 'UNSUBSCRIBED' });
  const { score, tier, breakdown } = scoreLead(inferSignals(b));
  const ownerId = routeLead(b.service, tier);
  const co = db.prepare('INSERT INTO company (name) VALUES (?)').run(b.company || 'Unknown');
  const c = db.prepare('INSERT INTO contact (company_id, full_name, email_hash) VALUES (?,?,?)').run(co.lastInsertRowid, b.full_name, eh);
  const l = db.prepare('INSERT INTO lead (contact_id, company_id, source, service, score, score_breakdown, tier, owner_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(c.lastInsertRowid, co.lastInsertRowid, b.source, b.service || null, score, breakdown, tier, ownerId);
  audit(req.user.email, 'LEAD_CREATED_MANUAL', 'lead', l.lastInsertRowid, null);
  workflow.evaluate('LEAD_CREATED', { leadId: l.lastInsertRowid, contactId: c.lastInsertRowid, tier, score, ownerId, routedTo: ownerId, entityType: 'lead' });
  res.status(201).json({ id: l.lastInsertRowid, score, tier });
});

api.get('/leads/:id', (req, res) => {
  const lead = db.prepare(`SELECT l.*, c.full_name, co.name company_name, u.full_name owner_name FROM lead l
    JOIN contact c ON c.id=l.contact_id LEFT JOIN company co ON co.id=l.company_id
    LEFT JOIN app_user u ON u.id=l.owner_id WHERE l.id=?`).get(req.params.id);
  if (!lead) return res.status(404).end();
  const timeline = db.prepare(`SELECT 'activity' kind, id, type, subject, created_at FROM activity WHERE entity_type='lead' AND entity_id=?
    UNION ALL SELECT 'stage', h.id, h.from_stage||' → '||h.to_stage, h.changed_at, h.changed_at FROM deal_stage_history h JOIN deal d ON d.id=h.deal_id WHERE d.lead_id=?
    UNION ALL SELECT 'task', id, title, status, created_at FROM task WHERE entity_type='lead' AND entity_id=? ORDER BY created_at DESC LIMIT 50`).all(req.params.id, req.params.id, req.params.id);
  res.json({ ...lead, timeline });
});

api.patch('/leads/:id', requireRole('Sales Rep', 'Sales Manager', 'Admin'), (req, res) => {
  const lead = db.prepare('SELECT * FROM lead WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).end();
  const { owner_id, tier, status } = req.body;
  if (tier && tier !== lead.tier) { if (!req.body.override_reason) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Score override requires a reason' }); }
  db.prepare('UPDATE lead SET owner_id=COALESCE(?,owner_id), tier=COALESCE(?,tier), status=COALESCE(?,status) WHERE id=?')
    .run(owner_id ?? null, tier ?? null, status ?? null, req.params.id);
  audit(req.user.email, 'LEAD_UPDATED', 'lead', req.params.id, null);
  res.json({ ok: true });
});

api.post('/leads/:id/convert', requireRole('Sales Rep', 'Sales Manager', 'Admin'), (req, res) => {
  const lead = db.prepare('SELECT * FROM lead WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).end();
  const existing = db.prepare('SELECT id FROM deal WHERE lead_id=?').get(lead.id);
  if (existing) return res.status(409).json({ code: 'DUPLICATE_LEAD', message: 'Deal already exists' });
  const d = db.prepare('INSERT INTO deal (company_id, lead_id, name, service, stage, owner_id) VALUES (?,?,?,?,?,?)')
    .run(lead.company_id, lead.id, `${lead.service || 'Engagement'} — ${lead.id}`, lead.service, 'QUALIFIED', lead.owner_id);
  db.prepare("INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by) VALUES (?,NULL,'QUALIFIED',?)").run(d.lastInsertRowid, req.user.email);
  db.prepare("UPDATE lead SET status='QUALIFIED' WHERE id=?").run(lead.id);
  audit(req.user.email, 'LEAD_CONVERTED', 'deal', d.lastInsertRowid, null);
  res.status(201).json({ deal_id: d.lastInsertRowid });
});

api.get('/deals', (req, res) => {
  res.json(db.prepare(`SELECT d.*, co.name company_name, u.full_name owner_name FROM deal d
    LEFT JOIN company co ON co.id=d.company_id LEFT JOIN app_user u ON u.id=d.owner_id ORDER BY d.created_at DESC`).all());
});

api.patch('/deals/:id/stage', requireRole('Sales Rep', 'Sales Manager', 'Admin'), (req, res) => {
  const d = db.prepare('SELECT * FROM deal WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).end();
  const to = String(req.body.stage || '').toUpperCase();
  const stages = ['CAPTURED', 'ENGAGED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'ONBOARDING', 'NURTURE', 'LOST'];
  if (!stages.includes(to)) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Unknown stage' });
  // Stage hygiene: one stage at a time, artefact gate for PROPOSAL (slide 16)
  if (to === 'PROPOSAL' && !req.body.proposal_sent) return res.status(409).json({ code: 'SLA_BREACH', message: 'Required artefact missing: proposal_sent' });
  if (to === 'LOST' && !req.body.lost_reason) return res.status(409).json({ code: 'SLA_BREACH', message: 'Closed-lost requires a mandatory reason' });
  db.prepare('UPDATE deal SET stage=?, amount=COALESCE(?,amount), probability=? WHERE id=?').run(to, req.body.amount ?? null, { WON: 1, LOST: 0 }[to] ?? 0.5, req.params.id);
  db.prepare('INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by, note) VALUES (?,?,?,?,?)')
    .run(d.id, d.stage, to, req.user.email, req.body.note || (to === 'LOST' ? req.body.lost_reason : null));
  audit(req.user.email, 'DEAL_STAGE_CHANGED', 'deal', d.id, null);
  if (to === 'WON') workflow.evaluate('CLOSED_WON', { dealId: d.id, ownerId: d.owner_id, entityType: 'deal' });
  if (to === 'LOST') workflow.evaluate('CLOSED_LOST', { dealId: d.id, ownerId: d.owner_id, entityType: 'deal' });
  res.json({ ok: true });
});

api.post('/activities', requireRole('Sales Rep', 'Sales Manager', 'Admin', 'SDR'), (req, res) => {
  const { type, subject, body, entity_type, entity_id } = req.body;
  const r = db.prepare('INSERT INTO activity (type, subject, body, owner_id, entity_type, entity_id) VALUES (?,?,?,?,?,?)')
    .run(type, subject, body, req.user.id, entity_type, entity_id);
  audit(req.user.email, 'ACTIVITY_LOGGED', entity_type, entity_id, null);
  res.status(201).json({ id: r.lastInsertRowid });
});

api.get('/tasks', (req, res) => {
  const mine = req.query.mine === '1';
  const sql = mine
    ? 'SELECT * FROM task WHERE owner_id=? AND status="OPEN" ORDER BY due_at LIMIT 100'
    : 'SELECT * FROM task WHERE status="OPEN" ORDER BY due_at LIMIT 100';
  res.json(db.prepare(sql).all(...(mine ? [req.user.id] : [])));
});
api.patch('/tasks/:id', requireRole('Sales Rep', 'Sales Manager', 'Admin', 'SDR', 'Delivery Lead'), (req, res) => {
  const t = db.prepare('SELECT * FROM task WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).end();
  db.prepare("UPDATE task SET status=COALESCE(?,status) WHERE id=?").run(req.body.status || null, t.id);
  audit(req.user.email, 'TASK_UPDATED', 'task', t.id, null);
  res.json({ ok: true });
});

api.get('/sequences', (req, res) => {
  res.json(db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM enrollment e WHERE e.sequence_id=s.id) enrolled FROM sequence s`).all());
});
api.post('/enrollments', requireRole('Sales Rep', 'Sales Manager', 'Admin'), (req, res) => {
  const { contact_id, sequence_code } = req.body;
  const seq = db.prepare('SELECT * FROM sequence WHERE code=?').get(sequence_code);
  if (!seq) return res.status(404).json({ code: 'VALIDATION_ERROR' });
  if (db.prepare('SELECT id FROM suppression WHERE email_hash=(SELECT email_hash FROM contact WHERE id=?)').get(contact_id))
    return res.status(410).json({ code: 'UNSUBSCRIBED' });
  const active = db.prepare('SELECT id FROM consent_record WHERE contact_id=? AND withdrawn_at IS NULL').get(contact_id);
  if (!active) return res.status(422).json({ code: 'CONSENT_REQUIRED', message: 'No lawful basis recorded' });
  const r = db.prepare('INSERT INTO enrollment (contact_id, sequence_id, next_send_at) VALUES (?,?,datetime(\'now\', \'+1 day\'))').run(contact_id, seq.id);
  audit(req.user.email, 'ENROLLMENT_CREATED', 'enrollment', r.lastInsertRowid, null);
  res.status(201).json({ id: r.lastInsertRowid });
});
api.post('/enrollments/:id/stop', requireRole('Sales Rep', 'Sales Manager', 'Admin'), (req, res) => {
  db.prepare("UPDATE enrollment SET status='STOPPED' WHERE id=?").run(req.params.id);
  audit(req.user.email, 'ENROLLMENT_STOPPED', 'enrollment', req.params.id, null);
  res.json({ ok: true });
});

api.get('/meetings', (req, res) => {
  res.json(db.prepare(`SELECT m.*, u.full_name rep, l.id lead_id FROM meeting m LEFT JOIN app_user u ON u.id=m.rep_id
    LEFT JOIN lead l ON l.id=m.lead_id ORDER BY m.start_at_utc`).all());
});
api.post('/meetings/:id/outcome', requireRole('Sales Rep', 'Sales Manager', 'Admin'), (req, res) => {
  const m = db.prepare('SELECT * FROM meeting WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).end();
  db.prepare('INSERT OR REPLACE INTO meeting_outcome (meeting_id, outcome, notes, next_step) VALUES (?,?,?,?)')
    .run(m.id, req.body.outcome, req.body.notes, req.body.next_step);
  const deal = db.prepare('SELECT * FROM deal WHERE lead_id=?').get(m.lead_id);
  if (req.body.outcome === 'interested' && deal)
    workflow.evaluate('MEETING_HELD', { meetingId: m.id, dealId: deal.id, ownerId: m.rep_id, fromStage: deal.stage, contactId: db.prepare('SELECT contact_id FROM lead WHERE id=?').get(m.lead_id)?.contact_id, outcome: 'interested', entityType: 'meeting' });
  if (req.body.outcome === 'no_show')
    workflow.evaluate('MEETING_NO_SHOW', { meetingId: m.id, ownerId: m.rep_id, entityType: 'meeting' });
  audit(req.user.email, 'MEETING_OUTCOME', 'meeting', m.id, null);
  res.json({ ok: true });
});

api.get('/reports/funnel', (req, res) => {
  const stages = ['CAPTURED', 'ENGAGED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON'];
  const funnel = stages.map(s => ({ stage: s, deals: db.prepare('SELECT COUNT(*) c, COALESCE(SUM(CAST(amount AS REAL)),0) v FROM deal WHERE stage=?').get(s) }));
  const leads = { total: db.prepare('SELECT COUNT(*) c FROM lead').get().c, byTier: db.prepare('SELECT tier, COUNT(*) c FROM lead GROUP BY tier').all() };
  const meetings = { booked: db.prepare('SELECT COUNT(*) c FROM meeting').get().c, held: db.prepare("SELECT COUNT(*) c FROM meeting_outcome WHERE outcome!='no_show'").get().c };
  res.json({ funnel, leads, meetings, generated_at: new Date().toISOString() });
});
api.get('/reports/forecast', (req, res) => {
  const rows = db.prepare(`SELECT stage, COUNT(*) n, COALESCE(SUM(CAST(amount AS REAL)),0) pipeline FROM deal
    WHERE stage NOT IN ('WON','LOST','NURTURE') GROUP BY stage`).all();
  const weights = { CAPTURED: 0.05, ENGAGED: 0.2, QUALIFIED: 0.3, PROPOSAL: 0.64, NEGOTIATION: 0.85 };
  const weighted = rows.reduce((s, r) => s + r.pipeline * (weights[r.stage] || 0.1), 0);
  res.json({ open_pipeline: rows, weighted_forecast: Math.round(weighted), coverage_vs_10L_target: +(weighted / 1000000).toFixed(2) });
});
api.get('/audit', requireRole('Admin', 'Read-only'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});
api.post('/exports', requireRole('Sales Manager', 'Admin'), (req, res) => {
  const kind = req.body?.kind || 'leads';
  const rows = db.prepare(`SELECT l.id, c.full_name, co.name company, l.source, l.service, l.tier, l.score, l.status, l.created_at
    FROM lead l JOIN contact c ON c.id=l.contact_id LEFT JOIN company co ON co.id=l.company_id`).all();
  const csv = ['id,name,company,source,service,tier,score,status,created_at',
    ...rows.map(r => [r.id, r.full_name, r.company, r.source, r.service, r.tier, r.score, r.status, r.created_at].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const j = db.prepare('INSERT INTO export_job (requested_by, kind, status, row_count, path) VALUES (?,?,?,?,?)')
    .run(req.user.email, kind, 'DONE', rows.length, 'memory');
  audit(req.user.email, 'EXPORT_CSV', 'export_job', j.lastInsertRowid, null);
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});
api.get('/notifications', (req, res) => {
  res.json(db.prepare('SELECT * FROM notification WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id));
});
api.get('/settings', requireRole('Admin'), (req, res) => {
  res.json({ settings: db.prepare('SELECT * FROM app_setting').all(), flags: db.prepare('SELECT * FROM feature_flag').all() });
});
api.patch('/settings/flags/:key', requireRole('Admin'), (req, res) => {
  db.prepare('UPDATE feature_flag SET enabled=?, updated_at=datetime(\'now\') WHERE key=?').run(req.body.enabled ? 1 : 0, req.params.key);
  audit(req.user.email, 'FEATURE_FLAG_CHANGED', 'feature_flag', null, null);
  res.json({ ok: true });
});
app.use('/api/v1', api);

// ---------- admin UI pages ----------
app.get('/app', requireLogin, (req, res) => {
  const q = (s) => db.prepare(s).get();
  const stats = {
    newLeads: q("SELECT COUNT(*) c FROM lead WHERE created_at > datetime('now','-7 days')").c,
    openPipeline: q("SELECT COALESCE(SUM(CAST(amount AS REAL)),0) v FROM deal WHERE stage NOT IN ('WON','LOST','NURTURE')").v,
    meetingsBooked: q("SELECT COUNT(*) c FROM meeting WHERE start_at_utc > datetime('now')").c,
    myTasks: db.prepare("SELECT COUNT(*) c FROM task WHERE status='OPEN' AND owner_id=?").get(req.user.id).c,
    alerts: db.prepare('SELECT COUNT(*) c FROM notification WHERE user_id=? AND read=0').get(req.user.id).c,
  };
  res.send(page('Manager cockpit', `
    <h1>Manager cockpit</h1><p class="mut">The five numbers that matter this week — generated from the same database as the operational screens.</p>
    <div class="grid">
      <div class="stat"><b>${stats.newLeads}</b><span>New leads (7d)</span></div>
      <div class="stat"><b>${inr(stats.openPipeline)}</b><span>Open pipeline</span></div>
      <div class="stat"><b>${stats.meetingsBooked}</b><span>Meetings booked</span></div>
      <div class="stat"><b>${stats.myTasks}</b><span>My open tasks</span></div>
      <div class="stat"><b>${stats.alerts}</b><span>Unread alerts</span></div>
    </div>
    <div class="card"><h2>Today</h2><table><tr><th>Task</th><th>Due</th><th>Priority</th></tr>
      ${db.prepare("SELECT * FROM task WHERE status='OPEN' AND owner_id=? ORDER BY due_at LIMIT 10").all(req.user.id).map(t => `<tr><td>${esc(t.title)}</td><td class="mut">${esc(t.due_at)}</td><td>${esc(t.priority)}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">Nothing due — the autopilot is on it.</td></tr>'}
    </table></div>
    <div class="card"><h2>Alert thresholds (slide 35)</h2><table><tr><th>Metric</th><th>Threshold</th><th>Audience</th></tr>
      <tr><td>Tier A first touch</td><td>&gt; 15 minutes</td><td>Manager</td></tr>
      <tr><td>Sequence failure rate</td><td>&gt; 3% in an hour</td><td>Tech Lead</td></tr>
      <tr><td>Hard bounce rate</td><td>&gt; 3% in a day</td><td>Marketing</td></tr>
      <tr><td>Booking page conversion</td><td>&lt; 15% for a week</td><td>Marketing</td></tr>
      <tr><td>Show rate</td><td>&lt; 75% for a month</td><td>Sales Manager</td></tr>
    </table></div>`, req.user));
});

app.get('/app/leads', requireLogin, (req, res) => {
  const leads = db.prepare(`SELECT l.*, c.full_name, co.name company_name, u.full_name owner_name FROM lead l
    JOIN contact c ON c.id=l.contact_id LEFT JOIN company co ON co.id=l.company_id
    LEFT JOIN app_user u ON u.id=l.owner_id ORDER BY l.score DESC LIMIT 100`).all();
  res.send(page('Lead inbox', `
    <h1>Lead inbox</h1>
    <form method="get" class="row" style="margin-bottom:12px">
      <input name="q" placeholder="Search name / company" value="${esc(req.query.q || '')}">
      <select name="tier"><option value="">All tiers</option>${['A', 'B', 'C', 'D'].map(t => `<option ${req.query.tier === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <button class="btn" style="flex:0 0 auto">Filter</button>
    </form>
    <div class="card"><table><tr><th>Lead</th><th>Company</th><th>Service</th><th>Tier</th><th>Score</th><th>Owner</th><th>Status</th><th></th></tr>
    ${leads.map(l => `<tr><td>${esc(l.full_name)}</td><td>${esc(l.company_name)}</td><td>${esc(l.service)}</td>
      <td><span class="pill t${l.tier}">${l.tier}</span></td><td>${l.score}</td><td>${esc(l.owner_name || '—')}</td><td>${esc(l.status)}</td>
      <td><a href="/app/leads/${l.id}">Open</a></td></tr>`).join('')}</table></div>`, req.user));
});

app.get('/app/leads/:id', requireLogin, (req, res) => {
  const l = db.prepare(`SELECT l.*, c.full_name, co.name company_name, u.full_name owner_name FROM lead l
    JOIN contact c ON c.id=l.contact_id LEFT JOIN company co ON co.id=l.company_id
    LEFT JOIN app_user u ON u.id=l.owner_id WHERE l.id=?`).get(req.params.id);
  if (!l) return res.status(404).send('Not found');
  const acts = db.prepare("SELECT * FROM activity WHERE entity_type='lead' AND entity_id=? ORDER BY created_at DESC").all(l.id);
  const tasks = db.prepare("SELECT * FROM task WHERE entity_type='lead' AND entity_id=? ORDER BY created_at DESC").all(l.id);
  const enroll = db.prepare(`SELECT e.*, s.name seq_name FROM enrollment e JOIN sequence s ON s.id=e.sequence_id WHERE e.contact_id=?`).all(l.contact_id);
  res.send(page('Lead ' + l.id, `
    <h1>${esc(l.full_name)} <span class="pill t${l.tier}">Tier ${l.tier}</span></h1>
    <p class="mut">${esc(l.company_name)} · ${esc(l.service)} · source ${esc(l.source)} · owner ${esc(l.owner_name || 'unassigned')} · status ${esc(l.status)}</p>
    <div class="card"><h2>Score breakdown (explainable, slide 20)</h2><pre class="small">${esc(l.score_breakdown)}</pre>
      <p class="small mut">Total ${l.score}/100. Overrides require a mandatory reason.</p></div>
    <div class="row">
      <div class="card"><h2>Activities</h2>${acts.map(a => `<p class="small"><b>${esc(a.type)}</b> ${esc(a.subject || '')} <span class="mut">${esc(a.created_at)}</span></p>`).join('') || '<p class="mut small">None yet</p>'}
        <form method="post" action="/api/v1/activities" onsubmit="return postJson(this)">
          <input type="hidden" name="entity_type" value="lead"><input type="hidden" name="entity_id" value="${l.id}">
          <select name="type"><option>call</option><option>email</option><option>meeting</option><option>note</option></select>
          <input name="subject" placeholder="Subject / outcome"><button class="btn">Log</button></form></div>
      <div class="card"><h2>Tasks</h2>${tasks.map(t => `<p class="small">${esc(t.title)} — ${esc(t.status)} <span class="mut">due ${esc(t.due_at)}</span></p>`).join('') || '<p class="mut small">None</p>'}
        <h2>Sequences</h2>${enroll.map(e => `<p class="small">${esc(e.seq_name)} — ${esc(e.status)}</p>`).join('') || '<p class="mut small">Not enrolled</p>'}
        <form method="post" action="/api/v1/enrollments" onsubmit="return postJson(this)">
          <input type="hidden" name="contact_id" value="${l.contact_id}">
          <select name="sequence_code"><option>SEC-01</option><option>MIT-02</option><option>CLD-03</option><option>ODC-04</option><option>NU-06</option></select>
          <button class="btn">Enrol</button></form>
        <form method="post" action="/api/v1/leads/${l.id}/convert" onsubmit="return postJson(this)"><button class="btn ghost">Convert to deal</button></form></div>
    </div>
    <script>async function postJson(f){const o=Object.fromEntries(new FormData(f));const r=await fetch(f.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});location.reload();return false;}</script>`, req.user));
});

app.get('/app/pipeline', requireLogin, (req, res) => {
  const stages = ['CAPTURED', 'ENGAGED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'ONBOARDING', 'NURTURE', 'LOST'];
  res.send(page('Pipeline board', `<h1>Pipeline board</h1><div class="row">${stages.map(s => {
    const deals = db.prepare(`SELECT d.*, co.name company_name FROM deal d LEFT JOIN company co ON co.id=d.company_id WHERE d.stage=?`).all(s);
    return `<div class="card" style="min-width:200px"><h2>${s} (${deals.length})</h2>${deals.map(d => `<p class="small"><b>${esc(d.name)}</b><br>${esc(d.company_name || '')} · ${inr(d.amount)}<br>
      <select onchange="moveStage(${d.id},this.value)"><option value="">Move to…</option>${stages.filter(x => x !== s).map(x => `<option>${x}</option>`).join('')}</select></p>`).join('')}</div>`;
  }).join('')}</div>
  <script>async function moveStage(id,v){if(!v)return;let body={stage:v};if(v==='LOST'){body.lost_reason=prompt('Mandatory lost reason:')||'unresponsive';}if(v==='PROPOSAL')body.proposal_sent=true;
    await fetch('/api/v1/deals/'+id+'/stage',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});location.reload();}</script>`, req.user));
});

app.get('/app/tasks', requireLogin, (req, res) => {
  const tasks = db.prepare(`SELECT t.*, u.full_name owner FROM task t LEFT JOIN app_user u ON u.id=t.owner_id WHERE t.status='OPEN' ORDER BY t.due_at LIMIT 100`).all();
  res.send(page('Tasks', `<h1>Task queue</h1><div class="card"><table><tr><th>Task</th><th>Owner</th><th>Priority</th><th>Due</th><th></th></tr>
    ${tasks.map(t => `<tr><td>${esc(t.title)}</td><td>${esc(t.owner || '—')}</td><td>${esc(t.priority)}</td><td class="mut">${esc(t.due_at)}</td>
    <td><button class="btn ghost" onclick="done(${t.id})">Done</button></td></tr>`).join('')}</table></div>
    <script>async function done(id){await fetch('/api/v1/tasks/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'DONE'})});location.reload();}</script>`, req.user));
});

app.get('/app/sequences', requireLogin, (req, res) => {
  const seqs = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM enrollment e WHERE e.sequence_id=s.id AND e.status='ACTIVE') active_enrollments FROM sequence s`).all();
  res.send(page('Sequences', `<h1>Email sequences</h1><div class="card"><table><tr><th>Code</th><th>Name</th><th>Steps</th><th>Duration</th><th>Active enrolments</th><th>Exit criteria</th></tr>
    ${seqs.map(s => `<tr><td>${s.code}</td><td>${esc(s.name)}</td><td>${s.steps}</td><td>${s.duration_days}d</td><td>${s.active_enrollments}</td><td class="mut small">${esc(s.exit_criteria)}</td></tr>`).join('')}</table>
    <p class="small mut">Guardrails: ≤30 emails/mailbox/day, warm-up ramp, send window 09:30-11:30 &amp; 15:00-17:30 IST Mon-Fri, opt-out honoured within 24h. Sending flag: ${flagOn('email.sending') ? 'ON' : 'OFF (outbox queued)'}.</p></div>`, req.user));
});

app.get('/app/bookings', requireLogin, (req, res) => {
  const ms = db.prepare(`SELECT m.*, u.full_name rep FROM meeting m LEFT JOIN app_user u ON u.id=m.rep_id ORDER BY m.start_at_utc DESC LIMIT 50`).all();
  res.send(page('Bookings', `<h1>Meetings</h1><div class="card"><table><tr><th>When (IST)</th><th>Type</th><th>Rep</th><th>Status</th><th></th></tr>
    ${ms.map(m => `<tr><td>${esc(new Date(m.start_at_utc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}</td><td>${esc(m.type)}</td><td>${esc(m.rep)}</td><td>${esc(m.status)}</td>
    <td><a href="/api/v1/public/meetings/${m.id}/ics">ICS</a></td></tr>`).join('')}</table></div>`, req.user));
});

app.get('/app/reports', requireLogin, (req, res) => {
  res.send(page('Reports', `<h1>Reports &amp; exports</h1>
    <div class="card"><h2>Funnel &amp; forecast</h2><div id="r">Loading…</div>
      <p><a class="btn" href="/api/v1/exports">Export leads CSV (audit-logged)</a></p></div>
    <script>fetch('/api/v1/reports/funnel').then(r=>r.json()).then(j=>{
      document.getElementById('r').innerHTML='<table><tr><th>Stage</th><th>Deals</th><th>Value</th></tr>'+
      j.funnel.map(f=>'<tr><td>'+f.stage+'</td><td>'+f.deals.c+'</td><td>'+f.deals.v+'</td></tr>').join('')+'</table>'+
      '<p class="small mut">Leads: '+j.leads.total+' · Meetings booked: '+j.meetings.booked+', held: '+j.meetings.held+'</p>';
    });</script>`, req.user));
});

app.get('/app/audit', requireRole('Admin', 'Read-only'), (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all();
  res.send(page('Audit log', `<h1>Audit log (append-only, hash-chained)</h1><div class="card"><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Hash</th></tr>
    ${rows.map(r => `<tr><td class="mut small">${esc(r.occurred_at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.entity_type)}/${esc(r.entity_id || '')}</td><td class="small mut">${esc((r.after_hash || '').slice(0, 12))}…</td></tr>`).join('')}</table></div>`, req.user));
});

app.get('/app/settings', requireRole('Admin'), (req, res) => {
  const flags = db.prepare('SELECT * FROM feature_flag').all();
  res.send(page('Settings & feature flags', `<h1>Settings &amp; feature flags</h1>
    <div class="card"><h2>Feature flags (rollout gates, slide 42)</h2><table><tr><th>Flag</th><th>Enabled</th><th>Purpose</th><th></th></tr>
    ${flags.map(f => `<tr><td>${f.key}</td><td>${f.enabled ? 'ON' : 'off'}</td><td class="mut small">${esc(f.purpose)}</td>
      <td><button class="btn ghost" onclick="toggle('${f.key}',${f.enabled ? 0 : 1})">${f.enabled ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</table></div>
    <script>async function toggle(k,v){await fetch('/api/v1/settings/flags/'+k,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:v})});location.reload();}</script>`, req.user));
});

// ---------- background scheduler (Quartz equivalent): outbox, reminders, sweeps ----------
setInterval(() => {
  try {
    // advance enrolments / outbox
    if (flagOn('email.sending')) {
      const due = db.prepare("SELECT * FROM email_message WHERE status='QUEUED' AND datetime(scheduled_at)<=datetime('now') LIMIT 50").all();
      for (const m of due) {
        db.prepare("UPDATE email_message SET status='SENT', sent_at=datetime('now'), message_id=? WHERE id=?").run('local-' + m.id, m.id);
        db.prepare("INSERT INTO email_event (message_id, type, detail) VALUES (?, 'sent', 'via local SMTP relay')").run(m.id);
      }
    }
    // reminders T-24h / T-1h
    const soon = db.prepare("SELECT * FROM meeting WHERE status='ACTIVE' AND start_at_utc BETWEEN datetime('now') AND datetime('now','+24 hours')").all();
    for (const m of soon) {
      const start = new Date(m.start_at_utc).getTime();
      for (const [kind, deltaH] of [['T-24h', 24], ['T-1h', 1]]) {
        const dueAt = start - deltaH * 3600000;
        if (Math.abs(Date.now() - dueAt) < 90000 && !db.prepare('SELECT id FROM reminder_log WHERE meeting_id=? AND kind=?').get(m.id, kind)) {
          db.prepare("INSERT INTO reminder_log (meeting_id, kind, channel, status) VALUES (?,?,'email','SENT')").run(m.id, kind);
        }
      }
      // no-show: 10 min after start, no outcome
      if (Date.now() > start + 600000 && !db.prepare('SELECT id FROM meeting_outcome WHERE meeting_id=?').get(m.id)) {
        db.prepare("UPDATE meeting SET status='NO_SHOW' WHERE id=?").run(m.id);
        workflow.evaluate('MEETING_NO_SHOW', { meetingId: m.id, ownerId: m.rep_id, entityType: 'meeting' });
      }
    }
    workflow.sweepStaleDeals();
  } catch (e) { console.error('scheduler error', e.message); }
}, 60000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Sales Pipeline Autopilot running at http://localhost:${PORT} (db: ${require('./src/db').DB_PATH})`));
