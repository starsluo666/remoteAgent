// 房间模型：每个设备一个房间。daemon 是房间所有者（出站注册），
// 多个 client 凭配对 token 加入。中继只转发载荷，不解析内容。
package main

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

const sendQueue = 64

// envelope 只解析控制层；载荷层原样转发。
type envelope struct {
	T        string `json:"t"`
	V        int    `json:"v,omitempty"`
	Role     string `json:"role,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Token    string `json:"token,omitempty"`
}

type conn struct {
	ws       *websocket.Conn
	send     chan []byte
	deviceID string
	role     string

	closeOnce sync.Once
}

func (c *conn) sendMsg(b []byte) bool {
	select {
	case c.send <- b:
		return true
	default:
		// 慢消费者：踢掉，避免拖死整个房间
		log.Printf("kick slow %s conn device=%s", c.role, c.deviceID)
		c.shutdown()
		return false
	}
}

func (c *conn) shutdown() {
	c.closeOnce.Do(func() {
		close(c.send)
		c.ws.Close()
	})
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func errPayload(code, msg string) []byte {
	return mustJSON(map[string]string{"t": "error", "code": code, "msg": msg})
}

type room struct {
	mu      sync.Mutex
	daemon  *conn
	token   string
	clients map[*conn]bool
}

type hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func newHub() *hub {
	return &hub{rooms: make(map[string]*room)}
}

// registerDaemon：daemon 出站注册。房间已有在线 daemon 时拒绝。
func (h *hub) registerDaemon(deviceID, token string, c *conn) []byte {
	h.mu.Lock()
	r, ok := h.rooms[deviceID]
	if !ok {
		r = &room{clients: make(map[*conn]bool)}
		h.rooms[deviceID] = r
	}
	h.mu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.daemon != nil {
		return errPayload("device_already_online", "device already has an online daemon")
	}
	r.daemon = c
	r.token = token
	c.deviceID, c.role = deviceID, "daemon"

	r.broadcastToClients(mustJSON(map[string]any{"t": "presence", "deviceId": deviceID, "online": true}))
	log.Printf("daemon online device=%s clients=%d", deviceID, len(r.clients))
	return mustJSON(map[string]string{"t": "hello_ack", "deviceId": deviceID})
}

// joinClient：client 凭配对 token 加入房间（daemon 必须在线）。
func (h *hub) joinClient(deviceID, token string, c *conn) []byte {
	h.mu.Lock()
	r, ok := h.rooms[deviceID]
	h.mu.Unlock()
	if !ok {
		return errPayload("device_offline", "no such device")
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.daemon == nil {
		return errPayload("device_offline", "device daemon is offline")
	}
	if token != r.token {
		return errPayload("auth_failed", "bad pairing token")
	}
	r.clients[c] = true
	c.deviceID, c.role = deviceID, "client"
	log.Printf("client joined device=%s clients=%d", deviceID, len(r.clients))
	return mustJSON(map[string]string{"t": "hello_ack", "deviceId": deviceID})
}

// forward：载荷层消息原样转发。daemon → 所有 client；client → daemon。
func (h *hub) forward(from *conn, raw []byte) {
	h.mu.Lock()
	r, ok := h.rooms[from.deviceID]
	h.mu.Unlock()
	if !ok {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if from.role == "daemon" {
		for c := range r.clients {
			c.sendMsg(raw)
		}
	} else {
		if r.daemon == nil {
			from.sendMsg(errPayload("device_offline", "device daemon is offline"))
			return
		}
		r.daemon.sendMsg(raw)
	}
}

// unregister：连接断开时清理；daemon 离线要广播 presence。
func (h *hub) unregister(c *conn) {
	h.mu.Lock()
	r, ok := h.rooms[c.deviceID]
	h.mu.Unlock()
	if !ok {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if c.role == "daemon" && r.daemon == c {
		r.daemon = nil
		r.broadcastToClients(mustJSON(map[string]any{"t": "presence", "deviceId": c.deviceID, "online": false}))
		log.Printf("daemon offline device=%s", c.deviceID)
	} else {
		delete(r.clients, c)
	}

	// 房间空了就回收
	if r.daemon == nil && len(r.clients) == 0 {
		h.mu.Lock()
		delete(h.rooms, c.deviceID)
		h.mu.Unlock()
	}
}

// 调用方需持有 r.mu
func (r *room) broadcastToClients(b []byte) {
	for c := range r.clients {
		c.sendMsg(b)
	}
}
