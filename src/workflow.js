// Workflow engine: the follow-up rulebook lives as data (workflow_rule table),
// is evaluated on domain events, and every execution is logged (slides 30-31).
const { db, audit, notify } = require('./db');

function logExec(ruleId, entityType, entityId, status, payload) {
  db.prepare('INSERT INTO workflow_execution (rule_id, entity_type, entity_id, status, payload) VALUES (?,?,?,?,?)')
    .run(ruleId, entityType, entityId, status, JSON.stringify(payload || {}));
}

function createTask(title, description, dueAt, priority, ownerId, ruleId, entityType, entityId) {
  const r = db.prepare(`INSERT INTO task (title, description, due_at, priority, status, owner_id, rule_id, entity_type, entity_id)
                        VALUES (?,?,?,'OPEN',?,?,?,?,?)`)
    .run(title, description, dueAt, priority, ownerId, ruleId, entityType, entityId);
  return r.lastInsertRowid;
}

const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString();

// Evaluate rules for a trigger. ctx carries the event context.
function evaluate(trigger, ctx) {
  const rules = db.prepare('SELECT * FROM workflow_rule WHERE trigger=? AND active=1').all(trigger);
  const flagOn = (k) => db.prepare('SELECT enabled FROM feature_flag WHERE key=?').get(k)?.enabled === 1;
  for (const rule of rules) {
    let cond = {};
    try { cond = JSON.parse(rule.condition_json || '{}'); } catch { continue; }
    const match =
      (cond.tier === undefined || (Array.isArray(cond.tier) ? cond.tier.includes(ctx.tier) : cond.tier === ctx.tier)) &&
      (cond.owner_null === undefined || (cond.owner_null ? !ctx.ownerId : !!ctx.ownerId)) &&
      (cond.days === undefined || ctx.staleDays === cond.days) &&
      (cond.outcome === undefined || cond.outcome === ctx.outcome);
    if (!match) continue;
    try {
      switch (rule.action) {
        case 'ASSIGN_AND_NOTIFY': {
          if (ctx.ownerId) break;
          const owner = ctx.routedTo;
          if (owner) {
            db.prepare('UPDATE lead SET owner_id=? WHERE id=?').run(owner, ctx.leadId);
            const u = db.prepare('SELECT email FROM app_user WHERE id=?').get(owner);
            notify(owner, 'NEW_LEAD', `New ${ctx.tier} lead assigned with score ${ctx.score}`);
            if (ctx.tier === 'A') notify(owner, 'URGENT', `URGENT: hot lead, call within 15 minutes`);
          }
          break;
        }
        case 'SEND_ACK': {
          if (!flagOn('email.sending')) break; // outbox row written by caller instead
          break;
        }
        case 'URGENT_NOTIFY':
          if (ctx.ownerId) notify(ctx.ownerId, 'URGENT', 'Tier A first touch SLA is 15 minutes');
          break;
        case 'STOP_SEQUENCES_AND_CONFIRM': {
          db.prepare("UPDATE enrollment SET status='STOPPED' WHERE contact_id=? AND status='ACTIVE'").run(ctx.contactId);
          break;
        }
        case 'MOVE_TO_QUALIFIED_AND_PROPOSAL_TASK': {
          if (ctx.dealId) {
            db.prepare("UPDATE deal SET stage='QUALIFIED' WHERE id=?").run(ctx.dealId);
            db.prepare("INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by) VALUES (?,?,?,?)")
              .run(ctx.dealId, ctx.fromStage, 'QUALIFIED', ctx.actor || 'system');
            createTask('Send proposal', 'Discovery outcome = qualified. Prepare proposal from tier pricing.', minutesFromNow(2880), 'HIGH', ctx.ownerId, rule.id, 'deal', ctx.dealId);
          }
          break;
        }
        case 'REBOOK_AND_ALERT': {
          createTask('Rebook no-show', 'Send MEET-NOSHOW rebook link and log outcome', minutesFromNow(10), 'HIGH', ctx.ownerId, rule.id, 'meeting', ctx.meetingId);
          const mgr = db.prepare("SELECT id FROM app_user WHERE role='Sales Manager'").get();
          if (mgr) notify(mgr.id, 'NO_SHOW', 'Meeting no-show recorded; rebook task created');
          break;
        }
        case 'TASK_AND_MANAGER_ALERT': {
          createTask('Review stale deal', `No activity for ${ctx.staleDays} days`, minutesFromNow(1440), 'MEDIUM', ctx.ownerId, rule.id, 'deal', ctx.dealId);
          const mgr = db.prepare("SELECT id FROM app_user WHERE role='Sales Manager'").get();
          if (mgr) notify(mgr.id, 'STALE_DEAL', `Deal ${ctx.dealId} has no activity for ${ctx.staleDays} days`);
          break;
        }
        case 'MOVE_TO_NURTURE': {
          db.prepare("UPDATE deal SET stage='NURTURE' WHERE id=?").run(ctx.dealId);
          db.prepare("INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by) VALUES (?,?,?,?)")
            .run(ctx.dealId, ctx.fromStage, 'NURTURE', 'system');
          db.prepare("UPDATE enrollment SET status='PAUSED' WHERE contact_id=(SELECT contact_id FROM lead WHERE id=(SELECT lead_id FROM deal WHERE id=?)) AND status='ACTIVE'").run(ctx.dealId);
          break;
        }
        case 'AUTO_CLOSE_LOST': {
          db.prepare("UPDATE deal SET stage='LOST' WHERE id=?").run(ctx.dealId);
          db.prepare("INSERT INTO deal_stage_history (deal_id, from_stage, to_stage, changed_by, note) VALUES (?,?,?,?,?)")
            .run(ctx.dealId, ctx.fromStage, 'LOST', 'system', 'Auto closed-lost: 30 days no activity (mandatory reason rule)');
          break;
        }
        case 'ONBOARDING_SEQUENCE_AND_REFERRAL_TASK':
          createTask('Referral ask', 'Closed won: ask for one peer introduction in 30 days', minutesFromNow(43200), 'LOW', ctx.ownerId, rule.id, 'deal', ctx.dealId);
          break;
        case 'PAUSE_SEQUENCE_AND_TASK': {
          db.prepare("UPDATE enrollment SET status='PAUSED' WHERE contact_id=? AND status='ACTIVE'").run(ctx.contactId);
          createTask('Human reply received', 'Reply detected — call the lead and log outcome', minutesFromNow(60), 'HIGH', ctx.ownerId, rule.id, 'lead', ctx.leadId);
          break;
        }
      }
      logExec(rule.id, ctx.entityType || 'lead', ctx.leadId || ctx.dealId || ctx.meetingId || 0, 'OK', ctx);
    } catch (e) {
      logExec(rule.id, ctx.entityType || 'lead', ctx.leadId || 0, 'FAILED', { error: e.message });
    }
  }
}

