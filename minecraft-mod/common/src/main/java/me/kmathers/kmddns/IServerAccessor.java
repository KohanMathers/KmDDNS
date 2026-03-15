package me.kmathers.kmddns;

/**
 * Abstraction over loader-specific server APIs so common code
 * does not depend on Fabric or Forge at compile time.
 */
public interface IServerAccessor {
    int getPort();
    String getMotd();
    int getPlayerCount();
    int getMaxPlayers();
}
