package com.infeara.revenue;

import java.util.*;

/**
 * Lead scoring & routing (blueprint §20/§18): 100 points across five factors
 * (0-20 each), tiers A/B/C/D with first-touch SLAs, round-robin routing.
 */
public final class Scoring {
    public static final Map<String, Integer> SLA_MINUTES;
    static {
        Map<String, Integer> m = new HashMap<>();
        m.put("A", 15); m.put("B", 240); m.put("C", 1440); m.put("D", null);
        SLA_MINUTES = Collections.unmodifiableMap(m);
    }

    public static Map<String, Object> score(Map<String, String> in) {
        Map<String, Integer> budget = mapOf("no_budget", 3, "small", 9, "approved", 15, "confirmed", 20, "unknown", 6);
        Map<String, Integer> authority = mapOf("none", 3, "influencer", 9, "champion", 15, "economic_buyer", 20, "unknown", 6);
        Map<String, Integer> need = mapOf("general", 3, "aware", 9, "active", 15, "quantified", 20);
        Map<String, Integer> timeline = mapOf("none", 3, "exploring", 9, "quarter", 15, "within30", 20);
        Map<String, Integer> engagement = mapOf("none", 3, "opened", 9, "replied", 15, "meeting", 20);
        Map<String, Integer> bd = new LinkedHashMap<>();
        bd.put("budget", budget.getOrDefault(in.getOrDefault("budget", "unknown"), 6));
        bd.put("authority", authority.getOrDefault(in.getOrDefault("authority", "unknown"), 6));
        bd.put("need", need.getOrDefault(in.getOrDefault("need", "general"), 3));
        bd.put("timeline", timeline.getOrDefault(in.getOrDefault("timeline", "none"), 3));
        bd.put("engagement", engagement.getOrDefault(in.getOrDefault("engagement", "none"), 3));
        int total = 0;
        for (int v : bd.values()) total += v;
        String tier = total >= 75 ? "A" : total >= 55 ? "B" : total >= 40 ? "C" : "D";
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("score", total);
        out.put("tier", tier);
        out.put("breakdown", Json.write(bd));
        return out;
    }

    private static Map<String, Integer> mapOf(Object... kv) {
        Map<String, Integer> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], (Integer) kv[i + 1]);
        return m;
    }

    /** Routing rules: Tier A + security -> founder/manager pool; reps round-robin; C -> SDR; D -> none. */
    public static Object routeLead(Db db, String service, String tier) {
        if ("D".equals(tier)) return null;
        if ("C".equals(tier)) {
            for (Map<String, Object> u : db.all("app_user"))
                if ("SDR".equals(u.get("role")) && Objects.equals(u.get("active"), 1L)) return u.get("id");
            return null;
        }
        List<Map<String, Object>> pool = new ArrayList<>();
        boolean security = service != null && service.toUpperCase().matches(".*(VAPT|SECURITY).*");
        for (Map<String, Object> u : db.all("app_user")) {
            if (!Objects.equals(u.get("active"), 1L)) continue;
            if (tier.equals("A") && security && ("Admin".equals(u.get("role")) || "Sales Manager".equals(u.get("role")))) pool.add(u);
            if ("Sales Rep".equals(u.get("role"))) pool.add(u);
        }
        if (pool.isEmpty()) return null;
        // round-robin: least recently assigned
        Map<Object, String> last = new HashMap<>();
        for (Map<String, Object> r : db.all("lead"))
            if (r.get("owner_id") != null) {
                String t = String.valueOf(r.get("created_at"));
                if (!last.containsKey(r.get("owner_id")) || t.compareTo(last.get(r.get("owner_id"))) > 0)
                    last.put(r.get("owner_id"), t);
            }
        pool.sort(Comparator.comparing(p -> last.getOrDefault(p.get("id"), "")));
        return pool.get(0).get("id");
    }
}
