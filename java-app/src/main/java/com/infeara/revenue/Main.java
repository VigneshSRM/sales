package com.infeara.revenue;

import java.nio.file.*;
import java.util.concurrent.*;

/**
 * Sales Pipeline Autopilot — entry point (blueprint §36: modular monolith, one
 * deployable, local datastore only). Runs on Java 17 (Temurin).
 *
 *   java -cp build/classes com.infeara.revenue.Main   (port 8080)
 */
public final class Main {
    public static void main(String[] args) throws Exception {
        System.out.println("Java runtime: " + System.getProperty("java.version") + " (" + System.getProperty("java.vendor") + ")");
        Path dataDir = Paths.get(System.getenv().getOrDefault("DATA_DIR", "data"));
        Files.createDirectories(dataDir);
        Db db = new Db(dataDir.resolve("revenue_ops.json"));
        Seed.run(db);

        Server server = new Server(db);
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        server.start(port);

        // Background scheduler (Quartz equivalent): outbox drain, reminders, no-show, stale-deal sweep
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleAtFixedRate(() -> {
            try {
                if (Workflow.flagOn(db, "email.sending"))
                    for (var m : db.all("email_message"))
                        if ("QUEUED".equals(m.get("status"))) {
                            db.update("email_message", m, java.util.Map.of("status", "SENT", "sent_at", Db.now()));
                            var ev = new java.util.LinkedHashMap<String, Object>();
                            ev.put("message_id", m.get("id")); ev.put("type", "sent"); ev.put("detail", "via local SMTP relay");
                            db.insert("email_event", ev);
                        }
                Workflow.sweepStaleDeals(db);
            } catch (Exception e) { System.err.println("scheduler: " + e.getMessage()); }
        }, 30, 60, TimeUnit.SECONDS);
    }
}
