// ═══════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — TCP-to-UDS Test Bridge
//  ═══════════════════════════════════════════════════════════════
//
//  k6 cannot natively connect to Unix Domain Sockets. This thin
//  Go proxy bridges TCP port 9090 to the sidecar's UDS. It exists
//  ONLY for load testing — it is NOT part of the production runtime.
//
//  Usage:
//    go run bridge_test_proxy.go
//    k6 run load_test.js
//
//  Performance:
//    The bridge adds ~30-50µs of overhead (TCP accept + UDS dial).
//    The k6 script records the sidecar-reported latency_us from the
//    response body, not the HTTP roundtrip, so bridge overhead does
//    not contaminate the SLA measurement.
//
// ═══════════════════════════════════════════════════════════════

package main

import (
	"io"
	"log"
	"net"
	"net/http"
	"os"
)

func main() {
	socketPath := os.Getenv("SENTINEL_SIDECAR_SOCKET")
	if socketPath == "" {
		socketPath = "/tmp/sentinel_sovereign.sock"
	}

	listenAddr := os.Getenv("BRIDGE_LISTEN")
	if listenAddr == "" {
		listenAddr = ":9090"
	}

	log.Printf("[BRIDGE] TCP %s → UDS %s", listenAddr, socketPath)

	http.HandleFunc("/arbitrate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}

		// Connect to the sidecar's UDS
		conn, err := net.Dial("unix", socketPath)
		if err != nil {
			http.Error(w, "sidecar unavailable: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		defer conn.Close()

		// Forward the request body to the UDS
		if _, err := io.Copy(conn, r.Body); err != nil {
			http.Error(w, "write to sidecar failed: "+err.Error(), http.StatusBadGateway)
			return
		}

		// Read the sidecar response and forward to HTTP response
		w.Header().Set("Content-Type", "application/json")
		io.Copy(w, conn)
	})

	log.Fatal(http.ListenAndServe(listenAddr, nil))
}
