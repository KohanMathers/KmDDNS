package me.kmathers.kmddns;

import java.util.ArrayList;
import java.util.List;

/**
 * State machine for the in-game /kmddns setup wizard.
 * Supports two entry paths:
 *   1. Existing token  — /kmddns setup token <token>
 *   2. New registration — /kmddns setup new → subdomain → email → POST /register
 * Both paths converge at the port and interval steps before a final confirm.
 */
public class KmDDNSSetupSession {

    public enum State {
        CHOOSING_PATH,
        AWAITING_SUBDOMAIN,
        AWAITING_EMAIL,
        AWAITING_TOKEN,
        AWAITING_PORT,
        AWAITING_INTERVAL,
        AWAITING_TUNNEL,
        CONFIRMING,
        DONE
    }

    private State state = State.CHOOSING_PATH;

    private String pendingToken;
    private String validatedSubdomain;
    private String pendingSubdomain;
    private int pendingPort = 0;
    private int pendingInterval = 300;
    private boolean pendingTunnel = false;

    private final String apiBase;
    private final int detectedPort;

    public KmDDNSSetupSession(String apiBase, int detectedPort) {
        this.apiBase = apiBase;
        this.detectedPort = detectedPort;
    }


    public State getState() { return state; }
    public String getPendingToken() { return pendingToken; }
    public int getPendingPort() { return pendingPort; }
    public int getPendingInterval() { return pendingInterval; }
    public boolean getPendingTunnel() { return pendingTunnel; }


