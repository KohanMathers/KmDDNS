package me.kmathers.kmddns;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * Core mod logic, shared between Fabric and Forge loaders.
 * Handles config loading, initial registration, periodic heartbeat,
 * and graceful shutdown.
 */
public class KmDDNSMod {

    private static final Logger LOGGER = Logger.getLogger("KmDDNS");
    private static final DateTimeFormatter TIME_FMT =
            DateTimeFormatter.ofPattern("dd-MM-yyyy HH:mm:ss").withZone(ZoneId.systemDefault());

    private final KmDDNSConfig config;
    private final IServerAccessor serverAccessor;
    private KmDDNSHttpClient httpClient;
    private KmDDNSTunnelClient tunnelClient;

    private ScheduledExecutorService scheduler;
    private ScheduledFuture<?> heartbeatTask;

    private volatile Instant lastUpdateTime = null;
    private volatile Instant nextUpdateTime = null;
    private volatile int resolvedPort = 0;

    private Path lastServerDir;
    private KmDDNSSetupSession setupSession;

    public KmDDNSMod(Path configDir, IServerAccessor serverAccessor) {
        this.serverAccessor = serverAccessor;
        this.config = new KmDDNSConfig(configDir);
        this.config.load();
        LOGGER.info("[KmDDNS] Config loaded: " + config);
    }

