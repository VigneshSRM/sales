// Lead scoring & routing model (blueprint slide 20): 100 points across five
// factors (0-20 each), tiers A/B/C/D with response SLAs, round-robin routing.
const { db } = require('./db');

// Each factor maps a lead field to 0-5 / 6-12 / 13-18 / 19-20 points.
function scoreLead(input) {
  const b = input.budget || 'unknown';       // no_budget, small, approved, confirmed
  const a = input.authority || 'unknown';    // none, influencer, champion, economic_buyer
  const n = input.need || 'general';         // general, aware, active, quantified
  const t = input.timeline || 'none';        // none, exploring, quarter, within30
  const e = input.engagement || 'none';      // none, opened, replied, meeting
  const map = {
    budget: { no_budget: 3, small: 9, approved: 15, confirmed: 20, unknown: 6 },
    authority: { none: 3, influencer: 9, champion: 15, economic_buyer: 20, unknown: 6 },
    need: { general: 3, aware: 9, active: 15, quantified: 20 },
    timeline: { none: 3, exploring: 9, quarter: 15, within30: 20 },
    engagement: { none: 3, opened: 9, replied: 15, meeting: 20 },
  };
  const breakdown = {
    budget: map.budget[b] ?? 6,
    authority: map.authority[a] ?? 6,
    need: map.need[n] ?? 3,
    timeline: map.timeline[t] ?? 3,
    engagement: map.engagement[e] ?? 3,
  };
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  const tier = total >= 75 ? 'A' : total >= 55 ? 'B' : total >= 40 ? 'C' : 'D';
  return { score: total, tier, breakdown: JSON.stringify(breakdown) };
}

const SLA_MINUTES = { A: 15, B: 240, C: 1440, D: null }; // first touch SLA

function routeLead(service, tier) {
  // Routing rules (slide 18): Tier A + VAPT/Security -> founder + security lead;
  // Chennai pod round-robin; Tier C -> SDR nurture; D -> no rep.
  if (tier === 'D') return null;
  if (tier === 'C') {
    return db.prepare("SELECT id FROM app_user WHERE role='SDR' AND active=1 ORDER BY id LIMIT 1").get()?.id ?? null;
  }
  const pool = tier === 'A' && /VAPT|Security/i.test(service || '')
    ? db.prepare("SELECT id FROM app_user WHERE role IN ('Admin','Sales Manager') AND active=1 ORDER BY id").all()
    : db.prepare("SELECT id FROM app_user WHERE role='Sales Rep' AND active=1 ORDER BY id").all();
  if (!pool.length) return null;
  // round-robin: least recently assigned
  const last = db.prepare(`SELECT owner_id, MAX(created_at) t FROM lead WHERE owner_id IN (${pool.map(() => '?').join(',')}) GROUP BY owner_id`)
    .all(...pool.map(p => p.id));
  const counts = new Map(last.map(r => [r.owner_id, r.t]));
  pool.sort((x, y) => (counts.get(x.id) || '') < (counts.get(y.id) || '') ? -1 : 1);
  return pool[0].id;
}

module.exports = { scoreLead, routeLead, SLA_MINUTES };
