// RemoteAgent relay — WebSocket 房间中继 + 静态托管 web 客户端。
// 用法：relay.exe [-listen 0.0.0.0:8080] [-web ../web/dist]
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // M3 收紧
}

// cacheHeaders：index.html 永远回源校验（否则浏览器缓存旧入口、
// 引用旧 assets，前端更新永远到不了用户）；带哈希的 assets 长缓存。
func cacheHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	// 放开 CORS：本机面板跨源测延迟用
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true,"name":"remoteagent-relay","proto":1}`))
}

// handlePresence：单设备在线状态查询（全私有模型：无设备枚举）。
// 必须携带目标 deviceId；配置了 relay_key 时必须匹配 —— 供 daemon 面板
// 查自己的查看者数，陌生人无法探测任何设备的存在。
func handlePresence(h *hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		dev := q.Get("device")
		if dev == "" {
			http.Error(w, "device required", http.StatusBadRequest)
			return
		}
		if h.relayKey != "" && q.Get("key") != h.relayKey {
			http.Error(w, "bad relay key", http.StatusForbidden)
			return
		}
		online, viewers := h.presence(dev)
		json.NewEncoder(w).Encode(map[string]any{
			"deviceId": dev,
			"online":   online,
			"viewers":  viewers,
		})
	}
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

	// 防护：单帧上限 1MB（默认不限长，公网会被巨型帧 OOM）；
	// 读超时 + ping/pong 双续期：空闲连接由对端周期 ping 保活，超时即判定死亡。
	// 关键：gorilla 的 ReadMessage 只对数据帧返回——控制帧（Ping）走 handler
	// 且不触发循环体的续期。若只在 PongHandler 续期，daemon 发的是 Ping，
	// 90 秒后必死（实测：E2E 认证后 kick 流停止 → 只剩 Ping → 恰好 90s 断）
	const pongWait = 90 * time.Second
	const writeWait = 10 * time.Second
	c.ws.SetReadLimit(1 << 20)
	c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(pongWait))
	})
	c.ws.SetPingHandler(func(appData string) error {
		if err := c.ws.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
			return err
		}
		// 保留默认行为：回 Pong（续写超时由 writeWait 控制）
		return c.ws.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(writeWait))
	})

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
	if e.DeviceID == "" {
		c.sendMsg(errPayload("auth_failed", "deviceId required"))
		return
	}
	// token 只用于 daemon 注册；客户端认证由 daemon 侧 E2E 握手完成
	if e.Role == "daemon" && e.Token == "" {
		c.sendMsg(errPayload("auth_failed", "daemon token required"))
		return
	}

	var ack []byte
	switch e.Role {
	case "daemon":
		ack = h.registerDaemon(e.DeviceID, e.Token, c)
	case "client":
		ack = h.joinClient(e.DeviceID, c)
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
		// 任何流量（含 ws 控制帧，pong 已由 handler 续期）都视为活跃
		c.ws.SetReadDeadline(time.Now().Add(pongWait))
		if t != websocket.TextMessage {
			continue
		}
		// 控制层：只认 ping / kick；其余全部按载荷转发（原样字节，不解不改）
		var probe envelope
		if err := json.Unmarshal(raw, &probe); err == nil {
			switch probe.T {
			case "ping":
				c.sendMsg(mustJSON(map[string]string{"t": "pong"}))
				continue
			case "kick":
				// daemon 主动断开房间里的 viewer（未认证超时等）；只有 daemon 可发
				if c.role == "daemon" {
					h.kickClients(c.deviceID)
				}
				continue
			case "hello":
				continue // 已握手，忽略重复 hello
			}
		}
		log.Printf("forward role=%s device=%s bytes=%d", c.role, c.deviceID, len(raw)); h.forward(c, raw)
	}
}

func writePump(c *conn) {
	for b := range c.send {
		if err := c.ws.WriteMessage(websocket.TextMessage, b); err != nil {
			c.shutdown()
			return
		}
	}
	c.ws.Close()
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
	// 公网必配：daemon 注册密钥白名单（防伪造 daemon 抢注设备房间把真设备锁在门外）。
	// 留空 = 不校验（仅限本地/内网开发）；也可用环境变量 REMOTEAGENT_RELAY_KEY。
	expectedKey := flag.String("relay-key", os.Getenv("REMOTEAGENT_RELAY_KEY"), "expected daemon relay key (required for public deploy)")
	flag.Parse()

	h := newHub(*expectedKey)
	if *expectedKey != "" {
		log.Printf("relay-key allowlist enabled")
	} else {
		log.Printf("WARNING: relay-key not set — any daemon can register any deviceId (fine for localhost, NOT for public deploy)")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/api/presence", handlePresence(h))
	mux.HandleFunc("/ws", handleWS(h))

	if *webDir != "" {
		if st, err := os.Stat(*webDir); err == nil && st.IsDir() {
			mux.Handle("/", cacheHeaders(http.FileServer(http.Dir(*webDir))))
			log.Printf("serving web client from %s", *webDir)
		} else {
			log.Printf("web dir %s not found, static serving disabled", *webDir)
		}
	}

	log.Printf("remoteagent-relay listening on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, mux))
}
