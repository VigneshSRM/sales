package com.infeara.revenue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Sales Pipeline Autopilot — HTTP layer (modular monolith, blueprint §36-41).
 * Public capture + booking, authenticated /api/v1/* (blueprint §24), admin UI.
 */
public final class Server {
    final Db db;
    final Map<String, Map<String, Object>> sessions = new ConcurrentHashMap<>();
    static final Map<String, Integer> SLOT_MIN = new LinkedHashMap<>();
    static {
        SLOT_MIN.put("Security review", 20); SLOT_MIN.put("Managed IT review", 30);
        SLOT_MIN.put("Cloud cost review", 30); SLOT_MIN.put("Automation workshop", 45);
        SLOT_MIN.put("ODC scoping call", 45); SLOT_MIN.put("Discovery call", 30);
    }
    static final String[] STAGES = {"CAPTURED", "ENGAGED", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "ONBOARDING", "NURTURE", "LOST"};

    public Server(Db db) { this.db = db; }

    public void start(int port) throws IOException {
        HttpServer s = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
        s.createContext("/", this::dispatch);
        s.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(8));
        s.start();
        System.out.println("Sales Pipeline Autopilot (Java 17) running at http://localhost:" + port);
    }

    // ---------------- plumbing ----------------
    private Map<String, Object> user(HttpExchange x) {
        String c = x.getRequestHeaders().getFirst("Cookie");
        if (c == null) return null;
        for (String p : c.split(";")) {
            String[] kv = p.trim().split("=", 2);
            if (kv.length == 2 && kv[0].equals("sid")) return sessions.get(kv[1]);
        }
        return null;
    }

    private static Map<String, String> form(HttpExchange x) throws IOException {
        Map<String, String> m = new LinkedHashMap<>();
        String b = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        for (String p : b.split("&")) {
            String[] kv = p.split("=", 2);
            m.put(kv[0], kv.length > 1 ? java.net.URLDecoder.decode(kv[1], java.nio.charset.StandardCharsets.UTF_8) : "");
        }
        return m;
    }

    private static Map<String, String> query(HttpExchange x) {
        Map<String, String> m = new LinkedHashMap<>();
        String q = x.getRequestURI().getRawQuery();
        if (q == null) return m;
        for (String p : q.split("&")) {
            String[] kv = p.split("=", 2);
            m.put(kv[0], kv.length > 1 ? java.net.URLDecoder.decode(kv[1], java.nio.charset.StandardCharsets.UTF_8) : "");
        }
        return m;
    }

    private static void json(HttpExchange x, int code, Object body) throws IOException {
        byte[] b = Json.write(body).getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        x.sendResponseHeaders(code, b.length);
        try (OutputStream os = x.getResponseBody()) { os.write(b); }
        return;
    }

    private static void html(HttpExchange x, int code, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
        x.sendResponseHeaders(code, b.length);
        try (OutputStream os = x.getResponseBody()) { os.write(b); }
        return;
    }

    private static void redirect(HttpExchange x, String to) throws IOException {
        x.getResponseHeaders().set("Location", to);
        x.sendResponseHeaders(302, -1);
        x.close();
        return;
    }

    private static Map<String, Object> err(String code, String msg) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code); m.put("message", msg);
        return m;
    }

    // ---------------- dispatch ----------------
    private void dispatch(HttpExchange x) throws IOException {
        try {
            String path = x.getRequestURI().getPath();
            String method = x.getRequestMethod();
            Map<String, Object> u = user(x);
            if (path.equals("/health")) { json(x, 200, Map.of("status", "UP", "runtime", "java-17", "datastore", "local-file")); return; }
            if (path.equals("/auth/login") && method.equals("GET")) { html(x, 200, loginPage()); return; }
            if (path.equals("/auth/login") && method.equals("POST")) { doLogin(x); return; }
            if (path.equals("/auth/logout")) { sessions.remove(String.valueOf(x.getRequestHeaders().getFirst("Cookie"))); redirect(x, "/auth/login"); return; }
            if (path.equals("/")) { html(x, 200, landingPage()); return; }
            if (path.equals("/book")) { html(x, 200, bookingPage(query(x))); return; }
            if (path.equals("/api/v1/public/leads") && method.equals("POST")) { capture(x); return; }
            if (path.equals("/api/v1/public/services")) { json(x, 200, Map.of("services", List.of("VAPT", "Managed IT", "Cloud", "Network", "Automation", "ODC"))); return; }
            if (path.equals("/api/v1/public/booking/availability")) { availability(x); return; }
            if (path.equals("/api/v1/public/booking") && method.equals("POST")) { book(x); return; }
            if (path.startsWith("/api/v1/public/meetings/") && path.endsWith("/ics")) { ics(x, path); return; }
            if (path.equals("/api/v1/public/unsubscribe") && method.equals("POST")) { unsubscribe(x); return; }
            if (path.startsWith("/api/v1/")) { api(x, u, method, path); return; }
            if (path.startsWith("/app")) { app(x, u, path); return; }
            json(x, 404, err("NOT_FOUND", "No route"));
        } catch (Exception e) {
            e.printStackTrace();
            json(x, 500, err("INTERNAL", String.valueOf(e.getMessage())));
        }
    }

    // ---------------- auth ----------------
    private String loginPage() {
        return Views.page("Login", "<div class=\"card\" style=\"max-width:380px;margin:60px auto\">" +
                "<h1>Sales Pipeline Autopilot</h1><p class=\"mut\">Infeara Revenue OS · local-first · Java 17</p>" +
                "<form method=\"post\" action=\"/auth/login\">" +
                "<label>Email</label><input name=\"email\" required placeholder=\"rep1@infeara.local\">" +
                "<label>Password</label><input name=\"password\" type=\"password\" required placeholder=\"ChangeMe#2026\">" +
                "<div style=\"margin-top:14px\"><button>Sign in</button></div></form>" +
                "<p class=\"small mut\">Seed users: admin@ / founder@ / sales.manager@ / rep1@ / rep2@ / sdr@ / delivery@ / viewer@ (.local), password <code>ChangeMe#2026</code>.</p></div>", null);
    }

    private void doLogin(HttpExchange x) throws IOException {
        Map<String, String> f = form(x);
        Map<String, Object> u = db.find("app_user", "email", f.getOrDefault("email", "").toLowerCase());
        String hash = Db.sha256("autopilot:" + f.getOrDefault("password", ""));
        if (u == null || !hash.equals(u.get("password_hash")) || !Objects.equals(u.get("active"), 1L)) {
            db.audit("anonymous", "LOGIN_FAILED", "app_user", u == null ? null : u.get("id"));
            html(x, 401, Views.page("Login", "<div class=\"card\">Invalid credentials. <a href=\"/auth/login\">Try again</a></div>", null));
            return;
        }
        String sid = UUID.randomUUID().toString().replace("-", "");
        sessions.put(sid, u);
        db.audit(String.valueOf(u.get("email")), "LOGIN", "app_user", u.get("id"));
        x.getResponseHeaders().set("Set-Cookie", "sid=" + sid + "; HttpOnly; SameSite=Lax; Path=/");
        redirect(x, "/app");
        return;
    }

    // ---------------- public pages ----------------
    private String landingPage() {
        StringBuilder svcs = new StringBuilder();
        for (String s : new String[]{"VAPT", "Managed IT", "Cloud", "Network", "Automation", "ODC"}) svcs.append("<option>").append(s).append("</option>");
        return Views.page("Book a conversation", "<div class=\"card\" style=\"max-width:560px;margin:40px auto\">" +
                "<h1>Talk to Infeara about security, managed IT, cloud or automation</h1>" +
                "<p class=\"mut\">Chennai · remote-first · 24/7 support · 99.9% uptime SLA. Every enquiry is answered within 60 seconds.</p>" +
                "<form method=\"post\" action=\"/api/v1/public/leads\">" +
                "<input type=\"text\" name=\"company_website\" style=\"position:absolute;left:-9999px\" tabindex=\"-1\" autocomplete=\"off\">" +
                "<div class=\"row\"><div><label>Full name *</label><input name=\"full_name\" required></div>" +
                "<div><label>Business email *</label><input name=\"email\" type=\"email\" required></div></div>" +
                "<div class=\"row\"><div><label>Phone</label><input name=\"phone\"></div><div><label>Company *</label><input name=\"company\" required></div></div>" +
                "<div class=\"row\"><div><label>Service interest *</label><select name=\"service\">" + svcs + "</select></div>" +
                "<div><label>Team size</label><select name=\"team_size\"><option>1-50</option><option>50-200</option><option>200-500</option><option>500+</option></select></div></div>" +
                "<label>What prompted you to reach out?</label><textarea name=\"message\" rows=\"3\"></textarea>" +
                "<label style=\"display:flex;gap:8px;align-items:center;color:var(--ink)\"><input type=\"checkbox\" name=\"consent\" value=\"true\" required style=\"width:auto\"> I agree to be contacted about my enquiry (DPDP Act 2023 notice v1.0). *</label>" +
                "<div style=\"margin-top:14px\"><button>Request a call</button></div></form>" +
                "<p class=\"mut\" style=\"margin-top:18px\"><a href=\"/auth/login\">Team sign in →</a></p></div>", null);
    }

    private String bookingPage(Map<String, String> q) {
        StringBuilder types = new StringBuilder();
        for (String t : SLOT_MIN.keySet()) types.append("<option>").append(t).append("</option>");
        return Views.page("Book a meeting", "<div class=\"card\" style=\"max-width:640px;margin:30px auto\">" +
                "<h1>Book a conversation</h1><p class=\"mut\">Self-serve scheduling — real availability, instant confirmation with calendar invite.</p>" +
                "<div class=\"row\"><div><label>Conversation type</label><select id=\"type\">" + types + "</select></div></div>" +
                "<button class=\"btn\" onclick=\"loadSlots()\">Show available slots</button><div id=\"slots\"></div>" +
                "<form id=\"bookForm\" style=\"display:none;margin-top:14px\">" +
                "<input type=\"hidden\" id=\"start_at_utc\"><input type=\"hidden\" id=\"lead_id\" value=\"" + Views.esc(q.get("lead")) + "\">" +
                "<div class=\"row\"><div><label>Full name *</label><input id=\"full_name\"></div><div><label>Business email *</label><input id=\"email\" type=\"email\"></div></div>" +
                "<label style=\"display:flex;gap:8px;align-items:center;color:var(--ink)\"><input type=\"checkbox\" id=\"consent\" style=\"width:auto\"> I agree to the booking terms and privacy notice. *</label>" +
                "<div style=\"margin-top:12px\"><button class=\"btn\">Confirm booking</button></div></form></div>" +
                "<script>async function loadSlots(){const t=document.getElementById('type').value;" +
                "const r=await fetch('/api/v1/public/booking/availability?service='+encodeURIComponent(t));const j=await r.json();" +
                "document.getElementById('slots').innerHTML='<table><tr><th>Slot (IST)</th><th></th></tr>'+j.slots.map(s=>'<tr><td>'+s.start_ist+'</td><td><button class=\"btn ghost\" onclick=\"pick(\\'\"+s.start_at_utc+\"\\')\">Pick</button></td></tr>').join('')+'</table>';}" +
                "function pick(s){document.getElementById('start_at_utc').value=s;document.getElementById('bookForm').style.display='block';}" +
                "document.getElementById('bookForm').addEventListener('submit',async e=>{e.preventDefault();" +
                "const r=await fetch('/api/v1/public/booking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:document.getElementById('type').value,start_at_utc:document.getElementById('start_at_utc').value,lead_id:document.getElementById('lead_id').value||null,full_name:document.getElementById('full_name').value,email:document.getElementById('email').value,consent:document.getElementById('consent').checked})});" +
                "const j=await r.json();alert(j.code==='BOOKED'?'Booked! Calendar invite: '+location.origin+j.ics:'Error: '+j.message);});</script>", null);
    }

    // ---------------- public API: capture ----------------
    private void capture(HttpExchange x) throws IOException {
        String raw = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Map<String, Object> b;
        String ct = String.valueOf(x.getRequestHeaders().getFirst("Content-Type"));
        if (ct.contains("application/x-www-form-urlencoded")) {
            b = new LinkedHashMap<>();
            for (String p : raw.split("&")) {
                String[] kv = p.split("=", 2);
                b.put(kv[0], kv.length > 1 ? java.net.URLDecoder.decode(kv[1], StandardCharsets.UTF_8) : "");
            }
            b.put("consent", "on".equals(b.get("consent")) || "true".equalsIgnoreCase(String.valueOf(b.get("consent"))) || Boolean.TRUE.equals(b.get("consent")));
        } else {
            b = Json.parseObject(raw);
        }
        String trace = UUID.randomUUID().toString();
        Map<String, Object> cr = new LinkedHashMap<>();
        cr.put("payload", Json.write(b)); cr.put("validation", "RECEIVED"); cr.put("trace_id", trace);
        db.insert("capture_request", cr);
        if (b.get("company_website") != null && !String.valueOf(b.get("company_website")).isEmpty())
            { json(x, 400, err("SPAM", "Rejected")); return; }
        String name = str(b.get("full_name")), email = str(b.get("email")).toLowerCase(),
                company = str(b.get("company")), service = str(b.get("service"));
        if (name.isEmpty() || email.isEmpty() || company.isEmpty() || service.isEmpty())
            { json(x, 400, err("VALIDATION_ERROR", "full_name, email, company and service are required")); return; }
        if (!Boolean.TRUE.equals(b.get("consent")))
            { json(x, 422, err("CONSENT_REQUIRED", "Explicit consent is required (DPDP Act 2023)")); return; }
        if (!email.matches("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"))
            { json(x, 400, err("VALIDATION_ERROR", "Invalid business email")); return; }
        String eh = Db.hashEmail(email);
        if (db.find("suppression", "email_hash", eh) != null)
            { json(x, 410, err("UNSUBSCRIBED", "This address has opted out")); return; }

        String domain = email.contains("@") ? email.substring(email.indexOf('@') + 1) : "";
        Map<String, Object> contact = db.find("contact", "email_hash", eh);
        Map<String, Object> companyRow = db.find("company", "domain", domain);
        if (companyRow == null) {
            companyRow = new LinkedHashMap<>();
            companyRow.put("name", company); companyRow.put("domain", domain); companyRow.put("city", "Chennai");
            db.insert("company", companyRow);
        }
        if (contact == null) {
            contact = new LinkedHashMap<>();
            contact.put("company_id", companyRow.get("id"));
            contact.put("full_name", name);
            contact.put("email_hash", eh);
            contact.put("phone_hash", b.get("phone") == null ? null : Db.hashEmail(str(b.get("phone"))));
            contact.put("status", "ACTIVE");
            db.insert("contact", contact);
            Map<String, Object> consent = new LinkedHashMap<>();
            consent.put("contact_id", contact.get("id"));
            consent.put("purpose", "marketing_email");
            consent.put("notice_text", "DPDP Act 2023 notice v1.0 — contact about my enquiry");
            consent.put("policy_version", "v1.0");
            consent.put("lawful_basis", "explicit_consent");
            consent.put("source", "website_form");
            db.insert("consent_record", consent);
        }
        Map<String, Object> existing = db.find("lead", "contact_id", contact.get("id"));
        if (existing != null) {
            Map<String, Object> touch = new LinkedHashMap<>();
            touch.put("lead_id", existing.get("id")); touch.put("source", "website"); touch.put("landing_page", "/");
            db.insert("lead_source_touch", touch);
            db.audit("system", "LEAD_MERGED", "lead", existing.get("id"));
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("code", "CAPTURED"); resp.put("trace_id", trace); resp.put("lead_id", existing.get("id"));
            resp.put("merged", true); resp.put("booking_link", "/book?lead=" + existing.get("id"));
            json(x, 202, resp); return;
        }
        Map<String, String> signals = new HashMap<>();
        signals.put("budget", str(b.get("team_size")).matches(".*\\d{3,}.*") ? "approved" : "small");
        signals.put("authority", "champion");
        signals.put("need", str(b.get("message")).isEmpty() ? "aware" : "active");
        signals.put("timeline", "quarter");
        signals.put("engagement", "opened");
        Map<String, Object> sc = Scoring.score(signals);
        String tier = String.valueOf(sc.get("tier"));
        Object ownerId = Scoring.routeLead(db, service, tier);
        Map<String, Object> lead = new LinkedHashMap<>();
        lead.put("contact_id", contact.get("id"));
        lead.put("company_id", companyRow.get("id"));
        lead.put("source", "website");
        lead.put("service", service);
        lead.put("score", ((Number) sc.get("score")).longValue());
        lead.put("score_breakdown", sc.get("breakdown"));
        lead.put("tier", tier);
        lead.put("status", "NEW");
        lead.put("owner_id", ownerId);
        db.insert("lead", lead);
        Map<String, Object> touch = new LinkedHashMap<>();
        touch.put("lead_id", lead.get("id")); touch.put("source", "website"); touch.put("landing_page", "/");
        touch.put("utm", b.get("utm"));
        db.insert("lead_source_touch", touch);
        // 60-second auto-response via outbox (written in the same logical transaction)
        Integer sla = Scoring.SLA_MINUTES.get(tier);
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("contact_id", contact.get("id"));
        msg.put("template_code", "A-ACK");
        msg.put("from_address", "outreach@mail.infeara.local");
        msg.put("subject", "Thanks " + name.split(" ")[0] + " — your " + service + " enquiry is in");
        msg.put("body_text", "We received your enquiry. Book a slot directly: /book?lead=" + lead.get("id")
                + "\nWhat happens next: a rep will call within " + (sla != null ? sla + " minutes" : "24 hours") + ".");
        msg.put("status", "QUEUED");
        msg.put("scheduled_at", Db.now());
        db.insert("email_message", msg);
        if (ownerId != null && sla != null) {
            Workflow.createTask(db, "First call", "Tier " + tier + " lead (score " + sc.get("score") + "). First touch SLA " + sla + " min.",
                    Instant.now().plusSeconds(sla * 60L).toString(), "HIGH", ownerId, null, "lead", lead.get("id"));
        }
        db.audit("system", "LEAD_CAPTURED", "lead", lead.get("id"));
        Map<String, Object> ctx = new HashMap<>();
        ctx.put("leadId", lead.get("id")); ctx.put("contactId", contact.get("id"));
        ctx.put("tier", tier); ctx.put("score", sc.get("score"));
        ctx.put("routedTo", ownerId); ctx.put("entityType", "lead");
        Workflow.evaluate(db, "LEAD_CREATED", ctx);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("code", "CAPTURED"); resp.put("trace_id", trace); resp.put("lead_id", lead.get("id"));
        resp.put("score", sc.get("score")); resp.put("tier", tier);
        resp.put("booking_link", "/book?lead=" + lead.get("id"));
        json(x, 202, resp);
        return;
    }

    // ---------------- public API: booking ----------------
    private Object firstRep() {
        for (Map<String, Object> u : db.all("app_user"))
            if ("Sales Rep".equals(u.get("role")) && Objects.equals(u.get("active"), 1L)) return u.get("id");
        return null;
    }

    private void availability(HttpExchange x) throws IOException {
        String type = query(x).getOrDefault("service", "Discovery call");
        if (!SLOT_MIN.containsKey(type)) type = "Discovery call";
        Object repId = firstRep();
        int durMin = SLOT_MIN.get(type);
        Set<String> booked = new HashSet<>(), held = new HashSet<>();
        for (Map<String, Object> m : db.query("meeting", "rep_id", repId))
            if ("ACTIVE".equals(m.get("status"))) booked.add(String.valueOf(m.get("start_at_utc")));
        for (Map<String, Object> s : db.query("meeting_slot", "rep_id", repId))
            if ("HELD".equals(s.get("status"))) held.add(String.valueOf(s.get("starts_at_utc")));
        List<Map<String, Object>> slots = new ArrayList<>();
        Instant now = Instant.now();
        for (int day = 1; day <= 40 && slots.size() < 40; day++) {
            java.time.LocalDate d = java.time.LocalDate.now(java.time.ZoneOffset.UTC).plusDays(day);
            java.time.DayOfWeek dow = d.getDayOfWeek();
            if (dow == java.time.DayOfWeek.SATURDAY || dow == java.time.DayOfWeek.SUNDAY) continue;
            long dayCount = db.all("meeting").stream().filter(m -> "ACTIVE".equals(m.get("status"))
                    && String.valueOf(m.get("start_at_utc")).startsWith(d.toString())).count();
            if (dayCount >= 6) continue;
            for (int mins = 570; mins + durMin <= 990; mins += 30) { // 09:30–16:30 IST
                if (mins >= 780 && mins < 840) continue; // lunch 13:00-14:00 IST
                int utcMins = mins - 330; // IST = UTC+5:30
                Instant start = Instant.parse(d + "T" + String.format("%02d:%02d:00Z", utcMins / 60, utcMins % 60));
                if (start.isBefore(now.plusSeconds(4 * 3600))) continue; // 4h lead time
                String key = start.toString();
                if (booked.contains(key) || held.contains(key)) continue;
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("start_at_utc", key);
                s.put("start_ist", d + " " + String.format("%02d:%02d IST", mins / 60, mins % 60));
                slots.add(s);
                if (slots.size() >= 40) break;
            }
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("service", type); resp.put("duration_min", durMin); resp.put("slots", slots);
        json(x, 200, resp);
    }

    private void book(HttpExchange x) throws IOException {
        Map<String, Object> b = Json.parseObject(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        String type = str(b.get("type"));
        if (!SLOT_MIN.containsKey(type)) type = "Discovery call";
        int durMin = SLOT_MIN.get(type);
        Instant start;
        try { start = Instant.parse(str(b.get("start_at_utc"))); } catch (Exception e) {
            json(x, 400, err("VALIDATION_ERROR", "Invalid slot")); return;
        }
        if (start.isBefore(Instant.now())) { json(x, 400, err("VALIDATION_ERROR", "Invalid slot")); return; }
        if (!Boolean.TRUE.equals(b.get("consent"))) { json(x, 422, err("CONSENT_REQUIRED", "Booking-terms consent required")); return; }
        Object repId = firstRep();
        Instant end = start.plusSeconds(durMin * 60L);
        // double-booking prevention: unique (rep_id, start_at_utc) for ACTIVE meetings
        for (Map<String, Object> m : db.query("meeting", "rep_id", repId))
            if ("ACTIVE".equals(m.get("status")) && String.valueOf(m.get("start_at_utc")).equals(start.toString()))
                { json(x, 409, err("SLOT_TAKEN", "Slot just booked — pick another")); return; }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("lead_id", b.get("lead_id"));
        m.put("rep_id", repId);
        m.put("type", type);
        m.put("start_at_utc", start.toString());
        m.put("end_at_utc", end.toString());
        m.put("timezone", "Asia/Kolkata");
        m.put("status", "ACTIVE");
        m.put("booked_via", "public_page");
        db.insert("meeting", m);
        Object leadId = b.get("lead_id");
        if (leadId != null) {
            Map<String, Object> lead = db.find("lead", "id", leadId);
            if (lead != null) db.update("lead", lead, Collections.singletonMap("status", "ENGAGED"));
            Map<String, Object> ctx = new HashMap<>();
            ctx.put("meetingId", m.get("id")); ctx.put("ownerId", repId); ctx.put("entityType", "meeting");
            if (lead != null) ctx.put("contactId", lead.get("contact_id"));
            Workflow.evaluate(db, "MEETING_BOOKED", ctx);
        }
        db.audit("public", "MEETING_BOOKED", "meeting", m.get("id"));
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("code", "BOOKED"); resp.put("meeting_id", m.get("id"));
        resp.put("ics", "/api/v1/public/meetings/" + m.get("id") + "/ics");
        json(x, 201, resp);
        return;
    }

    private void ics(HttpExchange x, String path) throws IOException {
        String id = path.split("/")[5];
        Map<String, Object> m = db.find("meeting", "id", Long.parseLong(id));
        if (m == null) { x.sendResponseHeaders(404, -1); x.close(); return; }
        String ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:meeting-" + m.get("id") + "@infeara.local\r\n" +
                "DTSTART:" + String.valueOf(m.get("start_at_utc")).replace("-", "").replace(":", "") + "\r\n" +
                "DTEND:" + String.valueOf(m.get("end_at_utc")).replace("-", "").replace(":", "") + "\r\n" +
                "SUMMARY:" + Views.esc(m.get("type")) + " — Infeara\r\nDESCRIPTION:Agenda and join details follow by email.\r\nEND:VEVENT\r\nEND:VCALENDAR";
        byte[] b = ics.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().set("Content-Type", "text/calendar");
        x.sendResponseHeaders(200, b.length);
        try (OutputStream os = x.getResponseBody()) { os.write(b); }
        return;
    }

    private void unsubscribe(HttpExchange x) throws IOException {
        Map<String, Object> b = Json.parseObject(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        String secret = System.getenv().getOrDefault("PII_ENCRYPTION_KEY", "local-dev-key");
        String email;
        try {
            email = new String(java.util.Base64.getUrlDecoder().decode(str(b.get("token"))), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) { json(x, 400, err("VALIDATION_ERROR", "Bad token")); return; }
        String sig = Db.sha256(email + secret);
        if (!sig.equals(str(b.get("sig")))) { json(x, 400, err("VALIDATION_ERROR", "Bad token")); return; }
        String eh = Db.hashEmail(email);
        if (db.find("suppression", "email_hash", eh) == null) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("email_hash", eh); s.put("reason", "unsubscribe");
            db.insert("suppression", s);
        }
        for (Map<String, Object> c : db.all("contact"))
            if (eh.equals(c.get("email_hash")))
                for (Map<String, Object> cr : db.query("consent_record", "contact_id", c.get("id")))
                    if (cr.get("withdrawn_at") == null)
                        db.update("consent_record", cr, Collections.singletonMap("withdrawn_at", Db.now()));
        db.audit("public", "CONSENT_WITHDRAWN", "contact", null);
        json(x, 200, Map.of("code", "UNSUBSCRIBED", "message", "Suppressed across all sequences within 24h"));
        return;
    }

    private static String str(Object o) { return o == null ? "" : String.valueOf(o); }

    // ---------------- authenticated API ----------------
    private void api(HttpExchange x, Map<String, Object> u, String method, String path) throws IOException {
        if (u == null) { json(x, 401, err("UNAUTHENTICATED", "Login required")); return; }
        String role = String.valueOf(u.get("role"));
        boolean admin = role.equals("Admin"), mgr = role.equals("Sales Manager"), rep = role.equals("Sales Rep");
        Map<String, Object> body = method.equals("GET") ? new LinkedHashMap<>()
                : Json.parseObject(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        String[] parts = path.split("/");

        if (path.equals("/api/v1/leads") && method.equals("GET")) {
            List<Map<String, Object>> out = new ArrayList<>();
            Map<String, String> q = query(x);
            for (Map<String, Object> l : db.all("lead")) {
                Map<String, Object> c = db.find("contact", "id", l.get("contact_id"));
                Map<String, Object> co = db.find("company", "id", l.get("company_id"));
                Map<String, Object> ow = l.get("owner_id") == null ? null : db.find("app_user", "id", l.get("owner_id"));
                if (q.containsKey("tier") && !q.get("tier").equals(l.get("tier"))) continue;
                if (q.containsKey("q")) {
                    String needle = q.get("q").toLowerCase();
                    String hay = (c == null ? "" : str(c.get("full_name")) + str(co == null ? "" : co.get("name"))).toLowerCase();
                    if (!hay.contains(needle)) continue;
                }
                Map<String, Object> row = new LinkedHashMap<>(l);
                row.put("full_name", c == null ? null : c.get("full_name"));
                row.put("company_name", co == null ? null : co.get("name"));
                row.put("owner_name", ow == null ? null : ow.get("full_name"));
                out.add(row);
            }
            out.sort((a, b2) -> Long.compare(num(b2.get("score")), num(a.get("score"))));
            json(x, 200, out); return;
        }
        if (path.equals("/api/v1/leads") && method.equals("POST") && (rep || mgr || admin)) {
            String email = str(body.get("email")).toLowerCase();
            if (email.isEmpty() || str(body.get("full_name")).isEmpty() || str(body.get("source")).isEmpty())
                { json(x, 400, err("VALIDATION_ERROR", "email, full_name, source required")); return; }
            String eh = Db.hashEmail(email);
            if (db.find("suppression", "email_hash", eh) != null) { json(x, 410, err("UNSUBSCRIBED", "Opted out")); return; }
            Map<String, Object> co = new LinkedHashMap<>(); co.put("name", str(body.get("company"))); db.insert("company", co);
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("company_id", co.get("id")); c.put("full_name", body.get("full_name")); c.put("email_hash", eh);
            db.insert("contact", c);
            Map<String, Object> sc = Scoring.score(Map.of("need", "aware", "engagement", "none"));
            String tier = String.valueOf(sc.get("tier"));
            Object owner = Scoring.routeLead(db, str(body.get("service")), tier);
            Map<String, Object> l = new LinkedHashMap<>();
            l.put("contact_id", c.get("id")); l.put("company_id", co.get("id"));
            l.put("source", body.get("source")); l.put("service", body.get("service"));
            l.put("score", sc.get("score")); l.put("score_breakdown", sc.get("breakdown"));
            l.put("tier", tier); l.put("status", "NEW"); l.put("owner_id", owner);
            db.insert("lead", l);
            db.audit(str(u.get("email")), "LEAD_CREATED_MANUAL", "lead", l.get("id"));
            json(x, 201, Map.of("id", l.get("id"), "score", sc.get("score"), "tier", tier)); return;
        }
        if (parts.length == 4 && parts[3].matches("\\d+") && path.startsWith("/api/v1/leads/")) {
            long id = Long.parseLong(parts[3]);
            Map<String, Object> lead = db.find("lead", "id", id);
            if (lead == null) { json(x, 404, err("NOT_FOUND", "lead")); return; }
            if (method.equals("GET")) {
                Map<String, Object> c = db.find("contact", "id", lead.get("contact_id"));
                Map<String, Object> co = db.find("company", "id", lead.get("company_id"));
                Map<String, Object> row = new LinkedHashMap<>(lead);
                row.put("full_name", c == null ? null : c.get("full_name"));
                row.put("company_name", co == null ? null : co.get("name"));
                row.put("timeline", db.query("activity", "entity_id", id));
                json(x, 200, row); return;
            }
            if (method.equals("PATCH") && (rep || mgr || admin)) {
                Map<String, Object> patch = new LinkedHashMap<>();
                if (body.get("owner_id") != null) patch.put("owner_id", body.get("owner_id"));
                if (body.get("status") != null) patch.put("status", body.get("status"));
                if (body.get("tier") != null) {
                    if (body.get("override_reason") == null) { json(x, 400, err("VALIDATION_ERROR", "Score override requires a reason")); return; }
                    patch.put("tier", body.get("tier"));
                }
                db.update("lead", lead, patch);
                db.audit(str(u.get("email")), "LEAD_UPDATED", "lead", id);
                json(x, 200, Map.of("ok", true)); return;
            }
        }
        if (path.matches("/api/v1/leads/\\d+/convert") && method.equals("POST") && (rep || mgr || admin)) {
            long id = Long.parseLong(path.split("/")[4]);
            Map<String, Object> lead = db.find("lead", "id", id);
            if (lead == null) { json(x, 404, err("NOT_FOUND", "lead")); return; }
            if (db.find("deal", "lead_id", id) != null) { json(x, 409, err("DUPLICATE_LEAD", "Deal already exists")); return; }
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("company_id", lead.get("company_id")); d.put("lead_id", id);
            d.put("name", str(lead.get("service")) + " — lead " + id); d.put("service", lead.get("service"));
            d.put("stage", "QUALIFIED"); d.put("owner_id", lead.get("owner_id"));
            db.insert("deal", d);
            Map<String, Object> h = new LinkedHashMap<>();
            h.put("deal_id", d.get("id")); h.put("from_stage", null); h.put("to_stage", "QUALIFIED"); h.put("changed_by", u.get("email"));
            db.insert("deal_stage_history", h);
            db.update("lead", lead, Collections.singletonMap("status", "QUALIFIED"));
            db.audit(str(u.get("email")), "LEAD_CONVERTED", "deal", d.get("id"));
            json(x, 201, Map.of("deal_id", d.get("id"))); return;
        }
        if (path.equals("/api/v1/deals") && method.equals("GET")) { json(x, 200, db.all("deal")); return; }
        if (path.matches("/api/v1/deals/\\d+/stage") && method.equals("PATCH") && (rep || mgr || admin)) {
            long id = Long.parseLong(path.split("/")[4]);
            Map<String, Object> d = db.find("deal", "id", id);
            if (d == null) { json(x, 404, err("NOT_FOUND", "deal")); return; }
            String to = str(body.get("stage")).toUpperCase();
            if (!Arrays.asList(STAGES).contains(to)) { json(x, 400, err("VALIDATION_ERROR", "Unknown stage")); return; }
            if (to.equals("PROPOSAL") && !Boolean.TRUE.equals(body.get("proposal_sent")))
                { json(x, 409, err("SLA_BREACH", "Required artefact missing: proposal_sent")); return; }
            if (to.equals("LOST") && str(body.get("lost_reason")).isEmpty())
                { json(x, 409, err("SLA_BREACH", "Closed-lost requires a mandatory reason")); return; }
            Map<String, Object> patch = new LinkedHashMap<>();
            patch.put("stage", to);
            if (body.get("amount") != null) patch.put("amount", body.get("amount"));
            if (to.equals("WON")) patch.put("probability", 1.0);
            if (to.equals("LOST")) patch.put("probability", 0.0);
            db.update("deal", d, patch);
            Map<String, Object> h = new LinkedHashMap<>();
            h.put("deal_id", id); h.put("from_stage", d.get("stage")); h.put("to_stage", to);
            h.put("changed_by", u.get("email"));
            h.put("note", to.equals("LOST") ? body.get("lost_reason") : body.get("note"));
            db.insert("deal_stage_history", h);
            db.audit(str(u.get("email")), "DEAL_STAGE_CHANGED", "deal", id);
            if (to.equals("WON")) { Map<String, Object> c = new HashMap<>(); c.put("dealId", id); c.put("ownerId", d.get("owner_id")); c.put("entityType", "deal"); Workflow.evaluate(db, "CLOSED_WON", c); }
            json(x, 200, Map.of("ok", true)); return;
        }
        if (path.equals("/api/v1/activities") && method.equals("POST")) {
            Map<String, Object> a = new LinkedHashMap<>();
            a.put("type", body.get("type")); a.put("subject", body.get("subject")); a.put("body", body.get("body"));
            a.put("owner_id", u.get("id")); a.put("entity_type", body.get("entity_type")); a.put("entity_id", body.get("entity_id"));
            db.insert("activity", a);
            db.audit(str(u.get("email")), "ACTIVITY_LOGGED", str(body.get("entity_type")), body.get("entity_id"));
            json(x, 201, Map.of("id", a.get("id"))); return;
        }
        if (path.equals("/api/v1/tasks") && method.equals("GET")) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Map<String, Object> t : db.all("task"))
                if ("OPEN".equals(t.get("status")) && (query(x).get("mine") == null || Objects.equals(t.get("owner_id"), u.get("id")))) out.add(t);
            json(x, 200, out); return;
        }
        if (path.matches("/api/v1/tasks/\\d+") && method.equals("PATCH")) {
            Map<String, Object> t = db.find("task", "id", Long.parseLong(parts[3]));
            if (t == null) { json(x, 404, err("NOT_FOUND", "task")); return; }
            if (body.get("status") != null) db.update("task", t, Collections.singletonMap("status", body.get("status")));
            db.audit(str(u.get("email")), "TASK_UPDATED", "task", t.get("id"));
            json(x, 200, Map.of("ok", true)); return;
        }
        if (path.equals("/api/v1/sequences") && method.equals("GET")) { json(x, 200, db.all("sequence")); return; }
        if (path.equals("/api/v1/enrollments") && method.equals("POST") && (rep || mgr || admin)) {
            Object contactId = body.get("contact_id");
            Map<String, Object> seq = db.find("sequence", "code", body.get("sequence_code"));
            if (seq == null) { json(x, 404, err("VALIDATION_ERROR", "unknown sequence")); return; }
            Map<String, Object> c = db.find("contact", "id", contactId);
            if (c == null || db.find("suppression", "email_hash", c.get("email_hash")) != null)
                { json(x, 410, err("UNSUBSCRIBED", "Opted out")); return; }
            boolean hasConsent = false;
            for (Map<String, Object> cr : db.query("consent_record", "contact_id", contactId))
                if (cr.get("withdrawn_at") == null) hasConsent = true;
            if (!hasConsent) { json(x, 422, err("CONSENT_REQUIRED", "No lawful basis recorded")); return; }
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("contact_id", contactId); e.put("sequence_id", seq.get("id"));
            e.put("current_step", 0L); e.put("status", "ACTIVE");
            e.put("next_send_at", Instant.now().plusSeconds(86400).toString());
            db.insert("enrollment", e);
            db.audit(str(u.get("email")), "ENROLLMENT_CREATED", "enrollment", e.get("id"));
            json(x, 201, Map.of("id", e.get("id"))); return;
        }
        if (path.equals("/api/v1/meetings") && method.equals("GET")) { json(x, 200, db.all("meeting")); return; }
        if (path.matches("/api/v1/meetings/\\d+/outcome") && method.equals("POST")) {
            long id = Long.parseLong(path.split("/")[4]);
            Map<String, Object> m = db.find("meeting", "id", id);
            if (m == null) { json(x, 404, err("NOT_FOUND", "meeting")); return; }
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("meeting_id", id); o.put("outcome", body.get("outcome")); o.put("notes", body.get("notes")); o.put("next_step", body.get("next_step"));
            db.insert("meeting_outcome", o);
            Map<String, Object> deal = db.find("deal", "lead_id", m.get("lead_id"));
            if ("interested".equals(body.get("outcome")) && deal != null) {
                Map<String, Object> c = new HashMap<>();
                c.put("meetingId", id); c.put("dealId", deal.get("id")); c.put("ownerId", m.get("rep_id"));
                c.put("outcome", "interested"); c.put("entityType", "meeting");
                Workflow.evaluate(db, "MEETING_HELD", c);
            }
            db.audit(str(u.get("email")), "MEETING_OUTCOME", "meeting", id);
            json(x, 200, Map.of("ok", true)); return;
        }
        if (path.equals("/api/v1/reports/funnel")) {
            List<Map<String, Object>> funnel = new ArrayList<>();
            for (String s : new String[]{"CAPTURED", "ENGAGED", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON"}) {
                Map<String, Object> f = new LinkedHashMap<>();
                f.put("stage", s);
                f.put("deals", db.query("deal", "stage", s).size());
                double v = 0;
                for (Map<String, Object> d : db.query("deal", "stage", s))
                    try { v += Double.parseDouble(str(d.get("amount"))); } catch (Exception ignored) {}
                f.put("value", v);
                funnel.add(f);
            }
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("funnel", funnel);
            resp.put("leads_total", db.all("lead").size());
            resp.put("meetings_booked", db.all("meeting").size());
            resp.put("generated_at", Instant.now().toString());
            json(x, 200, resp); return;
        }
        if (path.equals("/api/v1/reports/forecast")) {
            Map<String, Double> w = Map.of("CAPTURED", 0.05, "ENGAGED", 0.2, "QUALIFIED", 0.3, "PROPOSAL", 0.64, "NEGOTIATION", 0.85);
            double weighted = 0, pipeline = 0;
            for (Map<String, Object> d : db.all("deal")) {
                String st = str(d.get("stage"));
                if (st.equals("WON") || st.equals("LOST") || st.equals("NURTURE")) continue;
                double amt = 0;
                try { amt = Double.parseDouble(str(d.get("amount"))); } catch (Exception ignored) {}
                pipeline += amt;
                weighted += amt * w.getOrDefault(st, 0.1);
            }
            json(x, 200, Map.of("open_pipeline", pipeline, "weighted_forecast", Math.round(weighted))); return;
        }
        if (path.equals("/api/v1/audit") && (admin || role.equals("Read-only"))) { json(x, 200, db.all("audit_log")); return; }
        if (path.equals("/api/v1/exports") && method.equals("POST") && (mgr || admin)) {
            StringBuilder csv = new StringBuilder("id,name,company,source,service,tier,score,status,created_at\n");
            for (Map<String, Object> l : db.all("lead")) {
                Map<String, Object> c = db.find("contact", "id", l.get("contact_id"));
                Map<String, Object> co = db.find("company", "id", l.get("company_id"));
                csv.append(String.join(",", q(l.get("id")), q(c == null ? "" : c.get("full_name")), q(co == null ? "" : co.get("name")),
                        q(l.get("source")), q(l.get("service")), q(l.get("tier")), q(l.get("score")), q(l.get("status")), q(l.get("created_at")))).append("\n");
            }
            Map<String, Object> j = new LinkedHashMap<>();
            j.put("requested_by", u.get("email")); j.put("kind", str(body.getOrDefault("kind", "leads")));
            j.put("status", "DONE"); j.put("row_count", (long) db.all("lead").size());
            db.insert("export_job", j);
            db.audit(str(u.get("email")), "EXPORT_CSV", "export_job", j.get("id"));
            byte[] b = csv.toString().getBytes(StandardCharsets.UTF_8);
            x.getResponseHeaders().set("Content-Type", "text/csv");
            x.sendResponseHeaders(200, b.length);
            try (OutputStream os = x.getResponseBody()) { os.write(b); }
            return;
        }
        if (path.equals("/api/v1/notifications")) { json(x, 200, db.query("notification", "user_id", u.get("id"))); return; }
        if (path.equals("/api/v1/settings") && admin) {
            json(x, 200, Map.of("settings", db.all("app_setting"), "flags", db.all("feature_flag"))); return;
        }
        if (path.matches("/api/v1/settings/flags/[^/]+") && method.equals("PATCH") && admin) {
            Map<String, Object> f = db.find("feature_flag", "key", parts[5]);
            if (f != null) db.update("feature_flag", f, Collections.singletonMap("enabled", Boolean.TRUE.equals(body.get("enabled")) ? 1L : 0L));
            db.audit(str(u.get("email")), "FEATURE_FLAG_CHANGED", "feature_flag", null);
            json(x, 200, Map.of("ok", true)); return;
        }
        json(x, 404, err("NOT_FOUND", "No route"));
    }

    private static String q(Object o) { return "\"" + str(o).replace("\"", "\"\"") + "\""; }
    private static long num(Object o) { return o instanceof Number ? ((Number) o).longValue() : 0; }

    // ---------------- admin pages ----------------
    private void app(HttpExchange x, Map<String, Object> u, String path) throws IOException {
        if (u == null) { redirect(x, "/auth/login"); return; }
        String role = String.valueOf(u.get("role"));
        if (path.equals("/app") || path.equals("/app/")) {
            long myTasks = db.all("task").stream().filter(t -> "OPEN".equals(t.get("status")) && Objects.equals(t.get("owner_id"), u.get("id"))).count();
            long newLeads = db.all("lead").stream().filter(l -> String.valueOf(l.get("created_at")).compareTo(Instant.now().minusSeconds(7 * 86400L).toString()) > 0).count();
            long meetings = db.all("meeting").size();
            long alerts = db.query("notification", "user_id", u.get("id")).stream().filter(n -> Objects.equals(n.get("read"), 0L)).count();
            double pipeline = 0;
            for (Map<String, Object> d : db.all("deal")) {
                String st = str(d.get("stage"));
                if (!st.equals("WON") && !st.equals("LOST") && !st.equals("NURTURE"))
                    try { pipeline += Double.parseDouble(str(d.get("amount"))); } catch (Exception ignored) {}
            }
            StringBuilder taskRows = new StringBuilder();
            for (Map<String, Object> t : db.all("task"))
                if ("OPEN".equals(t.get("status")) && Objects.equals(t.get("owner_id"), u.get("id")))
                    taskRows.append("<tr><td>").append(Views.esc(t.get("title"))).append("</td><td class=\"mut\">").append(Views.esc(t.get("due_at"))).append("</td><td>").append(Views.esc(t.get("priority"))).append("</td></tr>");
            html(x, 200, Views.page("Manager cockpit",
                    "<h1>Manager cockpit</h1><p class=\"mut\">The numbers that matter this week — from the same datastore as the operational screens.</p>" +
                    "<div class=\"grid\">" +
                    "<div class=\"stat\"><b>" + newLeads + "</b><span>New leads (7d)</span></div>" +
                    "<div class=\"stat\"><b>₹" + (long) pipeline + "</b><span>Open pipeline</span></div>" +
                    "<div class=\"stat\"><b>" + meetings + "</b><span>Meetings booked</span></div>" +
                    "<div class=\"stat\"><b>" + myTasks + "</b><span>My open tasks</span></div>" +
                    "<div class=\"stat\"><b>" + alerts + "</b><span>Unread alerts</span></div></div>" +
                    "<div class=\"card\"><h2>My open tasks</h2><table><tr><th>Task</th><th>Due</th><th>Priority</th></tr>" +
                    (taskRows.length() == 0 ? "<tr><td colspan=\"3\" class=\"mut\">Nothing due — the autopilot is on it.</td></tr>" : taskRows) + "</table></div>", u));
            return;
        }
        if (path.equals("/app/leads")) {
            StringBuilder rows = new StringBuilder();
            List<Map<String, Object>> leads = new ArrayList<>(db.all("lead"));
            leads.sort((a, b) -> Long.compare(num(b.get("score")), num(a.get("score"))));
            for (Map<String, Object> l : leads) {
                Map<String, Object> c = db.find("contact", "id", l.get("contact_id"));
                Map<String, Object> co = db.find("company", "id", l.get("company_id"));
                Map<String, Object> ow = l.get("owner_id") == null ? null : db.find("app_user", "id", l.get("owner_id"));
                rows.append("<tr><td>").append(Views.esc(c == null ? "" : c.get("full_name"))).append("</td><td>").append(Views.esc(co == null ? "" : co.get("name")))
                        .append("</td><td>").append(Views.esc(l.get("service"))).append("</td><td>").append(Views.pill(str(l.get("tier"))))
                        .append("</td><td>").append(Views.esc(l.get("score"))).append("</td><td>").append(Views.esc(ow == null ? "—" : ow.get("full_name")))
                        .append("</td><td>").append(Views.esc(l.get("status"))).append("</td><td><a href=\"/app/leads/").append(l.get("id")).append("\">Open</a></td></tr>");
            }
            html(x, 200, Views.page("Lead inbox", "<h1>Lead inbox</h1><div class=\"card\"><table><tr><th>Lead</th><th>Company</th><th>Service</th><th>Tier</th><th>Score</th><th>Owner</th><th>Status</th><th></th></tr>" + rows + "</table></div>", u));
            return;
        }
        if (path.matches("/app/leads/\\d+")) {
            Map<String, Object> l = db.find("lead", "id", Long.parseLong(path.split("/")[3]));
            if (l == null) { html(x, 404, Views.page("404", "Not found", u)); return; }
            Map<String, Object> c = db.find("contact", "id", l.get("contact_id"));
            Map<String, Object> co = db.find("company", "id", l.get("company_id"));
            StringBuilder acts = new StringBuilder();
            for (Map<String, Object> a : db.query("activity", "entity_id", l.get("id")))
                acts.append("<p class=\"small\"><b>").append(Views.esc(a.get("type"))).append("</b> ").append(Views.esc(a.get("subject"))).append(" <span class=\"mut\">").append(Views.esc(a.get("created_at"))).append("</span></p>");
            StringBuilder tasks = new StringBuilder();
            for (Map<String, Object> t : db.query("task", "entity_id", l.get("id")))
                tasks.append("<p class=\"small\">").append(Views.esc(t.get("title"))).append(" — ").append(Views.esc(t.get("status"))).append("</p>");
            html(x, 200, Views.page("Lead " + l.get("id"),
                    "<h1>" + Views.esc(c == null ? "" : c.get("full_name")) + " " + Views.pill(str(l.get("tier"))) + "</h1>" +
                    "<p class=\"mut\">" + Views.esc(co == null ? "" : co.get("name")) + " · " + Views.esc(l.get("service")) + " · source " + Views.esc(l.get("source")) + " · status " + Views.esc(l.get("status")) + "</p>" +
                    "<div class=\"card\"><h2>Score breakdown (explainable)</h2><pre class=\"small\">" + Views.esc(l.get("score_breakdown")) + "</pre>" +
                    "<p class=\"small mut\">Total " + Views.esc(l.get("score")) + "/100. Overrides require a mandatory reason.</p></div>" +
                    "<div class=\"row\"><div class=\"card\"><h2>Activities</h2>" + (acts.length() == 0 ? "<p class=\"mut small\">None yet</p>" : acts) + "</div>" +
                    "<div class=\"card\"><h2>Tasks</h2>" + (tasks.length() == 0 ? "<p class=\"mut small\">None</p>" : tasks) + "</div></div>", u));
            return;
        }
        if (path.equals("/app/pipeline")) {
            StringBuilder cols = new StringBuilder();
            for (String s : STAGES) {
                List<Map<String, Object>> deals = db.query("deal", "stage", s);
                cols.append("<div class=\"card\" style=\"min-width:200px\"><h2>").append(s).append(" (").append(deals.size()).append(")</h2>");
                for (Map<String, Object> d : deals)
                    cols.append("<p class=\"small\"><b>").append(Views.esc(d.get("name"))).append("</b><br>₹").append(Views.esc(d.get("amount"))).append("</p>");
                cols.append("</div>");
            }
            html(x, 200, Views.page("Pipeline board", "<h1>Pipeline board</h1><div class=\"row\">" + cols + "</div>", u));
            return;
        }
        if (path.equals("/app/tasks")) {
            StringBuilder rows = new StringBuilder();
            for (Map<String, Object> t : db.all("task"))
                if ("OPEN".equals(t.get("status")))
                    rows.append("<tr><td>").append(Views.esc(t.get("title"))).append("</td><td class=\"mut\">").append(Views.esc(t.get("due_at"))).append("</td><td>").append(Views.esc(t.get("priority"))).append("</td></tr>");
            html(x, 200, Views.page("Tasks", "<h1>Task queue</h1><div class=\"card\"><table><tr><th>Task</th><th>Due</th><th>Priority</th></tr>" + rows + "</table></div>", u));
            return;
        }
        if (path.equals("/app/sequences")) {
            StringBuilder rows = new StringBuilder();
            for (Map<String, Object> s : db.all("sequence")) {
                long active = db.query("enrollment", "sequence_id", s.get("id")).stream().filter(e -> "ACTIVE".equals(e.get("status"))).count();
                rows.append("<tr><td>").append(Views.esc(s.get("code"))).append("</td><td>").append(Views.esc(s.get("name"))).append("</td><td>").append(Views.esc(s.get("steps")))
                        .append("</td><td>").append(Views.esc(s.get("duration_days"))).append("d</td><td>").append(active).append("</td><td class=\"mut small\">").append(Views.esc(s.get("exit_criteria"))).append("</td></tr>");
            }
            html(x, 200, Views.page("Sequences", "<h1>Email sequences</h1><div class=\"card\"><table><tr><th>Code</th><th>Name</th><th>Steps</th><th>Duration</th><th>Active</th><th>Exit criteria</th></tr>" + rows + "</table>" +
                    "<p class=\"small mut\">Guardrails: ≤30 emails/mailbox/day, send window 09:30-11:30 &amp; 15:00-17:30 IST Mon-Fri, opt-out honoured within 24h.</p></div>", u));
            return;
        }
        if (path.equals("/app/bookings")) {
            StringBuilder rows = new StringBuilder();
            for (Map<String, Object> m : db.all("meeting"))
                rows.append("<tr><td>").append(Views.esc(m.get("start_at_utc"))).append("</td><td>").append(Views.esc(m.get("type")))
                        .append("</td><td>").append(Views.esc(m.get("status"))).append("</td><td><a href=\"/api/v1/public/meetings/").append(m.get("id")).append("/ics\">ICS</a></td></tr>");
            html(x, 200, Views.page("Bookings", "<h1>Meetings</h1><div class=\"card\"><table><tr><th>Start (UTC)</th><th>Type</th><th>Status</th><th></th></tr>" + rows + "</table></div>", u));
            return;
        }
        if (path.equals("/app/reports")) {
            html(x, 200, Views.page("Reports", "<h1>Reports &amp; exports</h1><div class=\"card\"><h2>Funnel</h2><div id=\"r\">Loading…</div>" +
                    "<p><a class=\"btn\" href=\"/api/v1/exports\" onclick=\"return false\">Export leads CSV (audit-logged)</a></p></div>" +
                    "<script>fetch('/api/v1/reports/funnel').then(r=>r.json()).then(j=>{" +
                    "document.getElementById('r').innerHTML='<table><tr><th>Stage</th><th>Deals</th><th>Value</th></tr>'+j.funnel.map(f=>'<tr><td>'+f.stage+'</td><td>'+f.deals+'</td><td>₹'+f.value+'</td></tr>').join('')+'</table><p class=\"small mut\">Leads: '+j.leads_total+' · Meetings: '+j.meetings_booked+'</p>';});</script>", u));
            return;
        }
        if (path.equals("/app/audit") && (role.equals("Admin") || role.equals("Read-only"))) {
            StringBuilder rows = new StringBuilder();
            List<Map<String, Object>> logs = new ArrayList<>(db.all("audit_log"));
            logs.sort((a, b) -> Long.compare(num(b.get("id")), num(a.get("id"))));
            for (Map<String, Object> r : logs.subList(0, Math.min(100, logs.size())))
                rows.append("<tr><td class=\"mut small\">").append(Views.esc(r.get("occurred_at"))).append("</td><td>").append(Views.esc(r.get("actor")))
                        .append("</td><td>").append(Views.esc(r.get("action"))).append("</td><td>").append(Views.esc(r.get("entity_type"))).append("/").append(Views.esc(r.get("entity_id")))
                        .append("</td><td class=\"small mut\">").append(String.valueOf(r.get("after_hash")).substring(0, 12)).append("…</td></tr>");
            html(x, 200, Views.page("Audit log", "<h1>Audit log (append-only, hash-chained)</h1><div class=\"card\"><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Hash</th></tr>" + rows + "</table></div>", u));
            return;
        }
        if (path.equals("/app/settings") && role.equals("Admin")) {
            StringBuilder rows = new StringBuilder();
            for (Map<String, Object> f : db.all("feature_flag"))
                rows.append("<tr><td>").append(Views.esc(f.get("key"))).append("</td><td>").append(Objects.equals(f.get("enabled"), 1L) ? "ON" : "off")
                        .append("</td><td class=\"mut small\">").append(Views.esc(f.get("purpose"))).append("</td></tr>");
            html(x, 200, Views.page("Settings", "<h1>Feature flags (rollout gates)</h1><div class=\"card\"><table><tr><th>Flag</th><th>Enabled</th><th>Purpose</th></tr>" + rows + "</table></div>", u));
            return;
        }
        json(x, 403, err("FORBIDDEN", "Role lacks permission"));
    }
}
