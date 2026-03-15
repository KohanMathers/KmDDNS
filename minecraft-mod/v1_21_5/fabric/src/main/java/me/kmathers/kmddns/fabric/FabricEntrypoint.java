package me.kmathers.kmddns.fabric;

import me.kmathers.kmddns.KmDDNSMod;
import me.kmathers.kmddns.SetupLine;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.Style;

import java.util.List;
import java.util.logging.Logger;

/**
 * Fabric mod entry point (dedicated_server).
 * Hooks into server lifecycle events and registers /kmddns commands.
 */
public class FabricEntrypoint implements DedicatedServerModInitializer {

    private static final Logger LOGGER = Logger.getLogger("KmDDNS");

    private KmDDNSMod mod;

    @Override
    public void onInitializeServer() {
        LOGGER.info("[KmDDNS] Initializing Fabric mod...");

        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            var accessor = new FabricServerAccessor(server);
            var configDir = server.getServerDirectory().resolve("config");
            mod = new KmDDNSMod(configDir, accessor);
            mod.onServerStart(server.getServerDirectory());
        });

        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            if (mod != null) {
                mod.onServerStop();
            }
        });

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            dispatcher.register(
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
                                    .then(Commands.literal("confirm")
                                            .executes(this::executeSetupConfirm))
                                    .then(Commands.literal("cancel")
                                            .executes(this::executeSetupCancel)))
            );
        });

        LOGGER.info("[KmDDNS] Fabric mod initialized.");
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
