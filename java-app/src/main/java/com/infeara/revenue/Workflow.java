package com.infeara.revenue;

import java.util.*;

/**
 * Workflow engine: the 16-rule follow-up rulebook lives as data (workflow_rule),
 * is evaluated on domain events, and every execution is logged (blueprint §30-31).
 */
public final class Workflow {
    public static boolean flagOn(Db db, String key) {
        Map<String, Object> f = db.find("feature_flag", "key", key);
        return f != null && Objects.equals(f.get("enabled"), 1L);
    }

    public static long createTask(Db db, String title, String desc, String dueAt, String priority,
                                  Object ownerId, Object ruleId, String entityType, Object entityId) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("title", title); t.put("description", desc); t.put("due_at", dueAt);
        t.put("priority", priority); t.put("status", "OPEN"); t.put("owner_id", ownerId);
        t.put("rule_id", ruleId); t.put("entity_type", entityType); t.put("entity_id", entityId);
        db.insert("task", t);
        return ((Number) t.get("id")).longValue();
    }

    private static String minutesFromNow(long m) {
        return java.time.Instant.now().plusSeconds(m * 60).toString();
    }

    /** Evaluate all active rules for a trigger. ctx carries event context. */
    public static void evaluate(Db db, String trigger, Map<String, Object> ctx) {
        for (Map<String, Object> rule : db.all("workflow_rule")) {
            if (!trigger.equals(rule.get("trigger")) || !Objects.equals(rule.get("active"), 1L)) continue;
            Map<String, Object> cond = Json.parseObject(String.valueOf(rule.get("condition_json")));
            Object tierC = cond.get("tier");
            boolean tierOk = tierC == null
                    || (tierC instanceof List && ((List<?>) tierC).contains(ctx.get("tier")))
                    || tierC.equals(ctx.get("tier"));
            Object daysC = cond.get("days");
            boolean daysOk = daysC == null || Objects.equals(((Number) daysC).intValue(), ctx.get("staleDays") instanceof Number ? ((Number) ctx.get("staleDays")).intValue() : -1);
            if (!tierOk || !daysOk) continue;
            Map<String, Object> ex = new LinkedHashMap<>();
            ex.put("rule_id", rule.get("id"));
            ex.put("entity_type", ctx.getOrDefault("entityType", "lead"));
            ex.put("entity_id", ctx.get("leadId") != null ? ctx.get("leadId") : ctx.getOrDefault("dealId", ctx.get("meetingId")));
            try {
                String action = String.valueOf(rule.get("action"));
                Object leadId = ctx.get("leadId"), dealId = ctx.get("dealId"), meetingId = ctx.get("meetingId");
                Object ownerId = ctx.get("ownerId") != null ? ctx.get("ownerId") : ctx.get("routedTo");
                switch (action) {
                    case "ASSIGN_AND_NOTIFY": {
                        if (ctx.get("ownerId") == null && ctx.get("routedTo") != null && leadId != null) {
                            Map<String, Object> lead = db.find("lead", "id", leadId);
                            db.update("lead", lead, Collections.singletonMap("owner_id", ctx.get("routedTo")));
                            db.notify(ctx.get("routedTo"), "NEW_LEAD", "New " + ctx.get("tier") + " lead assigned, score " + ctx.get("score"));
                        }
                        break;
                    }
                    case "URGENT_NOTIFY":
                        if (ownerId != null) db.notify(ownerId, "URGENT", "Tier A first touch SLA is 15 minutes");
                        break;
                    case "STOP_SEQUENCES_AND_CONFIRM": {
                        Object contactId = ctx.get("contactId");
                        for (Map<String, Object> e : db.query("enrollment", "contact_id", contactId))
                            if ("ACTIVE".equals(e.get("status"))) db.update("enrollment", e, Collections.singletonMap("status", "STOPPED"));
                        break;
                    }
                    case "MOVE_TO_QUALIFIED_AND_PROPOSAL_TASK": {
                        if (dealId != null) {
                            Map<String, Object> d = db.find("deal", "id", dealId);
                            Map<String, Object> h = new LinkedHashMap<>();
                            h.put("deal_id", dealId); h.put("from_stage", d.get("stage")); h.put("to_stage", "QUALIFIED");
                            h.put("changed_by", ctx.getOrDefault("actor", "system"));
                            db.insert("deal_stage_history", h);
                            db.update("deal", d, Collections.singletonMap("stage", "QUALIFIED"));
                            createTask(db, "Send proposal", "Discovery outcome = qualified. Prepare proposal from tier pricing.",
                                    minutesFromNow(2880), "HIGH", ownerId, rule.get("id"), "deal", dealId);
                        }
                        break;
                    }
                    case "REBOOK_AND_ALERT":
                        createTask(db, "Rebook no-show", "Send MEET-NOSHOW rebook link and log outcome",
                                minutesFromNow(10), "HIGH", ownerId, rule.get("id"), "meeting", meetingId);
                        for (Map<String, Object> u : db.all("app_user"))
                            if ("Sales Manager".equals(u.get("role"))) db.notify(u.get("id"), "NO_SHOW", "Meeting no-show recorded; rebook task created");
                        break;
                    case "TASK_AND_MANAGER_ALERT":
                        createTask(db, "Review stale deal", "No activity for " + ctx.get("staleDays") + " days",
                                minutesFromNow(1440), "MEDIUM", ownerId, rule.get("id"), "deal", dealId);
                        for (Map<String, Object> u : db.all("app_user"))
                            if ("Sales Manager".equals(u.get("role"))) db.notify(u.get("id"), "STALE_DEAL", "Deal " + dealId + " has no activity for " + ctx.get("staleDays") + " days");
                        break;
                    case "MOVE_TO_NURTURE": {
                        Map<String, Object> d = db.find("deal", "id", dealId);
                        Map<String, Object> h = new LinkedHashMap<>();
                        h.put("deal_id", dealId); h.put("from_stage", d.get("stage")); h.put("to_stage", "NURTURE");
                        h.put("changed_by", "system");
                        db.insert("deal_stage_history", h);
                        db.update("deal", d, Collections.singletonMap("stage", "NURTURE"));
                        break;
                    }
                    case "AUTO_CLOSE_LOST": {
                        Map<String, Object> d = db.find("deal", "id", dealId);
                        Map<String, Object> h = new LinkedHashMap<>();
                        h.put("deal_id", dealId); h.put("from_stage", d.get("stage")); h.put("to_stage", "LOST");
                        h.put("changed_by", "system");
                        h.put("note", "Auto closed-lost: 30 days no activity (mandatory reason rule)");
                        db.insert("deal_stage_history", h);
                        db.update("deal", d, Collections.singletonMap("stage", "LOST"));
                        break;
                    }
                    case "ONBOARDING_SEQUENCE_AND_REFERRAL_TASK":
                        createTask(db, "Referral ask", "Closed won: ask for one peer introduction in 30 days",
                                minutesFromNow(43200), "LOW", ownerId, rule.get("id"), "deal", dealId);
                        break;
                    case "PAUSE_SEQUENCE_AND_TASK": {
                        Object contactId = ctx.get("contactId");
                        for (Map<String, Object> e : db.query("enrollment", "contact_id", contactId))
                            if ("ACTIVE".equals(e.get("status"))) db.update("enrollment", e, Collections.singletonMap("status", "PAUSED"));
                        createTask(db, "Human reply received", "Reply detected — call the lead and log outcome",
                                minutesFromNow(60), "HIGH", ownerId, rule.get("id"), "lead", leadId);
                        break;
                    }
                    default: break;
                }
                ex.put("status", "OK");
            } catch (Exception e) {
                ex.put("status", "FAILED");
                ex.put("payload", String.valueOf(e.getMessage()));
            }
            ex.put("payload", ex.getOrDefault("payload", Json.write(ctx)));
            db.insert("workflow_execution", ex);
        }
    }

    /** The 14/21/30-day stale-deal sweep (blueprint §30). */
    public static void sweepStaleDeals(Db db) {
        for (Map<String, Object> d : db.all("deal")) {
            String stage = String.valueOf(d.get("stage"));
            if (stage.equals("WON") || stage.equals("LOST") || stage.equals("NURTURE")) continue;
            String lastChange = String.valueOf(d.get("created_at"));
            for (Map<String, Object> h : db.query("deal_stage_history", "deal_id", d.get("id")))
                lastChange = String.valueOf(h.get("changed_at"));
            long days = java.time.Duration.between(java.time.Instant.parse(lastChange.replace("Z", "Z").replace(" ", "T")), java.time.Instant.now()).toDays();
            Map<String, Object> ctx = new HashMap<>();
            ctx.put("dealId", d.get("id")); ctx.put("ownerId", d.get("owner_id"));
            ctx.put("staleDays", (int) days); ctx.put("entityType", "deal");
            if (days >= 30) evaluate(db, "DEAL_STALE", ctx);
            else if (days >= 21) { ctx.put("staleDays", 21); evaluate(db, "DEAL_STALE", ctx); }
            else if (days >= 14) { ctx.put("staleDays", 14); evaluate(db, "DEAL_STALE", ctx); }
        }
    }
}
