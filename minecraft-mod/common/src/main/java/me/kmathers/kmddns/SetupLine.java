package me.kmathers.kmddns;

/**
 * Represents a single line of setup wizard output.
 * Plain lines are rendered as text; clickable lines get a ClickEvent attached.
 * Use the static factory methods for the three action types.
 */
public final class SetupLine {

    /**
     * Prefix stored in clickCommand to signal a COPY_TO_CLIPBOARD action.
     * Loaders detect this prefix and use the appropriate ClickEvent.
     */
    public static final String COPY_PREFIX = "\0COPY\0";

    public final String text;
    /** Null for plain lines; non-null for clickable lines. */
    public final String clickCommand;
    /** If true, use SUGGEST_COMMAND (fills chat box); false = RUN_COMMAND (runs immediately). Ignored for COPY actions. */
    public final boolean suggest;
    /** Optional hover tooltip. Null to omit. */
    public final String hoverText;

    /** Plain text line. */
    public SetupLine(String text) {
        this.text = text;
        this.clickCommand = null;
        this.suggest = false;
        this.hoverText = null;
    }

    /** Clickable line (RUN or SUGGEST). */
    public SetupLine(String text, String clickCommand, boolean suggest, String hoverText) {
        this.text = text;
        this.clickCommand = clickCommand;
        this.suggest = suggest;
        this.hoverText = hoverText;
    }

    /** Line that copies {@code valueToCopy} to the clipboard when clicked. */
    public static SetupLine copyable(String text, String valueToCopy, String hoverText) {
        return new SetupLine(text, COPY_PREFIX + valueToCopy, false, hoverText);
    }

    public boolean isClickable() {
        return clickCommand != null;
    }

    public boolean isCopy() {
        return clickCommand != null && clickCommand.startsWith(COPY_PREFIX);
    }

    /** Returns the raw value to copy (strips the prefix). Only meaningful when {@link #isCopy()} is true. */
    public String copyValue() {
        return clickCommand.substring(COPY_PREFIX.length());
    }
}
