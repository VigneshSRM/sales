package com.infeara.revenue;

import java.util.*;

/** Reference data, templates, sequences, rules and seed users (blueprint Appendix A/B). */
public final class Seed {
    public static void run(Db db) {
        if (!db.all("app_user").isEmpty()) return;
        String[][] users = {
            {"admin@infeara.local", "Admin", "Full Admin", "Admin", "1"},
            {"founder@infeara.local", "Founder", "Owner", "Admin", "1"},
            {"sales.manager@infeara.local", "Sales Manager", "Chen", "Sales Manager", "1"},
            {"rep1@infeara.local", "Rep One", "Kumar", "Sales Rep", "0"},
            {"rep2@infeara.local", "Rep Two", "Priya", "Sales Rep", "0"},
            {"sdr@infeara.local", "SDR", "Research", "SDR", "0"},
            {"delivery@infeara.local", "Delivery Lead", "Ops", "Delivery Lead", "0"},
            {"viewer@infeara.local", "Viewer", "Readonly", "Read-only", "0"},
        };
        for (String[] u : users) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("email", u[0]);
            r.put("password_hash", Db.sha256("autopilot:" + "ChangeMe#2026"));
            r.put("full_name", u[1] + " " + u[2]);
            r.put("role", u[3]);
            r.put("mfa_enabled", Long.parseLong(u[4]));
            r.put("active", 1L);
            db.insert("app_user", r);
        }
        String[][] settings = {
            {"app.timezone", "Asia/Kolkata"}, {"app.currency", "INR"},
            {"booking.working_hours", "Mon-Fri 09:30-16:30 IST"}, {"booking.buffer_min", "15"},
            {"booking.daily_cap", "6"}, {"booking.lead_time_hours", "4"}, {"booking.horizon_days", "20"},
            {"booking.lunch_block", "13:00-14:00 IST"}, {"email.volume_cap_per_mailbox_day", "30"},
            {"email.quiet_hours", "20:00-08:00 IST"}, {"scoring.max", "100"},
        };
        for (String[] s : settings) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("key", s[0]); r.put("value", s[1]);
            db.insert("app_setting", r);
        }
        String[][] flags = {
            {"capture.public", "1", "Public lead form endpoint"},
            {"email.sending", "0", "Outbound SMTP (enable after SPF/DKIM/DMARC verified)"},
            {"email.imap", "0", "Reply detection and bounce processing"},
            {"booking.public", "1", "Tokenised booking page"},
            {"workflow.enrolment", "1", "Automatic sequence enrolment"},
            {"proposal.tracking", "0", "Proposal view notifications"},
            {"export.csv", "1", "Audit-logged CSV export"},
            {"pilot.mode", "1", "Restrict dashboards to pilot users"},
        };
        for (String[] f : flags) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("key", f[0]); r.put("enabled", Long.parseLong(f[1])); r.put("purpose", f[2]);
            db.insert("feature_flag", r);
        }
        String[][] templates = {
            {"E1", "Security audit — first touch", "BFSI / healthcare / SaaS", "A quick question about your audit readiness", "One specific observation -> one sentence on risk -> 2-week health check -> low-friction question", "20-minute scope call"},
            {"E2", "Security audit — value follow-up", "Non-responders, day 3", "The three findings we see most often", "Three anonymised findings -> what they cost -> checklist link", "Download the checklist"},
            {"E3", "Security audit — proof", "Engaged, day 7", "How a Chennai manufacturer closed 14 audit findings", "Outcome story -> what we did -> what it means for them", "Case study + call"},
            {"E4", "Managed IT review", "Operations / finance", "Who answers at 2 AM?", "Downtime cost framing -> SLA and escalation -> 30-minute review", "Book a review"},
            {"E5", "Break-up / permission to close", "Day 16 non-responders", "Should I close your file?", "Short, polite, no guilt -> permission to close", "Reply 'later' or 'close'"},
            {"E6", "Proposal follow-up", "Proposal sent, no reply", "One question on the proposal", "Reference the proposal -> ask the one unblocking question -> 15-minute call", "15-minute call"},
            {"E7", "Meeting confirmation", "Booked lead", "Confirmed: {date} at {time} IST", "Agenda, attendees, what to prepare, join link, reschedule policy", "Add to calendar (ICS)"},
            {"E8", "No-show rebook", "No-show", "Sorry we missed you", "No guilt -> two alternative slots -> one question", "Rebook"},
        };
        for (String[] t : templates) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("code", t[0]); r.put("name", t[1]); r.put("audience", t[2]);
            r.put("subject", t[3]); r.put("body_outline", t[4]); r.put("cta", t[5]);
            r.put("version", 1L); r.put("active", 1L);
            db.insert("email_template", r);
        }
        String[][] seqs = {
            {"SEC-01", "Security audit", "BFSI, healthcare, SaaS, compliance-triggered", "5", "16", "Book a 20-minute scope call", "Reply, meeting, opt-out, disqualification"},
            {"MIT-02", "Managed IT", "Operations, finance, 50-300 staff", "5", "18", "Book a managed IT review", "Reply, meeting, existing client match"},
            {"CLD-03", "Cloud review", "CTO / engineering, cloud spend signal", "4", "14", "Book a cloud cost review", "Reply, meeting, no cloud footprint"},
            {"ODC-04", "Offshore capacity", "GCC / product engineering leaders", "4", "21", "Book an ODC scoping call", "Reply, meeting, geography mismatch"},
            {"RE-05", "Referral ask", "Closed-won clients, 30 days post-delivery", "2", "7", "Introduce one peer", "Referral received or no response"},
            {"NU-06", "Nurture", "Closed-lost / not-now, consented", "1", "0", "Download the security checklist", "Re-engagement or unsubscribe"},
        };
        Map<String, Object> seqIds = new HashMap<>();
        for (String[] s : seqs) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("code", s[0]); r.put("name", s[1]); r.put("audience", s[2]);
            r.put("steps", Long.parseLong(s[3])); r.put("duration_days", Long.parseLong(s[4]));
            r.put("primary_cta", s[5]); r.put("exit_criteria", s[6]); r.put("active", 1L);
            db.insert("sequence", r);
            seqIds.put(s[0], r.get("id"));
        }
        String[][] steps = {
            {"SEC-01", "1", "0", "E1"}, {"SEC-01", "2", "3", "E2"}, {"SEC-01", "3", "7", "E3"}, {"SEC-01", "4", "12", "E6"}, {"SEC-01", "5", "16", "E5"},
            {"MIT-02", "1", "0", "E4"}, {"MIT-02", "2", "4", "E2"}, {"MIT-02", "3", "9", "E3"}, {"MIT-02", "4", "13", "E6"}, {"MIT-02", "5", "18", "E5"},
        };
        for (String[] st : steps) {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("sequence_id", seqIds.get(st[0]));
            r.put("step_no", Long.parseLong(st[1]));
            r.put("delay_days", Long.parseLong(st[2]));
            r.put("template_id", db.find("email_template", "code", st[3]).get("id"));
            db.insert("sequence_step", r);
        }
        String[][] rules = {
            {"R01", "LEAD_CREATED", "{\"tier\":[\"A\",\"B\"],\"owner_null\":true}", "ASSIGN_AND_NOTIFY", "0", "System", "Owner assigned"},
            {"R02", "LEAD_CREATED", "{}", "SEND_ACK", "1", "System", "Reply or booking"},
            {"R03", "SEQUENCE_STEP_SENT", "{\"no_reply\":true}", "SEND_NEXT_STEP", "0", "System", "Reply, bounce, opt-out, meeting"},
            {"R04", "EMAIL_CLICKED", "{\"no_reply\":true}", "CREATE_TASK", "60", "Owner", "Reply or meeting"},
            {"R05", "MEETING_BOOKED", "{\"confirmed\":true}", "STOP_SEQUENCES_AND_CONFIRM", "0", "System", "Meeting held"},
            {"R06", "MEETING_HELD", "{\"outcome\":\"interested\"}", "MOVE_TO_QUALIFIED_AND_PROPOSAL_TASK", "15", "Rep", "Stage updated"},
            {"R07", "MEETING_NO_SHOW", "{\"no_reschedule_10m\":true}", "REBOOK_AND_ALERT", "10", "System", "New booking"},
            {"R08", "PROPOSAL_SENT", "{\"no_view_3d\":true}", "FOLLOWUP_EMAIL_AND_CALL_TASK", "4320", "Rep", "Viewed or replied"},
            {"R09", "PROPOSAL_OPEN_7D", "{\"no_decision\":true}", "FOUNDER_ALERT", "10080", "Founder", "Decision or close-lost"},
            {"R10", "DEAL_STALE", "{\"days\":14}", "TASK_AND_MANAGER_ALERT", "0", "System", "Activity logged"},
            {"R11", "DEAL_STALE", "{\"days\":21}", "MOVE_TO_NURTURE", "0", "System", "Re-engaged"},
            {"R12", "DEAL_STALE", "{\"days\":30}", "AUTO_CLOSE_LOST", "0", "System", "Closed"},
            {"R13", "CLOSED_WON", "{\"signature\":true}", "ONBOARDING_SEQUENCE_AND_REFERRAL_TASK", "0", "System", "Kickoff done"},
            {"R14", "CLOSED_LOST", "{\"reason_logged\":true}", "NURTURE_AND_REFERRAL_ASK", "10080", "Rep", "Revisit or unsubscribe"},
            {"R15", "LEAD_CREATED", "{\"tier\":\"A\"}", "URGENT_NOTIFY", "0", "System", "First touch done"},
            {"R16", "EMAIL_REPLIED", "{}", "PAUSE_SEQUENCE_AND_TASK", "0", "System", "Contact made"},
        };
        for (String[] r : rules) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("code", r[0]); m.put("trigger", r[1]); m.put("condition_json", r[2]);
            m.put("action", r[3]); m.put("delay_minutes", Long.parseLong(r[4]));
            m.put("owner", r[5]); m.put("stop_condition", r[6]); m.put("active", 1L); m.put("version", 1L);
            db.insert("workflow_rule", m);
        }
        for (Map<String, Object> u : db.all("app_user"))
            if ("Sales Rep".equals(u.get("role")))
                for (int d = 1; d <= 5; d++) {
                    Map<String, Object> a = new LinkedHashMap<>();
                    a.put("rep_id", u.get("id")); a.put("day_of_week", (long) d);
                    a.put("start_time", "09:30"); a.put("end_time", "16:30"); a.put("active", 1L);
                    db.insert("availability", a);
                }
        Map<String, Object> mb = new LinkedHashMap<>();
        mb.put("address", "outreach@mail.infeara.local"); mb.put("sending_domain", "mail.infeara.local");
        mb.put("daily_cap", 30L); mb.put("warmup", 10L); mb.put("status", "WARMING");
        db.insert("mailbox", mb);
        System.out.println("Seed complete. Logins (password ChangeMe#2026): admin@, founder@, sales.manager@, rep1@, rep2@, sdr@, delivery@, viewer@ — all @infeara.local");
    }
}
