package me.kmathers.kmddns;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.logging.Logger;

/**
 * Manages the persistent WebSocket connection from the Minecraft server to the
 * KmDDNS TunnelSession Durable Object.
 *
 * Binary frame format (matching TUNNEL.md):
 *   [type: 1 byte][connId: 4 bytes BE][length: 4 bytes BE][data: length bytes]
 *
 * Frame types:
 *   0x01 CONNECT    DO → host
 *   0x02 DATA       both
 *   0x03 DISCONNECT both
 *   0x04 ACK        host → DO
 */
public class KmDDNSTunnelClient {

    private static final Logger LOGGER = Logger.getLogger("KmDDNS");

    private static final byte FRAME_CONNECT    = 0x01;
    private static final byte FRAME_DATA       = 0x02;
    private static final byte FRAME_DISCONNECT = 0x03;
    private static final byte FRAME_ACK        = 0x04;

    private static final int HEADER_LEN = 9;

    private static final int[] BACKOFF_SECS = {5, 10, 30, 60};

    private final String apiBase;
    private final String token;
    private final int mcPort;

    private final HttpClient httpClient;
    private final ExecutorService executor;

    private volatile WebSocket ws;
    private volatile boolean running = false;
    private volatile boolean connected = false;

    /** connId → local TCP socket to the Minecraft server */
    private final Map<Integer, Socket> sockets = new ConcurrentHashMap<>();

    /** Accumulate partial WebSocket messages */
    private final ByteBuffer messageBuffer = ByteBuffer.allocate(4 * 1024 * 1024);
    private boolean bufferStarted = false;

    public KmDDNSTunnelClient(String apiBase, String token, int mcPort) {
        this.apiBase = apiBase;
        this.token = token;
        this.mcPort = mcPort;
        this.httpClient = HttpClient.newHttpClient();
        this.executor = Executors.newCachedThreadPool(r -> {
            var t = new Thread(r, "kmddns-tunnel");
            t.setDaemon(true);
            return t;
        });
    }

    /** Start the reconnect loop in a daemon thread. */
    public void start() {
        running = true;
        executor.submit(this::reconnectLoop);
    }

    /** Stop the client and close all open connections. */
    public void stop() {
        running = false;
        connected = false;
        closeAll();
        if (ws != null) {
            try { ws.sendClose(WebSocket.NORMAL_CLOSURE, "shutdown"); } catch (Exception ignored) {}
            ws = null;
        }
    }

    /** Whether the WebSocket is currently connected. */
    public boolean isConnected() {
        return connected;
    }

    private void reconnectLoop() {
        int attempt = 0;
        while (running) {
            try {
                connect();
                attempt = 0;
            } catch (Exception e) {
                connected = false;
                if (!running) break;
                int delaySecs = BACKOFF_SECS[Math.min(attempt, BACKOFF_SECS.length - 1)];
                LOGGER.warning("[KmDDNS] Tunnel WebSocket disconnected, retrying in " + delaySecs + "s: " + e.getMessage());
                attempt++;
                try { Thread.sleep(delaySecs * 1000L); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }
    }

    private void connect() throws Exception {
        String wsUrl = apiBase.replaceFirst("^http", "ws") + "/tunnel";

        CompletableFuture<Void> closedFuture = new CompletableFuture<>();

        httpClient.newWebSocketBuilder()
                .header("Authorization", "Bearer " + token)
                .buildAsync(URI.create(wsUrl), new WebSocket.Listener() {

                    @Override
                    public void onOpen(WebSocket webSocket) {
                        ws = webSocket;
                        connected = true;
                        LOGGER.info("[KmDDNS] Tunnel connected.");
                        webSocket.request(1);
                    }

                    @Override
                    public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
                        handleBinaryChunk(data, last);
                        webSocket.request(1);
                        return null;
                    }

                    @Override
                    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                        connected = false;
                        closeAll();
                        closedFuture.complete(null);
                        return null;
                    }

                    @Override
                    public void onError(WebSocket webSocket, Throwable error) {
                        connected = false;
                        closeAll();
                        closedFuture.completeExceptionally(error);
                    }
                }).get();

        closedFuture.get();
    }

