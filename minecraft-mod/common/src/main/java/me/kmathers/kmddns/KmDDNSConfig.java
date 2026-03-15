package me.kmathers.kmddns;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;

/**
 * Configuration loader for KmDDNS.
 * Reads from config/kmddns.toml and creates a default if missing.
 * Parses the flat TOML structure without external dependencies.
 */
public class KmDDNSConfig {

    private static final Logger LOGGER = Logger.getLogger("KmDDNS");

    private static final String DEFAULT_CONFIG = """
            [kmddns]
            enabled = true
            token = ""
            api_base = "https://ddns.kmathers.co.uk/v1"
            port = 0
            update_interval = 300
            tags = ["minecraft"]
            metadata_motd = true
            metadata_player_count = true
            log_updates = true
            """;

    public boolean enabled = true;
    public String token = "";
    public String apiBase = "https://ddns.kmathers.co.uk/v1";
    public int port = 0;
    public int updateInterval = 300;
    public List<String> tags = new ArrayList<>(List.of("minecraft"));
    public boolean metadataMotd = true;
    public boolean metadataPlayerCount = true;
    public boolean logUpdates = true;

    private final Path configPath;

    public KmDDNSConfig(Path configDir) {
        this.configPath = configDir.resolve("kmddns.toml");
    }

    /**
     * Load config from disk, creating default if missing.
     */
    public void load() {
        if (!Files.exists(configPath)) {
            try {
                Files.createDirectories(configPath.getParent());
                Files.writeString(configPath, DEFAULT_CONFIG);
                LOGGER.info("[KmDDNS] Created default config at " + configPath);
            } catch (IOException e) {
                LOGGER.warning("[KmDDNS] Could not write default config: " + e.getMessage());
            }
            return;
        }

        try {
            var lines = Files.readAllLines(configPath);
            parse(lines);
        } catch (IOException e) {
            LOGGER.warning("[KmDDNS] Could not read config file, using defaults: " + e.getMessage());
        }
    }

    private void parse(List<String> lines) {
        for (var rawLine : lines) {
            var line = rawLine.trim();

            if (line.isEmpty() || line.startsWith("#") || line.startsWith("[")) {
                continue;
            }

            int eqIdx = line.indexOf('=');
            if (eqIdx < 0) continue;

            var key = line.substring(0, eqIdx).trim();
            var value = line.substring(eqIdx + 1).trim();

            value = stripInlineComment(value);

            switch (key) {
                case "enabled" -> enabled = parseBoolean(value, true);
                case "token" -> token = parseString(value);
                case "api_base" -> apiBase = parseString(value);
                case "port" -> port = parseInt(value, 0);
                case "update_interval" -> updateInterval = parseInt(value, 300);
                case "tags" -> tags = parseStringArray(value);
                case "metadata_motd" -> metadataMotd = parseBoolean(value, true);
                case "metadata_player_count" -> metadataPlayerCount = parseBoolean(value, true);
                case "log_updates" -> logUpdates = parseBoolean(value, true);
                default -> { /* ignore unknown keys */ }
            }
        }
    }

    /**
     * Strip inline TOML comment (# not inside a quoted string).
     */
    private static String stripInlineComment(String value) {
        boolean inString = false;
        char stringChar = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!inString && (c == '"' || c == '\'')) {
                inString = true;
                stringChar = c;
            } else if (inString && c == stringChar && (i == 0 || value.charAt(i - 1) != '\\')) {
                inString = false;
            } else if (!inString && c == '#') {
                return value.substring(0, i).trim();
            }
        }
        return value;
    }

    private static String parseString(String value) {
        if (value.startsWith("\"") && value.endsWith("\"") && value.length() >= 2) {
            return value.substring(1, value.length() - 1)
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\");
        }
        if (value.startsWith("'") && value.endsWith("'") && value.length() >= 2) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }

    private static boolean parseBoolean(String value, boolean defaultVal) {
        return switch (value.toLowerCase()) {
            case "true" -> true;
            case "false" -> false;
            default -> defaultVal;
        };
    }

    private static int parseInt(String value, int defaultVal) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            return defaultVal;
        }
    }

    /**
     * Parse a TOML inline array of strings: ["a", "b", "c"]
     */
    private static List<String> parseStringArray(String value) {
        var result = new ArrayList<String>();
        if (!value.startsWith("[")) return result;

        var inner = value.substring(1, value.endsWith("]") ? value.length() - 1 : value.length()).trim();
        if (inner.isEmpty()) return result;

        var current = new StringBuilder();
        boolean inQuote = false;
        char quoteChar = 0;
        for (int i = 0; i < inner.length(); i++) {
            char c = inner.charAt(i);
            if (!inQuote && (c == '"' || c == '\'')) {
                inQuote = true;
                quoteChar = c;
            } else if (inQuote && c == quoteChar) {
                inQuote = false;
            } else if (!inQuote && c == ',') {
                var token = parseString(current.toString().trim());
                if (!token.isEmpty()) result.add(token);
                current.setLength(0);
                continue;
            }
            current.append(c);
        }
        var last = parseString(current.toString().trim());
        if (!last.isEmpty()) result.add(last);

        return result;
    }

    /**
     * Write current field values back to the config file.
     */
    public void save() {
        var sb = new StringBuilder();
        sb.append("[kmddns]\n");
        sb.append("enabled = ").append(enabled).append("\n");
        sb.append("token = \"").append(token.replace("\\", "\\\\").replace("\"", "\\\"")).append("\"\n");
        sb.append("api_base = \"").append(apiBase).append("\"\n");
        sb.append("port = ").append(port).append("\n");
        sb.append("update_interval = ").append(updateInterval).append("\n");
        sb.append("tags = [");
        for (int i = 0; i < tags.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append("\"").append(tags.get(i)).append("\"");
        }
        sb.append("]\n");
        sb.append("metadata_motd = ").append(metadataMotd).append("\n");
        sb.append("metadata_player_count = ").append(metadataPlayerCount).append("\n");
        sb.append("log_updates = ").append(logUpdates).append("\n");
        try {
            Files.createDirectories(configPath.getParent());
            Files.writeString(configPath, sb.toString());
            LOGGER.info("[KmDDNS] Config saved to " + configPath);
        } catch (IOException e) {
            LOGGER.warning("[KmDDNS] Could not save config: " + e.getMessage());
        }
    }

    /**
     * Check whether the config has a valid (non-empty) token.
     */
    public boolean hasToken() {
        return token != null && !token.isBlank();
    }

    @Override
    public String toString() {
        return "KmDDNSConfig{enabled=" + enabled + ", token=" + (hasToken() ? "[set]" : "[empty]") +
                ", apiBase=" + apiBase + ", port=" + port + ", updateInterval=" + updateInterval +
                ", tags=" + tags + ", metadataMotd=" + metadataMotd +
                ", metadataPlayerCount=" + metadataPlayerCount + ", logUpdates=" + logUpdates + "}";
    }
}