// Stale-deal sweep (14/21/30 rule) — run on demand and from the scheduler.
function sweepStaleDeals() {
  const rows = db.prepare(`SELECT d.id dealId, d.stage, d.owner_id ownerId, l.id leadId, l.contact_id contactId,
      CAST((julianday('now') - julianday(MAX(COALESCE(h.changed_at, d.created_at)))) AS INTEGER) staleDays
    FROM deal d LEFT JOIN lead l ON l.id = d.lead_id
    LEFT JOIN deal_stage_history h ON h.deal_id = d.id
    WHERE d.stage NOT IN ('WON','LOST','NURTURE') GROUP BY d.id`).all();
  for (const r of rows) {
    const fromStage = r.stage;
    if (r.staleDays >= 30) evaluate('DEAL_STALE', { dealId: r.dealId, staleDays: 30, ownerId: r.ownerId, leadId: r.leadId, contactId: r.contactId, fromStage });
    else if (r.staleDays >= 21) evaluate('DEAL_STALE', { dealId: r.dealId, staleDays: 21, ownerId: r.ownerId, leadId: r.leadId, contactId: r.contactId, fromStage });
    else if (r.staleDays >= 14) evaluate('DEAL_STALE', { dealId: r.dealId, staleDays: 14, ownerId: r.ownerId, leadId: r.leadId, contactId: r.contactId, fromStage });
  }
}

module.exports = { evaluate, sweepStaleDeals, createTask };
