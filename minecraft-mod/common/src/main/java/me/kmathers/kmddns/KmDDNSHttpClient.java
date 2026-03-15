package me.kmathers.kmddns;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 * HTTP client for communicating with the KmDDNS API.
 * Uses Java 11 java.net.http.HttpClient — no external libraries required.
 */
public class KmDDNSHttpClient {

    private static final Logger LOGGER = Logger.getLogger("KmDDNS");

    /** Pattern to strip Minecraft §x color/formatting codes */
    private static final Pattern MC_COLOR_PATTERN = Pattern.compile("§[0-9a-fA-Fk-orK-OR]");

    public enum UpdateResult {
        OK,
        RATE_LIMITED,
        ERROR
    }

    /**
     * Result of a POST /register call.
     */
    public static final class RegisterResult {
        public final boolean success;
        /** The one-time bearer token. Non-null on success. */
        public final String token;
        public final String subdomain;
        public final String fqdn;
        /** Error code from the API (e.g. "subdomain_taken"), or "connection_error". Null on success. */
        public final String error;

        private RegisterResult(boolean success, String token, String subdomain, String fqdn, String error) {
            this.success = success;
            this.token = token;
            this.subdomain = subdomain;
            this.fqdn = fqdn;
            this.error = error;
        }

        public static RegisterResult ok(String token, String subdomain, String fqdn) {
            return new RegisterResult(true, token, subdomain, fqdn, null);
        }

        public static RegisterResult error(String errorCode) {
            return new RegisterResult(false, null, null, null, errorCode);
        }
    }

    /**
     * Parsed status information returned from GET /client.
     */
    public static final class StatusInfo {
        public final String subdomain;
        public final String ip;
        public final int port;
        public final String lastSeen;
        public final boolean enabled;

        public StatusInfo(String subdomain, String ip, int port, String lastSeen, boolean enabled) {
            this.subdomain = subdomain;
            this.ip = ip;
            this.port = port;
            this.lastSeen = lastSeen;
            this.enabled = enabled;
        }

        @Override
        public String toString() {
            return "StatusInfo{subdomain='" + subdomain + "', ip='" + ip + "', port=" + port +
                    ", lastSeen='" + lastSeen + "', enabled=" + enabled + "}";
        }
    }

    private final String apiBase;
    private final String token;
    private final HttpClient httpClient;

    public KmDDNSHttpClient(String apiBase, String token) {
        this.apiBase = apiBase.endsWith("/") ? apiBase.substring(0, apiBase.length() - 1) : apiBase;
        this.token = token;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    /**
     * POST /update — registers or refreshes the DDNS record.
     *
     * @param port               the server port
     * @param motd               raw MOTD (may contain §color codes)
     * @param playerCount        current online player count
     * @param maxPlayers         maximum player slots
     * @param includeMotd        whether to send MOTD in metadata
     * @param includePlayerCount whether to send player counts in metadata
     * @return UpdateResult indicating outcome
     */
    public UpdateResult update(int port, String motd, int playerCount, int maxPlayers,
                               boolean includeMotd, boolean includePlayerCount) {
        var body = new StringBuilder();
        body.append("{");
        body.append("\"port\":").append(port);

        boolean hasMetadata = includeMotd || includePlayerCount;
        if (hasMetadata) {
            body.append(",\"metadata\":{");
            boolean first = true;
            if (includeMotd && motd != null) {
                body.append("\"motd\":").append(jsonString(stripColorCodes(motd)));
                first = false;
            }
            if (includePlayerCount) {
                if (!first) body.append(",");
                body.append("\"player_count\":\"").append(playerCount).append("\"");
                body.append(",\"max_players\":\"").append(maxPlayers).append("\"");
            }
            body.append("}");
        }

        body.append("}");

        try {
            var request = HttpRequest.newBuilder()
                    .uri(URI.create(apiBase + "/update"))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                    .timeout(Duration.ofSeconds(15))
                    .build();

            var response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            return switch (response.statusCode()) {
                case 200, 204 -> UpdateResult.OK;
                case 429 -> UpdateResult.RATE_LIMITED;
                default -> {
                    LOGGER.warning("[KmDDNS] update returned HTTP " + response.statusCode() + ": " + response.body());
                    yield UpdateResult.ERROR;
                }
            };
        } catch (IOException | InterruptedException e) {
            LOGGER.warning("[KmDDNS] update failed: " + e.getMessage());
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return UpdateResult.ERROR;
        }
    }

    /**
     * PATCH /client — sets the enabled flag on the client record.
     *
     * @param enabled whether to mark the client as active
     * @return true on success
     */
    public boolean setEnabled(boolean enabled) {
        var body = "{\"enabled\":" + enabled + "}";
        try {
            var request = HttpRequest.newBuilder()
                    .uri(URI.create(apiBase + "/client"))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token)
                    .method("PATCH", HttpRequest.BodyPublishers.ofString(body))
                    .timeout(Duration.ofSeconds(15))
                    .build();

            var response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                return true;
            }
            LOGGER.warning("[KmDDNS] setEnabled returned HTTP " + response.statusCode() + ": " + response.body());
            return false;
        } catch (IOException | InterruptedException e) {
            LOGGER.warning("[KmDDNS] setEnabled failed: " + e.getMessage());
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * GET /client — retrieves current status information.
     *
     * @return StatusInfo or null on failure
     */
    public StatusInfo getStatus() {
        try {
            var request = HttpRequest.newBuilder()
                    .uri(URI.create(apiBase + "/client"))
                    .header("Authorization", "Bearer " + token)
                    .GET()
                    .timeout(Duration.ofSeconds(15))
                    .build();

            var response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 200) {
                return parseStatusInfo(response.body());
            }
            LOGGER.warning("[KmDDNS] getStatus returned HTTP " + response.statusCode());
            return null;
        } catch (IOException | InterruptedException e) {
            LOGGER.warning("[KmDDNS] getStatus failed: " + e.getMessage());
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return null;
        }
    }

