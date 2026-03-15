package me.kmathers.kmddns.forge;

import me.kmathers.kmddns.IServerAccessor;
import net.minecraft.server.MinecraftServer;

/**
 * Forge implementation of IServerAccessor.
 * Delegates to the running MinecraftServer instance.
 */
public class ForgeServerAccessor implements IServerAccessor {

    private final MinecraftServer server;

    public ForgeServerAccessor(MinecraftServer server) {
        this.server = server;
    }

    @Override
    public int getPort() {
        return server.getPort();
    }

    @Override
    public String getMotd() {
        return server.getMotd();
    }

    @Override
    public int getPlayerCount() {
        return server.getPlayerCount();
    }

    @Override
    public int getMaxPlayers() {
        return server.getMaxPlayers();
    }
}