    /** Returns the initial choice screen. */
    public List<SetupLine> start() {
        state = State.CHOOSING_PATH;
        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§6§lKmDDNS Setup Wizard"));
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§7What would you like to do?"));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine(
                "§b§l▶ [I have a token — enter it]",
                "/kmddns setup token ", true,
                "Click to type your existing token"));
        lines.add(new SetupLine(
                "§a§l▶ [Register a new subdomain]",
                "/kmddns setup new", false,
                "Claim a new subdomain and get a token"));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine("§c✗ [Cancel]", "/kmddns setup cancel", false, "Cancel setup"));
        return lines;
    }


    /**
     * Validates the token against the API then advances to port step.
     * Accepted from CHOOSING_PATH (shortcut) or any pre-port state.
     */
    public List<SetupLine> handleToken(String token) {
        if (token == null || token.isBlank()) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§cToken cannot be empty."));
            lines.add(new SetupLine("§b§l▶ [Enter token]", "/kmddns setup token ", true, "Click to enter token"));
            return lines;
        }

        var testClient = new KmDDNSHttpClient(apiBase, token.trim());
        KmDDNSHttpClient.StatusInfo status;
        try {
            status = testClient.getStatus();
        } catch (Exception e) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§cAPI error: " + e.getMessage()));
            lines.add(new SetupLine("§b§l▶ [Try again]", "/kmddns setup token ", true, "Click to retry"));
            return lines;
        }

        if (status == null) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§cInvalid token or connection error."));
            lines.add(new SetupLine("§7Check your token and make sure the API is reachable."));
            lines.add(new SetupLine("§b§l▶ [Try again]", "/kmddns setup token ", true, "Click to try a different token"));
            return lines;
        }

        this.pendingToken = token.trim();
        this.validatedSubdomain = status.subdomain;
        this.state = State.AWAITING_PORT;

        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§a✓ Token valid!"));
        if (status.subdomain != null && !status.subdomain.isBlank()) {
            lines.add(new SetupLine("§aSubdomain: §f" + status.subdomain));
        }
        lines.add(new SetupLine("§7"));
        lines.addAll(portStep());
        return lines;
    }


    /** Start the new-registration sub-wizard. */
    public List<SetupLine> handleNew() {
        state = State.AWAITING_SUBDOMAIN;
        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§7Register §f1§7/§f2 §7— Choose a subdomain."));
        lines.add(new SetupLine("§7Lowercase letters, numbers, hyphens (e.g. §fmyserver§7)."));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine(
                "§b§l▶ [Click to enter subdomain]",
                "/kmddns setup subdomain ", true,
                "Click to type your desired subdomain"));
        lines.add(new SetupLine("§7Or type: §b/kmddns setup subdomain <name>"));
        return lines;
    }

    public List<SetupLine> handleSubdomain(String subdomain) {
        if (state != State.AWAITING_SUBDOMAIN) return noSessionError();

        if (subdomain == null || subdomain.isBlank()) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§cSubdomain cannot be empty."));
            lines.add(new SetupLine("§b§l▶ [Enter subdomain]", "/kmddns setup subdomain ", true, ""));
            return lines;
        }

        String sub = subdomain.trim().toLowerCase();
        if (!sub.matches("[a-z0-9]([a-z0-9-]*[a-z0-9])?") || sub.length() > 63) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§c\"" + sub + "\" is not a valid subdomain."));
            lines.add(new SetupLine("§7Use only letters, numbers, and hyphens. No leading/trailing hyphens."));
            lines.add(new SetupLine("§b§l▶ [Try again]", "/kmddns setup subdomain ", true, "Click to try a different name"));
            return lines;
        }

        this.pendingSubdomain = sub;
        this.state = State.AWAITING_EMAIL;

        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§a✓ Subdomain: §f" + sub));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§7Register §f2§7/§f2 §7— Owner email §7(optional, for account recovery)."));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine(
                "§b§l▶ [Enter email address]",
                "/kmddns setup email ", true,
                "Click to type your email address"));
        lines.add(new SetupLine(
                "§a§l▶ [Skip — no email]",
                "/kmddns setup email skip", false,
                "Register without an email address"));
        return lines;
    }

    public List<SetupLine> handleEmail(String email) {
        if (state != State.AWAITING_EMAIL) return noSessionError();
        return doRegister(email.trim());
    }

    public List<SetupLine> handleEmailSkip() {
        if (state != State.AWAITING_EMAIL) return noSessionError();
        return doRegister(null);
    }

    private List<SetupLine> doRegister(String email) {
        var result = KmDDNSHttpClient.register(apiBase, pendingSubdomain, email, detectedPort);

        if (!result.success) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§cRegistration failed: §f" + friendlyError(result.error)));
            switch (result.error != null ? result.error : "") {
                case "subdomain_taken" -> {
                    lines.add(new SetupLine("§7Try a different subdomain name."));
                    lines.add(new SetupLine("§b§l▶ [Choose another subdomain]", "/kmddns setup subdomain ", true, "Click to try a different name"));
                }
                case "rate_limited" -> lines.add(new SetupLine("§7Too many registrations from this IP. Try again later."));
                default -> {
                    lines.add(new SetupLine("§b§l▶ [Try again]", "/kmddns setup new", false, "Restart registration"));
                }
            }
            return lines;
        }

        this.pendingToken = result.token;
        this.validatedSubdomain = result.subdomain;
        this.state = State.AWAITING_PORT;

        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§a§l✓ Registered!"));
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§6§lYour token §7(shown §lonce§r§7 — save it now!):"));
        lines.add(SetupLine.copyable("§f§l" + result.token, result.token, "Click to copy token to clipboard"));
        lines.add(new SetupLine("§7─────────────────────────"));
        if (result.fqdn != null && !result.fqdn.isBlank()) {
            lines.add(new SetupLine("§aAddress: §f" + result.fqdn));
        } else if (result.subdomain != null) {
            lines.add(new SetupLine("§aSubdomain: §f" + result.subdomain));
        }
        lines.add(new SetupLine("§c⚠ This token will not be shown again!"));
        lines.add(new SetupLine("§7"));
        lines.addAll(portStep());
        return lines;
    }

    private static String friendlyError(String code) {
        if (code == null) return "unknown error";
        return switch (code) {
            case "subdomain_taken" -> "subdomain already taken";
            case "invalid_subdomain" -> "invalid subdomain name";
            case "rate_limited" -> "rate limited";
            case "connection_error" -> "could not connect to API";
            default -> code;
        };
    }


    private List<SetupLine> portStep() {
        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§7Port configuration (detected: §f" + detectedPort + "§7)."));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine(
                "§a§l▶ [✓ Auto-detect (" + detectedPort + ")]",
                "/kmddns setup port auto", false,
                "Use the server's detected port: " + detectedPort));
        lines.add(new SetupLine(
                "§e§l▶ [⚙ Custom port]",
                "/kmddns setup port ", true,
                "Click to type a custom port number"));
        return lines;
    }

    public List<SetupLine> handlePortAuto() {
        if (state != State.AWAITING_PORT) return noSessionError();
        this.pendingPort = 0;
        this.state = State.AWAITING_INTERVAL;
        return intervalStep();
    }

    public List<SetupLine> handlePortNumber(int port) {
        if (state != State.AWAITING_PORT) return noSessionError();
        if (port < 1 || port > 65535) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§cPort must be between 1 and 65535."));
            lines.addAll(portStep());
            return lines;
        }
        this.pendingPort = port;
        this.state = State.AWAITING_INTERVAL;
        return intervalStep();
    }


    private List<SetupLine> intervalStep() {
        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§7Update interval."));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine(
                "§a§l▶ [✓ Default — every 5 minutes]",
                "/kmddns setup interval 300", false,
                "Update every 5 minutes (recommended)"));
        lines.add(new SetupLine(
                "§e§l▶ [⚙ Custom interval in seconds]",
                "/kmddns setup interval ", true,
                "Click to enter a custom interval (minimum 30s)"));
        return lines;
    }

    public List<SetupLine> handleInterval(int seconds) {
        if (state != State.AWAITING_INTERVAL) return noSessionError();
        if (seconds < 30) {
            var lines = new ArrayList<SetupLine>();
            lines.add(new SetupLine("§cMinimum interval is 30 seconds."));
            lines.addAll(intervalStep());
            return lines;
        }
        this.pendingInterval = seconds;
        this.state = State.AWAITING_TUNNEL;
        return tunnelStep();
    }

    private List<SetupLine> tunnelStep() {
        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§7Would you like to enable §btunnel mode§7?"));
        lines.add(new SetupLine("§7(No port forwarding required — traffic routes through KmDDNS)"));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine(
                "§a§l▶ [Yes — use tunnel]",
                "/kmddns setup tunnel enable", false,
                "Enable tunnel mode — no port forwarding needed"));
        lines.add(new SetupLine(
                "§7§l▶ [No — I'll forward my port]",
                "/kmddns setup tunnel disable", false,
                "Use standard DDNS — requires port forwarding"));
        return lines;
    }

    public List<SetupLine> handleTunnelEnable() {
        if (state != State.AWAITING_TUNNEL) return noSessionError();
        this.pendingTunnel = true;
        this.state = State.CONFIRMING;
        return confirmStep();
    }

    public List<SetupLine> handleTunnelDisable() {
        if (state != State.AWAITING_TUNNEL) return noSessionError();
        this.pendingTunnel = false;
        this.state = State.CONFIRMING;
        return confirmStep();
    }


    private List<SetupLine> confirmStep() {
        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§7─────────────────────────"));
        lines.add(new SetupLine("§6§lSummary"));
        lines.add(new SetupLine("§7─────────────────────────"));

        String tokenPreview = (pendingToken != null && pendingToken.length() > 12)
                ? pendingToken.substring(0, 8) + "..." + pendingToken.substring(pendingToken.length() - 4)
                : pendingToken;
        lines.add(new SetupLine("§aToken:    §f" + tokenPreview));
        if (validatedSubdomain != null && !validatedSubdomain.isBlank()) {
            lines.add(new SetupLine("§aSubdomain: §f" + validatedSubdomain));
        }
        lines.add(new SetupLine("§aPort:     §f" +
                (pendingPort == 0 ? "auto (" + detectedPort + ")" : String.valueOf(pendingPort))));
        lines.add(new SetupLine("§aInterval: §f" + pendingInterval + "s"));
        lines.add(new SetupLine("§aTunnel:   §f" + (pendingTunnel ? "§aenabled (no port forwarding)" : "§7disabled")));
        lines.add(new SetupLine("§7"));
        lines.add(new SetupLine(
                "§a§l▶ [✓ Confirm & Save]",
                "/kmddns setup confirm", false,
                "Save configuration and start DDNS"));
        lines.add(new SetupLine(
                "§c§l▶ [✗ Cancel]",
                "/kmddns setup cancel", false,
                "Cancel without saving"));
        return lines;
    }

    public List<SetupLine> confirm() {
        if (state != State.CONFIRMING) return noSessionError();
        state = State.DONE;
        var lines = new ArrayList<SetupLine>();
        lines.add(new SetupLine("§a§l✓ Setup complete! Configuration saved."));
        lines.add(new SetupLine("§7DDNS is now active. Type §b/kmddns status §7to check."));
        return lines;
    }


    public List<SetupLine> cancel() {
        state = State.DONE;
        return List.of(new SetupLine("§7Setup cancelled. No changes saved."));
    }


    private List<SetupLine> noSessionError() {
        return List.of(new SetupLine("§cNo active setup session. Run §b/kmddns setup §cfirst."));
    }
}
