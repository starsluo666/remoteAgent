package main

import "testing"

// hub 逻辑单测：房间注册 / 重复注册 / viewer 加入 / 踢除（无真实 ws，仅逻辑路径）

func fakeConn() *conn {
	return &conn{send: make(chan []byte, 8)}
}

func TestRegisterAndDuplicate(t *testing.T) {
	h := newHub()
	d := fakeConn()
	if ack := h.registerDaemon("dev1", "key1", d); isErr(ack) {
		t.Fatalf("first register should succeed: %s", ack)
	}
	d2 := fakeConn()
	if ack := h.registerDaemon("dev1", "key1", d2); !isErr(ack) {
		t.Fatalf("duplicate register should be rejected, got: %s", ack)
	}
	// 原连接注销后允许重新注册
	h.unregister(d)
	if ack := h.registerDaemon("dev1", "key1", d2); isErr(ack) {
		t.Fatalf("re-register after offline should succeed: %s", ack)
	}
}

func TestJoinClientRequiresOnlineDaemon(t *testing.T) {
	h := newHub()
	c := fakeConn()
	if ack := h.joinClient("dev-none", c); !isErr(ack) {
		t.Fatalf("join to missing room should fail, got: %s", ack)
	}
	d := fakeConn()
	h.registerDaemon("dev1", "k", d)
	c2 := fakeConn()
	if ack := h.joinClient("dev1", c2); isErr(ack) {
		t.Fatalf("join with online daemon should succeed: %s", ack)
	}
	// 单 viewer：第二个加入被拒
	c3 := fakeConn()
	if ack := h.joinClient("dev1", c3); !isErr(ack) {
		t.Fatalf("second viewer should be busy, got: %s", ack)
	}
}

func TestKickClientsClearsViewers(t *testing.T) {
	h := newHub()
	d := fakeConn()
	h.registerDaemon("dev1", "k", d)
	c := fakeConn()
	h.joinClient("dev1", c)

	h.kickClients("dev1")

	// viewer 被移出房间后，新的 viewer 可立即加入（daemon 隧道保留）
	c2 := fakeConn()
	if ack := h.joinClient("dev1", c2); isErr(ack) {
		t.Fatalf("viewer should be able to rejoin after kick: %s", ack)
	}
	// 被踢 viewer 应收到 kicked 错误帧
	select {
	case b := <-c.send:
		if !isErr(b) {
			t.Fatalf("kicked viewer should get error frame, got: %s", b)
		}
	default:
		t.Fatal("kicked viewer should have received a message")
	}
}