    private synchronized void handleBinaryChunk(ByteBuffer data, boolean last) {
        if (!bufferStarted) {
            messageBuffer.clear();
            bufferStarted = true;
        }
        messageBuffer.put(data);
        if (last) {
            bufferStarted = false;
            messageBuffer.flip();
            byte[] arr = new byte[messageBuffer.remaining()];
            messageBuffer.get(arr);
            messageBuffer.clear();
            handleFrame(arr);
        }
    }

    private void handleFrame(byte[] buf) {
        if (buf.length < HEADER_LEN) return;

        byte type   = buf[0];
        int connId  = readInt(buf, 1);
        int length  = readInt(buf, 5);
        if (buf.length < HEADER_LEN + length) return;

        byte[] data = new byte[length];
        System.arraycopy(buf, HEADER_LEN, data, 0, length);

        switch (type) {
            case FRAME_CONNECT    -> handleConnect(connId, data);
            case FRAME_DATA       -> handleData(connId, data);
            case FRAME_DISCONNECT -> handleDisconnect(connId);
            default -> {}
        }
    }

    private void handleConnect(int connId, byte[] initialData) {
        try {
            var socket = new Socket("127.0.0.1", mcPort);
            sockets.put(connId, socket);

            sendFrame(FRAME_ACK, connId, new byte[0]);

            if (initialData.length > 0) {
                socket.getOutputStream().write(initialData);
                socket.getOutputStream().flush();
            }

            executor.submit(() -> pipeLocalToWs(connId, socket));
        } catch (Exception e) {
            LOGGER.warning("[KmDDNS] Could not connect to local MC server for connId=" + connId + ": " + e.getMessage());
            sendFrame(FRAME_DISCONNECT, connId, new byte[0]);
        }
    }

    private void handleData(int connId, byte[] data) {
        var socket = sockets.get(connId);
        if (socket == null) return;
        try {
            OutputStream out = socket.getOutputStream();
            out.write(data);
            out.flush();
        } catch (Exception e) {
            closeConn(connId);
        }
    }

    private void handleDisconnect(int connId) {
        closeConn(connId);
    }

    private void pipeLocalToWs(int connId, Socket socket) {
        try {
            InputStream in = socket.getInputStream();
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                byte[] payload = new byte[n];
                System.arraycopy(buf, 0, payload, 0, n);
                sendFrame(FRAME_DATA, connId, payload);
            }
        } catch (Exception ignored) {
        } finally {
            closeConn(connId);
            sendFrame(FRAME_DISCONNECT, connId, new byte[0]);
        }
    }

    private void sendFrame(byte type, int connId, byte[] data) {
        WebSocket localWs = ws;
        if (localWs == null) return;
        byte[] frame = new byte[HEADER_LEN + data.length];
        frame[0] = type;
        writeInt(frame, 1, connId);
        writeInt(frame, 5, data.length);
        System.arraycopy(data, 0, frame, HEADER_LEN, data.length);
        localWs.sendBinary(ByteBuffer.wrap(frame), true);
    }

    private void closeConn(int connId) {
        var socket = sockets.remove(connId);
        if (socket != null) {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private void closeAll() {
        for (var connId : sockets.keySet()) {
            closeConn(connId);
        }
    }

    private static int readInt(byte[] buf, int offset) {
        return ((buf[offset] & 0xFF) << 24)
             | ((buf[offset + 1] & 0xFF) << 16)
             | ((buf[offset + 2] & 0xFF) << 8)
             |  (buf[offset + 3] & 0xFF);
    }

    private static void writeInt(byte[] buf, int offset, int value) {
        buf[offset]     = (byte) (value >> 24);
        buf[offset + 1] = (byte) (value >> 16);
        buf[offset + 2] = (byte) (value >> 8);
        buf[offset + 3] = (byte) value;
    }
}
