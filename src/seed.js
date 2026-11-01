// Seed data: reference sets, templates, sequences, workflow rules, users —
// taken from blueprint Appendix A/B (service lines, stages, tiers, roles,
// E1–E8 templates, SEC-01..NU-06 sequences, 16-rule follow-up rulebook).
const crypto = require('crypto');
const { db, audit, hashEmail } = require('./db');

const pw = (p) => crypto.createHash('sha256').update('autopilot:' + p).digest('hex');

const users = [
  ['admin@infeara.local', 'Admin', 'Full', 'Admin', 1],
  ['founder@infeara.local', 'Founder', 'Owner', 'Admin', 1],
  ['sales.manager@infeara.local', 'Sales Manager', 'Chen', 'Sales Manager', 1],
  ['rep1@infeara.local', 'Rep One', 'Kumar', 'Sales Rep', 0],
  ['rep2@infeara.local', 'Rep Two', 'Priya', 'Sales Rep', 0],
  ['sdr@infeara.local', 'SDR', 'Research', 'SDR', 0],
  ['delivery@infeara.local', 'Delivery Lead', 'Ops', 'Delivery Lead', 0],
  ['viewer@infeara.local', 'Viewer', 'Readonly', 'Read-only', 0],
];
const insUser = db.prepare('INSERT OR IGNORE INTO app_user (email, password_hash, full_name, role, mfa_enabled) VALUES (?,?,?,?,?)');
for (const u of users) insUser.run(u[0], pw('ChangeMe#2026'), u[1] + ' ' + u[2], u[3], u[4]);

const settings = [
  ['app.timezone', 'Asia/Kolkata'], ['app.currency', 'INR'],
  ['booking.working_hours', 'Mon-Fri 09:30-16:30 IST'], ['booking.buffer_min', '15'],
  ['booking.daily_cap', '6'], ['booking.lead_time_hours', '4'], ['booking.horizon_days', '20'],
  ['booking.hold_window_min', '5'], ['booking.lunch_block', '13:00-14:00 IST'],
  ['email.volume_cap_per_mailbox_day', '30'], ['email.send_window', '09:30-11:30 and 15:00-17:30 IST, Mon-Fri'],
  ['email.quiet_hours', '20:00-08:00 IST'], ['scoring.max', '100'],
];
const insSet = db.prepare('INSERT OR IGNORE INTO app_setting (key, value) VALUES (?,?)');
for (const s of settings) insSet.run(s[0], s[1]);

// Feature flags (blueprint section 17): automation off by default until gates pass.
const flags = [
  ['capture.public', 1, 'Public lead form endpoint'],
  ['email.sending', 0, 'Outbound SMTP from sequences (enable after SPF/DKIM/DMARC verified)'],
  ['email.imap', 0, 'Reply detection and bounce processing'],
  ['booking.public', 1, 'Tokenised booking page'],
  ['workflow.enrolment', 1, 'Automatic sequence enrolment'],
  ['proposal.tracking', 0, 'Proposal view notifications'],
  ['export.csv', 1, 'Audit-logged CSV export'],
  ['pilot.mode', 1, 'Restrict dashboards to pilot users'],
];
const insFlag = db.prepare('INSERT OR IGNORE INTO feature_flag (key, enabled, purpose) VALUES (?,?,?)');
for (const f of flags) insFlag.run(f[0], f[1], f[2]);

