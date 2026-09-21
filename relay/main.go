// RemoteAgent relay — WebSocket 房间中继 + 静态托管 web 客户端。
// 用法：relay.exe [-listen 0.0.0.0:8080] [-web ../web/dist]
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // M3 收紧
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true,"name":"remoteagent-relay","proto":1}`))
}

func handleWS(h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("upgrade: %v", err)
			return
		}
		c := &conn{ws: ws, send: make(chan []byte, sendQueue)}
		go writePump(c)
		readPump(h, c)
	}
}

func readPump(h *hub, c *conn) {
	defer func() {
		h.unregister(c)
		c.shutdown()
	}()

	// 握手：第一条必须是 hello v1
	var e envelope
	if err := c.ws.ReadJSON(&e); err != nil {
		return
	}
	if e.T != "hello" {
		c.sendMsg(errPayload("protocol_error", "first message must be hello"))
		return
	}
	if e.V != 1 {
		c.sendMsg(errPayload("unsupported_version", "want proto v1"))
		return
	}
	if e.DeviceID == "" || e.Token == "" {
		c.sendMsg(errPayload("auth_failed", "deviceId and token required"))
		return
	}

	var ack []byte
	switch e.Role {
	case "daemon":
		ack = h.registerDaemon(e.DeviceID, e.Token, c)
	case "client":
		ack = h.joinClient(e.DeviceID, e.Token, c)
	default:
		ack = errPayload("auth_failed", "role must be daemon or client")
	}
	if !c.sendMsg(ack) {
		return
	}
	if isErr(ack) {
		return // 握手失败，直接断开
	}

	for {
		t, raw, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		if t != websocket.TextMessage {
			continue
		}
		// 控制层：只认 ping；其余全部按载荷转发（原样字节，不解不改）
		var probe envelope
		if err := json.Unmarshal(raw, &probe); err == nil {
			switch probe.T {
			case "ping":
				c.sendMsg(mustJSON(map[string]string{"t": "pong"}))
				continue
			case "hello":
				continue // 已握手，忽略重复 hello
			}
		}
		h.forward(c, raw)
	}
}

func writePump(c *conn) {
	for b := range c.send {
		if err := c.ws.WriteMessage(websocket.TextMessage, b); err != nil {
			c.shutdown()
			return
		}
	}
}

func isErr(b []byte) bool {
	var e envelope
	if err := json.Unmarshal(b, &e); err != nil {
		return false
	}
	return e.T == "error"
}

func main() {
	listen := flag.String("listen", "0.0.0.0:8080", "listen address")
	webDir := flag.String("web", "../web/dist", "web client dist dir (empty to disable)")
	flag.Parse()

	h := newHub()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/ws", handleWS(h))

	if *webDir != "" {
		if st, err := os.Stat(*webDir); err == nil && st.IsDir() {
			mux.Handle("/", http.FileServer(http.Dir(*webDir)))
			log.Printf("serving web client from %s", *webDir)
		} else {
			log.Printf("web dir %s not found, static serving disabled", *webDir)
		}
	}

	log.Printf("remoteagent-relay listening on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, mux))
}
