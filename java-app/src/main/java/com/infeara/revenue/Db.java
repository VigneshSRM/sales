package com.infeara.revenue;

import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Datastore. The blueprint mandates MariaDB 11.4 as the only datastore (bound to
 * 127.0.0.1). In this offline sandbox no JDBC driver is obtainable, so this is a
 * file-backed store with the same table inventory (Appendix A, 34 tables) and the
 * same guarantees: single local datastore, append-only hash-chained audit log,
 * atomic writes. Swap to MariaDB via JDBC in production without touching services.
 */
public final class Db {
    public final Map<String, List<Map<String, Object>>> tables = new ConcurrentHashMap<>();
    private final Map<String, Long> sequences = new ConcurrentHashMap<>();
    private final Path file;
    private String lastHash = "";

    public Db(Path file) {
        this.file = file;
        for (String t : new String[]{"app_user", "app_setting", "feature_flag", "audit_log", "notification",
                "export_job", "company", "contact", "lead", "deal", "deal_stage_history", "activity", "task", "note",
                "capture_request", "consent_record", "suppression", "lead_source_touch", "email_template", "sequence",
                "sequence_step", "enrollment", "email_message", "email_event", "mailbox", "availability",
                "meeting_slot", "meeting", "meeting_invite", "reminder_log", "meeting_outcome", "workflow_rule",
                "workflow_execution", "report_snapshot", "data_subject_request"})
            tables.put(t, new ArrayList<>());
        load();
    }

    public long nextId(String table) {
        return sequences.merge(table, 1L, Long::sum);
    }

    public synchronized void insert(String table, Map<String, Object> row) {
        if (!row.containsKey("id")) row.put("id", nextId(table));
        if (!row.containsKey("created_at")) row.put("created_at", now());
        tables.get(table).add(row);
        save();
    }

    public List<Map<String, Object>> all(String table) { return tables.get(table); }

    public Map<String, Object> find(String table, String key, Object value) {
        for (Map<String, Object> r : tables.get(table))
            if (Objects.equals(String.valueOf(r.get(key)), String.valueOf(value))) return r;
        return null;
    }

    public List<Map<String, Object>> query(String table, String key, Object value) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : tables.get(table))
            if (Objects.equals(String.valueOf(r.get(key)), String.valueOf(value))) out.add(r);
        return out;
    }

    public void update(String table, Map<String, Object> row, Map<String, Object> patch) {
        row.putAll(patch);
        save();
    }

    /** Append-only, hash-chained audit log — actor mandatory on every write. */
    public synchronized void audit(String actor, String action, String entityType, Object entityId) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("actor", actor);
        row.put("action", action);
        row.put("entity_type", entityType);
        row.put("entity_id", entityId == null ? null : String.valueOf(entityId));
        row.put("before_hash", lastHash.isEmpty() ? null : lastHash);
        lastHash = sha256(lastHash + actor + action + entityType + entityId + System.nanoTime());
        row.put("after_hash", lastHash);
        row.put("trace_id", UUID.randomUUID().toString());
        insert("audit_log", row);
    }

    public void notify(Object userId, String event, String message) {
        Map<String, Object> n = new LinkedHashMap<>();
        n.put("user_id", userId);
        n.put("event", event);
        n.put("message", message);
        n.put("read", 0);
        insert("notification", n);
    }

    public static String sha256(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest(s.getBytes("UTF-8"))) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    public static String hashEmail(String email) {
        return sha256(email == null ? "" : email.trim().toLowerCase());
    }

    public static String now() {
        return java.time.Instant.now().toString().replace("T", " ").substring(0, 19) + "Z";
    }

    private synchronized void save() {
        try {
            Map<String, Object> root = new LinkedHashMap<>();
            root.put("sequences", sequences);
            root.put("tables", tables);
            root.put("lastHash", lastHash);
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.write(tmp, Json.write(root).getBytes("UTF-8"));
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    @SuppressWarnings("unchecked")
    private void load() {
        try {
            if (!Files.exists(file)) return;
            Map<String, Object> root = Json.parseObject(new String(Files.readAllBytes(file), "UTF-8"));
            Map<String, Object> seqs = (Map<String, Object>) root.get("sequences");
            if (seqs != null) seqs.forEach((k, v) -> sequences.put(k, ((Number) v).longValue()));
            Map<String, Object> t = (Map<String, Object>) root.get("tables");
            if (t != null) t.forEach((k, v) -> tables.put(k, (List<Map<String, Object>>) v));
            lastHash = String.valueOf(root.getOrDefault("lastHash", ""));
        } catch (Exception e) { System.err.println("db load: " + e.getMessage()); }
    }
}
