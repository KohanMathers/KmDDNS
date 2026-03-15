// KmDDNS Relay — stateless TCP relay for Minecraft tunnel mode.
//
// Reads the Minecraft handshake packet to extract the target subdomain,
// opens a WebSocket to the KmDDNS Worker's /v1/tunnel/relay/{subdomain}
// endpoint, and pipes TCP ↔ WebSocket frames using the binary protocol
// defined in TUNNEL.md.
//
// Config (environment variables):
//   WORKER_URL    — Base URL of the Worker, e.g. https://ddns.kmathers.co.uk/v1
//   RELAY_SECRET  — Shared secret; sent as X-Relay-Secret header
//   LISTEN_PORT   — TCP port to listen on (default 25565)
package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"nhooyr.io/websocket"
)

const (
	frameConnect    byte = 0x01
	frameData       byte = 0x02
	frameDisconnect byte = 0x03
	frameACK        byte = 0x04
)

const headerLen = 9

var connCounter atomic.Uint32

func nextConnID() uint32 {
	return connCounter.Add(1)
}

func encodeFrame(typ byte, connID uint32, data []byte) []byte {
	buf := make([]byte, headerLen+len(data))
	buf[0] = typ
	binary.BigEndian.PutUint32(buf[1:5], connID)
	binary.BigEndian.PutUint32(buf[5:9], uint32(len(data)))
	copy(buf[headerLen:], data)
	return buf
}

func decodeFrame(buf []byte) (typ byte, connID uint32, payload []byte, ok bool) {
	if len(buf) < headerLen {
		return 0, 0, nil, false
	}
	typ = buf[0]
	connID = binary.BigEndian.Uint32(buf[1:5])
	length := binary.BigEndian.Uint32(buf[5:9])
	if len(buf) < headerLen+int(length) {
		return 0, 0, nil, false
	}
	return typ, connID, buf[headerLen : headerLen+length], true
}

func readVarInt(r io.Reader) (int32, error) {
	var value int32
	var shift uint
	buf := make([]byte, 1)
	for {
		if _, err := io.ReadFull(r, buf); err != nil {
			return 0, err
		}
		b := buf[0]
		value |= int32(b&0x7F) << shift
		if b&0x80 == 0 {
			break
		}
		shift += 7
		if shift >= 35 {
			return 0, fmt.Errorf("VarInt too long")
		}
	}
	return value, nil
}

func readHandshake(conn net.Conn) (serverAddress string, raw []byte, err error) {
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer conn.SetReadDeadline(time.Time{})

	var lengthBytes []byte
	pktLen, err := func() (int32, error) {
		var value int32
		var shift uint
		b := make([]byte, 1)
		for {
			if _, e := io.ReadFull(conn, b); e != nil {
				return 0, e
			}
			lengthBytes = append(lengthBytes, b[0])
			value |= int32(b[0]&0x7F) << shift
			if b[0]&0x80 == 0 {
				break
			}
			shift += 7
			if shift >= 35 {
				return 0, fmt.Errorf("VarInt too long")
			}
		}
		return value, nil
	}()
	if err != nil {
		return "", nil, fmt.Errorf("reading packet length: %w", err)
	}

	body := make([]byte, pktLen)
	if _, err := io.ReadFull(conn, body); err != nil {
		return "", nil, fmt.Errorf("reading packet body: %w", err)
	}
	raw = append(lengthBytes, body...)

	r := strings.NewReader(string(body))

	if _, err := readVarInt(r); err != nil {
		return "", nil, fmt.Errorf("reading packet ID: %w", err)
	}
	if _, err := readVarInt(r); err != nil {
		return "", nil, fmt.Errorf("reading protocol version: %w", err)
	}
	addrLen, err := readVarInt(r)
	if err != nil {
		return "", nil, fmt.Errorf("reading serverAddress length: %w", err)
	}
	addrBuf := make([]byte, addrLen)
	if _, err := io.ReadFull(r, addrBuf); err != nil {
		return "", nil, fmt.Errorf("reading serverAddress: %w", err)
	}
	serverAddress = string(addrBuf)

	if idx := strings.IndexByte(serverAddress, '\x00'); idx >= 0 {
		serverAddress = serverAddress[:idx]
	}

	return serverAddress, raw, nil
}

func extractSubdomain(serverAddress string) string {
	addr := strings.ToLower(strings.TrimSuffix(serverAddress, "."))
	if idx := strings.IndexByte(addr, '.'); idx >= 0 {
		return addr[:idx]
	}
	return addr
}

func handleConn(ctx context.Context, conn net.Conn, workerURL, relaySecret string) {
	defer conn.Close()

	serverAddress, handshakeRaw, err := readHandshake(conn)
	if err != nil {
		log.Printf("handshake error from %s: %v", conn.RemoteAddr(), err)
		return
	}

	subdomain := extractSubdomain(serverAddress)
	log.Printf("new connection from %s → subdomain=%q", conn.RemoteAddr(), subdomain)

	wsURL := strings.TrimSuffix(workerURL, "/") + "/tunnel/relay/" + subdomain

	wsConn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: map[string][]string{
			"X-Relay-Secret": {relaySecret},
		},
	})
	if err != nil {
		log.Printf("WebSocket dial failed for %q: %v", subdomain, err)
		return
	}
	defer wsConn.Close(websocket.StatusNormalClosure, "relay done")

	connID := nextConnID()

	connectFrame := encodeFrame(frameConnect, connID, handshakeRaw)
	if err := wsConn.Write(ctx, websocket.MessageBinary, connectFrame); err != nil {
		log.Printf("failed to send CONNECT frame: %v", err)
		return
	}

	var wg sync.WaitGroup
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		buf := make([]byte, 32*1024)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				frame := encodeFrame(frameData, connID, buf[:n])
				if werr := wsConn.Write(connCtx, websocket.MessageBinary, frame); werr != nil {
					return
				}
			}
			if err != nil {
				disc := encodeFrame(frameDisconnect, connID, nil)
				_ = wsConn.Write(connCtx, websocket.MessageBinary, disc)
				return
			}
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			_, msg, err := wsConn.Read(connCtx)
			if err != nil {
				return
			}
			typ, fConnID, payload, ok := decodeFrame(msg)
			if !ok || fConnID != connID {
				continue
			}
			switch typ {
			case frameData:
				if _, werr := conn.Write(payload); werr != nil {
					return
				}
			case frameDisconnect:
				return
			case frameACK:
				// host acknowledged — nothing to do on relay side
			}
		}
	}()

	wg.Wait()
}

func main() {
	workerURL := os.Getenv("WORKER_URL")
	if workerURL == "" {
		log.Fatal("WORKER_URL environment variable is required")
	}
	relaySecret := os.Getenv("RELAY_SECRET")
	if relaySecret == "" {
		log.Fatal("RELAY_SECRET environment variable is required")
	}
	listenPort := os.Getenv("LISTEN_PORT")
	if listenPort == "" {
		listenPort = "25565"
	}
	if _, err := strconv.Atoi(listenPort); err != nil {
		log.Fatalf("LISTEN_PORT must be a number, got %q", listenPort)
	}

	ln, err := net.Listen("tcp", ":"+listenPort)
	if err != nil {
		log.Fatalf("failed to listen on :%s: %v", listenPort, err)
	}
	log.Printf("KmDDNS relay listening on :%s → %s", listenPort, workerURL)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			log.Printf("accept error: %v", err)
			continue
		}
		go handleConn(ctx, conn, workerURL, relaySecret)
	}

	log.Println("relay shutting down")
}