    /**
     * Parse StatusInfo from a JSON string using simple string search.
     * Avoids external JSON libraries.
     */
    private static StatusInfo parseStatusInfo(String json) {
        if (json == null || json.isBlank()) return null;

        var subdomain = extractJsonString(json, "subdomain");
        var ip = extractJsonString(json, "ip");
        var lastSeen = extractJsonString(json, "last_seen");
        int port = extractJsonInt(json, "port", 0);
        boolean enabled = extractJsonBoolean(json, "enabled", true);

        return new StatusInfo(
                subdomain != null ? subdomain : "",
                ip != null ? ip : "",
                port,
                lastSeen != null ? lastSeen : "",
                enabled
        );
    }

    /**
     * Extract a string value from JSON by key.
     * Handles simple "key": "value" patterns.
     */
    static String extractJsonString(String json, String key) {
        var pattern = "\"" + key + "\"";
        int keyIdx = json.indexOf(pattern);
        if (keyIdx < 0) return null;

        int colonIdx = json.indexOf(':', keyIdx + pattern.length());
        if (colonIdx < 0) return null;

        int start = colonIdx + 1;
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) start++;

        if (start >= json.length()) return null;

        if (json.charAt(start) == '"') {
            int end = start + 1;
            while (end < json.length()) {
                if (json.charAt(end) == '"' && json.charAt(end - 1) != '\\') break;
                end++;
            }
            return json.substring(start + 1, end)
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
                    .replace("\\n", "\n")
                    .replace("\\t", "\t");
        }

        if (json.startsWith("null", start)) return null;

        return null;
    }

    /**
     * Extract an integer value from JSON by key.
     */
    static int extractJsonInt(String json, String key, int defaultValue) {
        var pattern = "\"" + key + "\"";
        int keyIdx = json.indexOf(pattern);
        if (keyIdx < 0) return defaultValue;

        int colonIdx = json.indexOf(':', keyIdx + pattern.length());
        if (colonIdx < 0) return defaultValue;

        int start = colonIdx + 1;
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) start++;

        if (start >= json.length()) return defaultValue;

        int end = start;
        if (json.charAt(start) == '-') end++;
        while (end < json.length() && Character.isDigit(json.charAt(end))) end++;

        if (end == start) return defaultValue;

        try {
            return Integer.parseInt(json.substring(start, end));
        } catch (NumberFormatException e) {
            return defaultValue;
        }
    }

    /**
     * Extract a boolean value from JSON by key.
     */
    static boolean extractJsonBoolean(String json, String key, boolean defaultValue) {
        var pattern = "\"" + key + "\"";
        int keyIdx = json.indexOf(pattern);
        if (keyIdx < 0) return defaultValue;

        int colonIdx = json.indexOf(':', keyIdx + pattern.length());
        if (colonIdx < 0) return defaultValue;

        int start = colonIdx + 1;
        while (start < json.length() && Character.isWhitespace(json.charAt(start))) start++;

        if (start >= json.length()) return defaultValue;

        if (json.startsWith("true", start)) return true;
        if (json.startsWith("false", start)) return false;
        return defaultValue;
    }

    /**
     * POST /register — claims a subdomain and returns a one-time bearer token.
     * No authentication required.
     *
     * @param apiBase   the API base URL
     * @param subdomain desired subdomain label
     * @param email     optional owner email (null or blank to omit)
     * @return RegisterResult with the token on success, or an error code on failure
     */
    public static RegisterResult register(String apiBase, String subdomain, String email, int port) {
        String base = apiBase.endsWith("/") ? apiBase.substring(0, apiBase.length() - 1) : apiBase;

        var requestBody = new StringBuilder();
        requestBody.append("{\"subdomain\":").append(jsonString(subdomain));
        if (email != null && !email.isBlank()) {
            requestBody.append(",\"owner_email\":").append(jsonString(email.trim()));
        }
        requestBody.append(",\"port\":").append(port);
        requestBody.append(",\"srv\":\"_minecraft._tcp\"");
        requestBody.append(",\"ttl\":60");
        requestBody.append(",\"tags\":[\"minecraft\"]");
        requestBody.append(",\"redirect_http\":false");
        requestBody.append("}");

        try {
            var client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(10))
                    .build();
            var request = HttpRequest.newBuilder()
                    .uri(URI.create(base + "/register"))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody.toString()))
                    .timeout(Duration.ofSeconds(15))
                    .build();

            var response = client.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 201) {
                var body = response.body();
                var token = extractJsonString(body, "token");
                var sub = extractJsonString(body, "subdomain");
                var fqdn = extractJsonString(body, "fqdn");
                if (token == null) return RegisterResult.error("no_token_in_response");
                return RegisterResult.ok(token, sub != null ? sub : subdomain, fqdn);
            }

            var errCode = extractJsonString(response.body(), "error");
            return RegisterResult.error(errCode != null ? errCode : "http_" + response.statusCode());
        } catch (IOException | InterruptedException e) {
            LOGGER.warning("[KmDDNS] register failed: " + e.getClass().getName() + ": " + e.getMessage());
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            return RegisterResult.error("connection_error");
        }
    }

    /**
     * Strip Minecraft §x color and formatting codes from a string.
     */
    public static String stripColorCodes(String input) {
        if (input == null) return "";
        return MC_COLOR_PATTERN.matcher(input).replaceAll("");
    }

    /**
     * Escape a string for JSON output.
     */
    private static String jsonString(String value) {
        if (value == null) return "null";
        return "\"" + value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t")
                + "\"";
    }
}
