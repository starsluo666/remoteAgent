// RemoteAgent relay — M0 skeleton.
// 房间 / 转发逻辑在 M2 实现；本阶段只验证：升级 WS、解析 hello、回 hello_ack。
package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // M3 收紧
}

// envelope 是所有消息的最小公共形状；载荷层消息 relay 不解析，这里只读 t。
type envelope struct {
	T        string `json:"t"`
	V        int    `json:"v,omitempty"`
	Role     string `json:"role,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Token    string `json:"token,omitempty"`
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true,"name":"remoteagent-relay","proto":1}`))
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()

	var msg envelope
	if err := conn.ReadJSON(&msg); err != nil {
		return
	}
	if msg.T != "hello" {
		conn.WriteJSON(map[string]string{"t": "error", "code": "protocol_error", "msg": "first message must be hello"})
		return
	}
	if msg.V != 1 {
		conn.WriteJSON(map[string]string{"t": "error", "code": "unsupported_version", "msg": "want proto v1"})
		return
	}
	// TODO(M2): 校验 token、按 role 建立/加入 deviceId 房间
	conn.WriteJSON(map[string]string{"t": "hello_ack", "deviceId": msg.DeviceID})
	log.Printf("hello: role=%s device=%s", msg.Role, msg.DeviceID)

	for {
		var raw json.RawMessage
		if err := conn.ReadJSON(&raw); err != nil {
			return
		}
		// TODO(M2): 载荷层消息原样转发给房间内其他连接
		_ = raw
	}
}

func main() {
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/ws", handleWS)
	log.Println("remoteagent-relay listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
