package me.kmathers.kmddns.forge;

import me.kmathers.kmddns.KmDDNSMod;
import me.kmathers.kmddns.SetupLine;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.Style;
import net.minecraft.server.MinecraftServer;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.server.ServerStartingEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.Mod;

import java.util.List;
import java.util.logging.Logger;

/**
 * NeoForge mod entry point.
 * Subscribes to server lifecycle events and registers /kmddns commands.
 */
@Mod("kmddns")
public class ForgeEntrypoint {

    private static final Logger LOGGER = Logger.getLogger("KmDDNS");

    private KmDDNSMod mod;

    public ForgeEntrypoint() {
        LOGGER.info("[KmDDNS] Initializing NeoForge mod...");
        NeoForge.EVENT_BUS.register(this);
        LOGGER.info("[KmDDNS] NeoForge mod initialized.");
    }

    @SubscribeEvent
    public void onServerStarting(ServerStartingEvent event) {
        MinecraftServer server = event.getServer();
        var accessor = new ForgeServerAccessor(server);
        var configDir = server.getServerDirectory().resolve("config");
        mod = new KmDDNSMod(configDir, accessor);
        mod.onServerStart(server.getServerDirectory());
    }

    @SubscribeEvent
    public void onServerStopping(ServerStoppingEvent event) {
        if (mod != null) {
            mod.onServerStop();
        }
    }

    @SubscribeEvent
    public void onRegisterCommands(RegisterCommandsEvent event) {
        event.getDispatcher().register(
                Commands.literal("kmddns")
                        .requires(source -> source.hasPermission(2))
                        .then(Commands.literal("status")
                                .executes(this::executeStatus))
                        .then(Commands.literal("setup")
                                .executes(this::executeSetupStart)
                                .then(Commands.literal("token")
                                        .then(Commands.argument("token", StringArgumentType.greedyString())
                                                .executes(this::executeSetupToken)))
                                .then(Commands.literal("new")
                                        .executes(this::executeSetupNew))
                                .then(Commands.literal("subdomain")
                                        .then(Commands.argument("name", StringArgumentType.word())
                                                .executes(this::executeSetupSubdomain)))
                                .then(Commands.literal("email")
                                        .then(Commands.literal("skip")
                                                .executes(this::executeSetupEmailSkip))
                                        .then(Commands.argument("email", StringArgumentType.greedyString())
                                                .executes(this::executeSetupEmail)))
                                .then(Commands.literal("port")
                                        .then(Commands.literal("auto")
                                                .executes(this::executeSetupPortAuto))
                                        .then(Commands.argument("port", IntegerArgumentType.integer(1, 65535))
                                                .executes(this::executeSetupPortNumber)))
                                .then(Commands.literal("interval")
                                        .then(Commands.argument("seconds", IntegerArgumentType.integer(30))
                                                .executes(this::executeSetupInterval)))
                                .then(Commands.literal("tunnel")
                                        .then(Commands.literal("enable")
                                                .executes(this::executeSetupTunnelEnable))
                                        .then(Commands.literal("disable")
                                                .executes(this::executeSetupTunnelDisable)))
                                .then(Commands.literal("confirm")
                                        .executes(this::executeSetupConfirm))
                                .then(Commands.literal("cancel")
                                        .executes(this::executeSetupCancel)))
        );
    }


    private int executeStatus(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        for (var line : mod.getStatusLines()) {
            context.getSource().sendSystemMessage(Component.literal(line));
        }
        return 1;
    }


    private int executeSetupStart(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupStart());
        return 1;
    }

    private int executeSetupToken(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupToken(StringArgumentType.getString(context, "token")));
        return 1;
    }

    private int executeSetupNew(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupNew());
        return 1;
    }

    private int executeSetupSubdomain(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupSubdomain(StringArgumentType.getString(context, "name")));
        return 1;
    }

    private int executeSetupEmail(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupEmail(StringArgumentType.getString(context, "email")));
        return 1;
    }

    private int executeSetupEmailSkip(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupEmailSkip());
        return 1;
    }

    private int executeSetupPortAuto(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupPortAuto());
        return 1;
    }

    private int executeSetupPortNumber(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupPortNumber(IntegerArgumentType.getInteger(context, "port")));
        return 1;
    }

    private int executeSetupInterval(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupInterval(IntegerArgumentType.getInteger(context, "seconds")));
        return 1;
    }

    private int executeSetupConfirm(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupConfirm());
        return 1;
    }

    private int executeSetupTunnelEnable(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupTunnelEnable());
        return 1;
    }

    private int executeSetupTunnelDisable(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupTunnelDisable());
        return 1;
    }

    private int executeSetupCancel(CommandContext<CommandSourceStack> context) {
        if (mod == null) { notInitialized(context); return 0; }
        sendSetupLines(context.getSource(), mod.handleSetupCancel());
        return 1;
    }


    private void sendSetupLines(CommandSourceStack source, List<SetupLine> lines) {
        for (var line : lines) {
            if (!line.isClickable()) {
                source.sendSystemMessage(Component.literal(line.text));
                continue;
            }
            ClickEvent clickEvent;
            if (line.isCopy()) {
                clickEvent = new ClickEvent.CopyToClipboard(line.copyValue());
            } else if (line.suggest) {
                clickEvent = new ClickEvent.SuggestCommand(line.clickCommand);
            } else {
                clickEvent = new ClickEvent.RunCommand(line.clickCommand);
            }
            Style style = Style.EMPTY.withClickEvent(clickEvent);
            if (line.hoverText != null) {
                style = style.withHoverEvent(new HoverEvent.ShowText(Component.literal(line.hoverText)));
            }
            source.sendSystemMessage(Component.literal(line.text).withStyle(style));
        }
    }

    private void notInitialized(CommandContext<CommandSourceStack> context) {
        context.getSource().sendSystemMessage(Component.literal("§c[KmDDNS] Mod not yet initialized."));
    }
}