    /**
     * Called when the Minecraft server has fully started.
     *
     * @param serverDir the server working directory (used to find server.properties)
     */
    public void onServerStart(Path serverDir) {
        this.lastServerDir = serverDir;
        if (!config.enabled) {
            LOGGER.info("[KmDDNS] Mod is disabled in config.");
            return;
        }

        if (!config.hasToken()) {
            LOGGER.warning("[KmDDNS] No token configured — add your token to config/kmddns.toml");
            return;
        }

        resolvedPort = resolvePort(serverDir);
        httpClient = new KmDDNSHttpClient(config.apiBase, config.token);

        if (config.tunnel) {
            tunnelClient = new KmDDNSTunnelClient(config.apiBase, config.token, resolvedPort);
            tunnelClient.start();
            LOGGER.info("[KmDDNS] Tunnel mode enabled. Port=" + resolvedPort);
            return;
        }

        scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            var t = new Thread(r, "kmddns-scheduler");
            t.setDaemon(true);
            return t;
        });

        scheduler.schedule(() -> sendUpdate(resolvedPort), 5, TimeUnit.SECONDS);

        long intervalSeconds = Math.max(30, config.updateInterval);
        nextUpdateTime = Instant.now().plusSeconds(intervalSeconds + 5);
        heartbeatTask = scheduler.scheduleAtFixedRate(
                () -> sendUpdate(resolvedPort),
                intervalSeconds + 5,
                intervalSeconds,
                TimeUnit.SECONDS
        );

        LOGGER.info("[KmDDNS] Started. Port=" + resolvedPort + ", heartbeat every " + intervalSeconds + "s");
    }

    /**
     * Called when the Minecraft server is stopping.
     * Shuts down heartbeat and marks the record as disabled.
     */
    public void onServerStop() {
        if (tunnelClient != null) {
            tunnelClient.stop();
            tunnelClient = null;
        }
        if (scheduler != null && !scheduler.isShutdown()) {
            scheduler.shutdownNow();
        }
    }

    /**
     * Send an update (heartbeat) to the KmDDNS API.
     */
    public void sendUpdate(int port) {
        if (httpClient == null) return;
        try {
            var motd = serverAccessor.getMotd();
            int playerCount = serverAccessor.getPlayerCount();
            int maxPlayers = serverAccessor.getMaxPlayers();

            var result = httpClient.update(
                    port,
                    motd,
                    playerCount,
                    maxPlayers,
                    config.metadataMotd,
                    config.metadataPlayerCount
            );

            lastUpdateTime = Instant.now();
            nextUpdateTime = lastUpdateTime.plusSeconds(config.updateInterval);

            if (config.logUpdates) {
                switch (result) {
                    case OK -> LOGGER.info("[KmDDNS] Heartbeat OK (port=" + port + ", players=" + playerCount + ")");
                    case RATE_LIMITED -> LOGGER.warning("[KmDDNS] Heartbeat rate-limited — will retry next interval.");
                    case ERROR -> LOGGER.warning("[KmDDNS] Heartbeat failed — check token and API connectivity.");
                }
            }
        } catch (Exception e) {
            LOGGER.warning("[KmDDNS] Unexpected error during update: " + e.getMessage());
        }
    }

    /**
     * Determine the port to use.
     * Uses config port if non-zero, otherwise reads server.properties,
     * falling back to the live server port.
     */
    public int resolvePort(Path serverDir) {
        if (config.port != 0) {
            return config.port;
        }

        var propsFile = serverDir.resolve("server.properties");
        if (Files.exists(propsFile)) {
            try {
                var props = new Properties();
                try (var reader = Files.newBufferedReader(propsFile)) {
                    props.load(reader);
                }
                var portStr = props.getProperty("server-port", "").trim();
                if (!portStr.isEmpty()) {
                    int p = Integer.parseInt(portStr);
                    LOGGER.info("[KmDDNS] Using port " + p + " from server.properties");
                    return p;
                }
            } catch (IOException | NumberFormatException e) {
                LOGGER.warning("[KmDDNS] Could not read server.properties: " + e.getMessage());
            }
        }

        int livePort = serverAccessor.getPort();
        LOGGER.info("[KmDDNS] Using live server port: " + livePort);
        return livePort;
    }

    /**
     * Returns colored status lines suitable for in-game display or console.
     * Uses § Minecraft formatting codes.
     */
    public List<String> getStatusLines() {
        var lines = new ArrayList<String>();

        lines.add("§6§lKmDDNS Status");
        lines.add("§7─────────────────────────");

        if (!config.enabled) {
            lines.add("§cMod disabled in config.");
            return lines;
        }

        if (!config.hasToken()) {
            lines.add("§cNo token configured.");
            lines.add("§7Add your token to §fconfig/kmddns.toml");
            return lines;
        }

        KmDDNSHttpClient.StatusInfo status = null;
        if (httpClient != null) {
            try {
                status = httpClient.getStatus();
            } catch (Exception e) {
                LOGGER.warning("[KmDDNS] getStatusLines: could not fetch status: " + e.getMessage());
            }
        }

        if (config.tunnel) {
            boolean tc = tunnelClient != null && tunnelClient.isConnected();
            lines.add("§aTunnel: §f" + (tc ? "§aconnected" : "§cdisconnected"));
        }

        if (status != null) {
            lines.add("§aEnabled: §f" + status.enabled);
            lines.add("§aSubdomain: §f" + (status.subdomain.isEmpty() ? "§7(not set)" : status.subdomain));
            lines.add("§aIP: §f" + (status.ip.isEmpty() ? "§7(unknown)" : status.ip));
            lines.add("§aPort: §f" + (status.port > 0 ? status.port : resolvedPort));
            lines.add("§aLast seen: §f" + (status.lastSeen.isEmpty() ? "§7(never)" : status.lastSeen));
        } else {
            lines.add("§eStatus: §7Could not fetch from API");
            lines.add("§aPort: §f" + resolvedPort);
        }

        if (lastUpdateTime != null) {
            lines.add("§aLast update: §f" + TIME_FMT.format(lastUpdateTime));
        } else {
            lines.add("§aLast update: §7(none yet)");
        }

        if (nextUpdateTime != null) {
            long secsUntilNext = nextUpdateTime.getEpochSecond() - Instant.now().getEpochSecond();
            if (secsUntilNext > 0) {
                lines.add("§aNext update in: §f" + secsUntilNext + "s");
            } else {
                lines.add("§aNext update: §fimminent");
            }
        }

        lines.add("§7API: §f" + config.apiBase);
        lines.add("§7─────────────────────────");

        return lines;
    }


    /** Start (or restart) the setup wizard. */
    public List<SetupLine> handleSetupStart() {
        int port = resolvedPort > 0 ? resolvedPort : serverAccessor.getPort();
        if (port <= 0) port = 25565;
        setupSession = new KmDDNSSetupSession(config.apiBase, port);
        return setupSession.start();
    }

    public List<SetupLine> handleSetupToken(String token) {
        if (setupSession == null) return noSession();
        return setupSession.handleToken(token);
    }

    public List<SetupLine> handleSetupNew() {
        if (setupSession == null) return noSession();
        return setupSession.handleNew();
    }

    public List<SetupLine> handleSetupSubdomain(String subdomain) {
        if (setupSession == null) return noSession();
        return setupSession.handleSubdomain(subdomain);
    }

    public List<SetupLine> handleSetupEmail(String email) {
        if (setupSession == null) return noSession();
        return setupSession.handleEmail(email);
    }

    public List<SetupLine> handleSetupEmailSkip() {
        if (setupSession == null) return noSession();
        return setupSession.handleEmailSkip();
    }

    public List<SetupLine> handleSetupPortAuto() {
        if (setupSession == null) return noSession();
        return setupSession.handlePortAuto();
    }

    public List<SetupLine> handleSetupPortNumber(int port) {
        if (setupSession == null) return noSession();
        return setupSession.handlePortNumber(port);
    }

    public List<SetupLine> handleSetupInterval(int seconds) {
        if (setupSession == null) return noSession();
        return setupSession.handleInterval(seconds);
    }

    public List<SetupLine> handleSetupTunnelEnable() {
        if (setupSession == null) return noSession();
        return setupSession.handleTunnelEnable();
    }

    public List<SetupLine> handleSetupTunnelDisable() {
        if (setupSession == null) return noSession();
        return setupSession.handleTunnelDisable();
    }

    /**
     * Confirm and save: writes config to disk then restarts the heartbeat.
     */
    public List<SetupLine> handleSetupConfirm() {
        if (setupSession == null || setupSession.getState() != KmDDNSSetupSession.State.CONFIRMING) {
            return List.of(new SetupLine("§cNothing to confirm. Run §b/kmddns setup §cfirst."));
        }
        var resultLines = setupSession.confirm();
        config.token = setupSession.getPendingToken();
        config.port = setupSession.getPendingPort();
        config.updateInterval = setupSession.getPendingInterval();
        config.tunnel = setupSession.getPendingTunnel();
        config.enabled = true;
        config.save();
        setupSession = null;
        onServerStop();
        if (lastServerDir != null) {
            onServerStart(lastServerDir);
        }
        return resultLines;
    }

    public List<SetupLine> handleSetupCancel() {
        if (setupSession == null) {
            return List.of(new SetupLine("§7No active setup session."));
        }
        var lines = setupSession.cancel();
        setupSession = null;
        return lines;
    }

    private List<SetupLine> noSession() {
        return List.of(new SetupLine("§cNo active setup session. Run §b/kmddns setup §cfirst."));
    }

    public KmDDNSConfig getConfig() {
        return config;
    }

    public Instant getLastUpdateTime() {
        return lastUpdateTime;
    }

    public Instant getNextUpdateTime() {
        return nextUpdateTime;
    }

    public int getResolvedPort() {
        return resolvedPort;
    }
}
