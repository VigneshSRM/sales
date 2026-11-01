package com.infeara.revenue;

import java.util.*;

/** Server-rendered admin UI (blueprint: Thymeleaf-style server rendering, no SPA). */
public final class Views {
    public static String esc(Object s) {
        return String.valueOf(s == null ? "" : s).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;");
    }

    public static final ThreadLocal<String> SID = new ThreadLocal<>();
    private static String sfx() { String s = SID.get(); return s == null ? "" : "?sid=" + s; }
    private static String nav(String label, String href) { String s = SID.get(); return "<a href=\"" + href + (s == null ? "" : "?sid=" + s) + "\">" + label + "</a>"; }
    public static String page(String title, String body, Map<String, Object> user) {
        String f = sfx();
        String nav = user == null ? "" : "<nav>" +
                nav("Cockpit","/app") + nav("Leads","/app/leads") + nav("Pipeline","/app/pipeline") +
                nav("Tasks","/app/tasks") + nav("Sequences","/app/sequences") + nav("Bookings","/app/bookings") +
                nav("Reports","/app/reports") + nav("Audit","/app/audit") + nav("Settings","/app/settings") +

                "<span class=\"who\">" + esc(user.get("full_name")) + " (" + esc(user.get("role")) + ")</span>" +
                "<a href=\"/auth/logout\">Logout</a></nav>";
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + esc(title) + " — Sales Pipeline Autopilot</title>" +
                "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>" +
                ":root{--bg:#0b1f1c;--panel:#10312b;--ink:#e8f2ef;--mut:#8fb3aa;--acc:#2fbf8f;--line:#1e4a40}" +
                "*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}" +
                "a{color:var(--acc);text-decoration:none}nav{display:flex;gap:14px;align-items:center;padding:10px 18px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}" +
                "nav .who{margin-left:auto;color:var(--mut)}main{padding:20px;max-width:1200px;margin:0 auto}" +
                ".card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}" +
                "table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}" +
                "th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}" +
                "input,select,textarea{background:#0a2620;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px;width:100%}" +
                "button,.btn{background:var(--acc);color:#04231a;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;display:inline-block}" +
                ".btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}" +
                "label{display:block;color:var(--mut);font-size:12px;margin:10px 0 3px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}" +
                ".pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;font-weight:600}" +
                ".tA{background:#3ddc97;color:#04231a}.tB{background:#ffd166;color:#4a3200}.tC{background:#8ecae6;color:#08304a}.tD{background:#5a6b67;color:#dfe}" +
                ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}" +
                ".stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.stat b{font-size:24px;display:block}.stat span{color:var(--mut);font-size:12px}" +
                ".mut{color:var(--mut)}.small{font-size:12px}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:180px}" +
                "</style></head><body>" + nav + "<main>" + body + "</main></body></html>";
    }

    public static String pill(String tier) {
        return "<span class=\"pill t" + esc(tier) + "\">" + esc(tier) + "</span>";
    }
}