// Email templates E1–E8 (Appendix B)
const templates = [
  ['E1', 'Security audit — first touch', 'BFSI / healthcare / SaaS', 'A quick question about your audit readiness', 'One specific observation -> one sentence on risk -> one line on the 2-week health check -> low-friction question', '20-minute scope call'],
  ['E2', 'Security audit — value follow-up', 'Non-responders, day 3', 'The three findings we see most often', 'Three anonymised findings -> what they cost -> link to the checklist', 'Download the checklist'],
  ['E3', 'Security audit — proof', 'Engaged, day 7', 'How a Chennai manufacturer closed 14 audit findings', 'Short outcome story -> what we did -> what it means for them', 'Case study + call'],
  ['E4', 'Managed IT review', 'Operations / finance', 'Who answers at 2 AM?', 'Downtime cost framing -> SLA and escalation -> 30-minute review', 'Book a review'],
  ['E5', 'Break-up / permission to close', 'Day 16 non-responders', 'Should I close your file?', 'Short, polite, no guilt -> one-line value -> permission to close', "Reply 'later' or 'close'"],
  ['E6', 'Proposal follow-up', 'Proposal sent, no reply', 'One question on the proposal', 'Reference the proposal -> ask the one question that unblocks -> offer a 15-minute call', '15-minute call'],
  ['E7', 'Meeting confirmation', 'Booked lead', 'Confirmed: {date} at {time} IST', 'Agenda, attendees, what to prepare, join link, reschedule policy', 'Add to calendar (ICS)'],
  ['E8', 'No-show rebook', 'No-show', 'Sorry we missed you', 'No guilt -> two alternative slots -> one question', 'Rebook'],
];
const insT = db.prepare('INSERT OR IGNORE INTO email_template (code, name, audience, subject, body_outline, cta) VALUES (?,?,?,?,?,?)');
for (const t of templates) insT.run(...t);

// Sequences SEC-01..NU-06 (slide 27)
const sequences = [
  ['SEC-01', 'Security audit', 'BFSI, healthcare, SaaS, compliance-triggered', 5, 16, 'Book a 20-minute scope call', 'Reply, meeting, opt-out, disqualification'],
  ['MIT-02', 'Managed IT', 'Operations, finance, 50-300 staff', 5, 18, 'Book a managed IT review', 'Reply, meeting, existing client match'],
  ['CLD-03', 'Cloud review', 'CTO / engineering, cloud spend signal', 4, 14, 'Book a cloud cost review', 'Reply, meeting, no cloud footprint'],
  ['ODC-04', 'Offshore capacity', 'GCC / product engineering leaders', 4, 21, 'Book an ODC scoping call', 'Reply, meeting, geography mismatch'],
  ['RE-05', 'Referral ask', 'Closed-won clients, 30 days post-delivery', 2, 7, 'Introduce one peer', 'Referral received or no response'],
  ['NU-06', 'Nurture', 'Closed-lost / not-now, consented', 1, 0, 'Download the security checklist', 'Re-engagement or unsubscribe'],
];
const insS = db.prepare('INSERT OR IGNORE INTO sequence (code, name, audience, steps, duration_days, primary_cta, exit_criteria) VALUES (?,?,?,?,?,?,?)');
for (const s of sequences) insS.run(...s);
// Steps: SEC-01 uses E1(d0), E2(d3), E3(d7), E6-ish(d12), E5(d16)
const seqSteps = [
  ['SEC-01', 1, 0, 'E1'], ['SEC-01', 2, 3, 'E2'], ['SEC-01', 3, 7, 'E3'], ['SEC-01', 4, 12, 'E6'], ['SEC-01', 5, 16, 'E5'],
  ['MIT-02', 1, 0, 'E4'], ['MIT-02', 2, 4, 'E2'], ['MIT-02', 3, 9, 'E3'], ['MIT-02', 4, 13, 'E6'], ['MIT-02', 5, 18, 'E5'],
];
const insSS = db.prepare(`INSERT OR IGNORE INTO sequence_step (sequence_id, step_no, delay_days, template_id)
  SELECT s.id, ?, ?, t.id FROM sequence s, email_template t WHERE s.code=? AND t.code=?`);
for (const st of seqSteps) insSS.run(st[1], st[2], st[0], st[3]);

// Workflow rulebook — 16 active rules (slide 30)
const rules = [
  ['R01', 'LEAD_CREATED', '{"tier":["A","B"],"owner_null":true}', 'ASSIGN_AND_NOTIFY', 0, 'System', 'Owner assigned'],
  ['R02', 'LEAD_CREATED', '{}', 'SEND_ACK', 1, 'System', 'Reply or booking'],
  ['R03', 'SEQUENCE_STEP_SENT', '{"no_reply":true}', 'SEND_NEXT_STEP', 0, 'System', 'Reply, bounce, opt-out, meeting'],
  ['R04', 'EMAIL_CLICKED', '{"no_reply":true}', 'CREATE_TASK', 60, 'Owner', 'Reply or meeting'],
  ['R05', 'MEETING_BOOKED', '{"confirmed":true}', 'STOP_SEQUENCES_AND_CONFIRM', 0, 'System', 'Meeting held'],
  ['R06', 'MEETING_HELD', '{"outcome":"interested"}', 'MOVE_TO_QUALIFIED_AND_PROPOSAL_TASK', 15, 'Rep', 'Stage updated'],
  ['R07', 'MEETING_NO_SHOW', '{"no_reschedule_10m":true}', 'REBOOK_AND_ALERT', 10, 'System', 'New booking'],
  ['R08', 'PROPOSAL_SENT', '{"no_view_3d":true}', 'FOLLOWUP_EMAIL_AND_CALL_TASK', 4320, 'Rep', 'Viewed or replied'],
  ['R09', 'PROPOSAL_OPEN_7D', '{"no_decision":true}', 'FOUNDER_ALERT', 10080, 'Founder', 'Decision or close-lost'],
  ['R10', 'DEAL_STALE', '{"days":14}', 'TASK_AND_MANAGER_ALERT', 0, 'System', 'Activity logged'],
  ['R11', 'DEAL_STALE', '{"days":21}', 'MOVE_TO_NURTURE', 0, 'System', 'Re-engaged'],
  ['R12', 'DEAL_STALE', '{"days":30}', 'AUTO_CLOSE_LOST', 0, 'System', 'Closed'],
  ['R13', 'CLOSED_WON', '{"signature":true}', 'ONBOARDING_SEQUENCE_AND_REFERRAL_TASK', 0, 'System', 'Kickoff done'],
  ['R14', 'CLOSED_LOST', '{"reason_logged":true}', 'NURTURE_AND_REFERRAL_ASK', 10080, 'Rep', 'Revisit or unsubscribe'],
  ['R15', 'LEAD_CREATED', '{"tier":"A"}', 'URGENT_NOTIFY', 0, 'System', 'First touch done'],
  ['R16', 'EMAIL_REPLIED', '{}', 'PAUSE_SEQUENCE_AND_TASK', 0, 'System', 'Contact made'],
];
const insR = db.prepare('INSERT OR IGNORE INTO workflow_rule (code, trigger, condition_json, action, delay_minutes, owner, stop_condition) VALUES (?,?,?,?,?,?,?)');
for (const r of rules) insR.run(...r);

// Rep availability: Mon-Fri 09:30-16:30 IST (04:00-11:00 UTC)
const insAv = db.prepare('INSERT OR IGNORE INTO availability (rep_id, day_of_week, start_time, end_time) VALUES (?,?,?,?)');
const reps = db.prepare("SELECT id FROM app_user WHERE role='Sales Rep'").all();
for (const rep of reps) for (let d = 1; d <= 5; d++) insAv.run(rep.id, d, '09:30', '16:30');

// Mailbox (outreach, warm-up state)
db.prepare('INSERT OR IGNORE INTO mailbox (address, sending_domain, daily_cap, warmup, status) VALUES (?,?,?,?,?)')
  .run('outreach@mail.infeara.local', 'mail.infeara.local', 30, 10, 'WARMING');

// Demo data: a few companies/leads so dashboards are not empty
const insCo = db.prepare('INSERT OR IGNORE INTO company (name, domain, industry, employee_band, revenue_band, city, segment) VALUES (?,?,?,?,?,?,?)');
insCo.run('Apex Textiles', 'apextextiles.in', 'Manufacturing', '200-500', '100-200 Cr', 'Chennai', 'A');
insCo.run('MediCare Diagnostics', 'medicaredx.in', 'Healthcare', '50-200', '10-50 Cr', 'Chennai', 'A');
insCo.run('FinEdge NBFC', 'finedge.in', 'BFSI', '200-500', '100-200 Cr', 'Chennai', 'A');

console.log('Seed complete.');
console.log('Logins (password for all: ChangeMe#2026):');
for (const u of users) console.log('  ' + u[0] + '  [' + u[3] + ']');
