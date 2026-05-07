// ═══════════════════════════════════════════════════════════════
//  SENTINEL V5.5 — Inference Circuit Breaker
//  ═══════════════════════════════════════════════════════════════
//
//  Implements the "Split-Brain" protection for the LLM Inference
//  layer. If the Governance Hub or Vertex AI becomes degraded,
//  the circuit breaker opens and the sidecar enters a safe
//  degraded mode.
//
//  State Machine:
//
//    ┌────────┐  success   ┌────────┐
//    │ CLOSED │ ◄──────── │  HALF  │
//    │(normal)│           │  OPEN  │
//    └───┬────┘           └────┬───┘
//        │ N failures          │ probe success
//        ▼                     │
//    ┌────────┐  timeout  ┌────┘
//    │  OPEN  │ ─────────►│
//    │(reject)│           │
//    └────────┘
//
//  Parameters:
//    FailureThreshold: 3 consecutive failures → OPEN
//    RecoveryTimeout:  30 seconds in OPEN → transition to HALF-OPEN
//    LatencyCeiling:   500ms — any response > 500ms counts as failure
//    ProbeInterval:    1 request allowed through in HALF-OPEN state
//
//  Usage:
//    cb := NewCircuitBreaker("VertexAI", 3, 500*time.Millisecond, 30*time.Second)
//
//    if !cb.Allow() {
//        return fallbackResponse() // Fast-fail, don't wait
//    }
//    result, err := callVertexAI()
//    cb.Record(err, elapsed)
//
// ═══════════════════════════════════════════════════════════════

package main

import (
	"log"
	"sync"
	"time"
)

// CircuitState represents the three states of the circuit breaker.
type CircuitState int

const (
	CircuitClosed   CircuitState = iota // Normal operation
	CircuitOpen                         // All requests rejected
	CircuitHalfOpen                     // Single probe allowed
)

func (s CircuitState) String() string {
	switch s {
	case CircuitClosed:
		return "CLOSED"
	case CircuitOpen:
		return "OPEN"
	case CircuitHalfOpen:
		return "HALF_OPEN"
	default:
		return "UNKNOWN"
	}
}

// CircuitBreaker implements the state machine for a single backend.
type CircuitBreaker struct {
	mu sync.Mutex

	// Name identifies this circuit in logs (e.g., "VertexAI", "GovernanceHub").
	Name string

	// Configuration
	FailureThreshold int           // Consecutive failures before opening
	LatencyCeiling   time.Duration // Responses slower than this = failure
	RecoveryTimeout  time.Duration // Time to wait in OPEN before probing

	// State
	state             CircuitState
	consecutiveErrors int
	lastFailureTime   time.Time
	totalTrips        int // Lifetime count of OPEN transitions
	totalRequests     int64
	totalFailures     int64
}

// NewCircuitBreaker creates a new circuit breaker.
//
// Parameters:
//   - name: Identifier for logging
//   - failureThreshold: Number of consecutive failures to trip open
//   - latencyCeiling: Max acceptable response time (exceeding = failure)
//   - recoveryTimeout: How long to stay OPEN before trying HALF-OPEN
func NewCircuitBreaker(name string, failureThreshold int, latencyCeiling, recoveryTimeout time.Duration) *CircuitBreaker {
	cb := &CircuitBreaker{
		Name:             name,
		FailureThreshold: failureThreshold,
		LatencyCeiling:   latencyCeiling,
		RecoveryTimeout:  recoveryTimeout,
		state:            CircuitClosed,
	}
	log.Printf("[CIRCUIT:%s] Initialized (threshold: %d failures, ceiling: %v, recovery: %v)",
		name, failureThreshold, latencyCeiling, recoveryTimeout)
	return cb
}

// Allow returns true if a request should be attempted.
//
// Returns false if the circuit is OPEN (fast-fail).
// In HALF-OPEN state, allows exactly one probe request.
func (cb *CircuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case CircuitClosed:
		return true

	case CircuitOpen:
		// Check if recovery timeout has elapsed
		if time.Since(cb.lastFailureTime) >= cb.RecoveryTimeout {
			cb.state = CircuitHalfOpen
			log.Printf("[CIRCUIT:%s] Transition: OPEN → HALF_OPEN (probing)", cb.Name)
			return true // Allow one probe
		}
		return false // Fast-fail

	case CircuitHalfOpen:
		// Only one probe at a time — reject concurrent probes
		return false
	}

	return false
}

// Record reports the outcome of a request.
//
// Call this AFTER the request completes (or fails).
//   - err: nil for success, non-nil for failure
//   - elapsed: response time (used for latency ceiling check)
func (cb *CircuitBreaker) Record(err error, elapsed time.Duration) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.totalRequests++

	// Determine if this is a "failure" (error OR latency ceiling breach)
	isFailure := err != nil || elapsed > cb.LatencyCeiling

	if isFailure {
		cb.totalFailures++
	}

	switch cb.state {
	case CircuitClosed:
		if isFailure {
			cb.consecutiveErrors++
			if err != nil {
				log.Printf("[CIRCUIT:%s] Failure %d/%d: %v",
					cb.Name, cb.consecutiveErrors, cb.FailureThreshold, err)
			} else {
				log.Printf("[CIRCUIT:%s] Latency ceiling breach %d/%d: %v > %v",
					cb.Name, cb.consecutiveErrors, cb.FailureThreshold, elapsed, cb.LatencyCeiling)
			}
			if cb.consecutiveErrors >= cb.FailureThreshold {
				cb.state = CircuitOpen
				cb.lastFailureTime = time.Now()
				cb.totalTrips++
				log.Printf("[CIRCUIT:%s] ⚡ TRIPPED OPEN (trip #%d) — all requests rejected for %v",
					cb.Name, cb.totalTrips, cb.RecoveryTimeout)
			}
		} else {
			// Success resets the counter
			if cb.consecutiveErrors > 0 {
				log.Printf("[CIRCUIT:%s] Success — resetting error counter from %d",
					cb.Name, cb.consecutiveErrors)
			}
			cb.consecutiveErrors = 0
		}

	case CircuitHalfOpen:
		if isFailure {
			// Probe failed — back to OPEN
			cb.state = CircuitOpen
			cb.lastFailureTime = time.Now()
			cb.totalTrips++
			log.Printf("[CIRCUIT:%s] ⚡ Probe FAILED — back to OPEN (trip #%d): %v",
				cb.Name, cb.totalTrips, err)
		} else {
			// Probe succeeded — close the circuit
			cb.state = CircuitClosed
			cb.consecutiveErrors = 0
			log.Printf("[CIRCUIT:%s] ✓ Probe SUCCEEDED — circuit CLOSED (recovered)", cb.Name)
		}

	case CircuitOpen:
		// Should not normally reach here (Allow() returns false for OPEN)
		// but handle it defensively
	}
}

// State returns the current circuit state (thread-safe).
func (cb *CircuitBreaker) State() CircuitState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}

// Stats returns a snapshot of circuit health metrics.
type CircuitStats struct {
	Name              string
	State             string
	ConsecutiveErrors int
	TotalTrips        int
	TotalRequests     int64
	TotalFailures     int64
	FailureRate       float64
}

func (cb *CircuitBreaker) Stats() CircuitStats {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	var failRate float64
	if cb.totalRequests > 0 {
		failRate = float64(cb.totalFailures) / float64(cb.totalRequests) * 100
	}

	return CircuitStats{
		Name:              cb.Name,
		State:             cb.state.String(),
		ConsecutiveErrors: cb.consecutiveErrors,
		TotalTrips:        cb.totalTrips,
		TotalRequests:     cb.totalRequests,
		TotalFailures:     cb.totalFailures,
		FailureRate:       failRate,
	}
}

// ReportStats logs the circuit breaker health metrics.
func (cb *CircuitBreaker) ReportStats() {
	s := cb.Stats()
	log.Printf("[CIRCUIT:%s] State: %s | Requests: %d | Failures: %d (%.1f%%) | Trips: %d",
		s.Name, s.State, s.TotalRequests, s.TotalFailures, s.FailureRate, s.TotalTrips)
}

// ─────────────────────────────────────────────────────
//  INFERENCE ORCHESTRATOR — Dual-Client with Failover
//
//  Wraps two circuit breakers (primary + fallback)
//  to provide transparent failover. If Vertex AI trips,
//  requests automatically route to the Google AI Studio
//  API-key client, and vice versa.
//
//  Callers see a single InferOrchestrator.Call() method
//  and never need to know which backend is active.
// ─────────────────────────────────────────────────────

// InferenceBackend represents a callable inference endpoint.
type InferenceBackend struct {
	Name     string
	Endpoint string
	Circuit  *CircuitBreaker
}

// InferOrchestrator manages the failover chain.
type InferOrchestrator struct {
	primary  *InferenceBackend
	fallback *InferenceBackend
}

// NewInferOrchestrator creates the dual-client failover chain.
//
// Default configuration (matching the Architect's Mandate):
//   - Primary: Vertex AI (ADC auth, regional endpoint)
//   - Fallback: Google AI Studio (API key, global endpoint)
//   - Failure Threshold: 3 consecutive errors
//   - Latency Ceiling: 500ms
//   - Recovery Timeout: 30s
func NewInferOrchestrator(primaryURL, fallbackURL string) *InferOrchestrator {
	return &InferOrchestrator{
		primary: &InferenceBackend{
			Name:     "VertexAI",
			Endpoint: primaryURL,
			Circuit: NewCircuitBreaker(
				"VertexAI",
				3,                    // 3 consecutive failures
				500*time.Millisecond, // 500ms latency ceiling
				30*time.Second,       // 30s recovery window
			),
		},
		fallback: &InferenceBackend{
			Name:     "AIStudio",
			Endpoint: fallbackURL,
			Circuit: NewCircuitBreaker(
				"AIStudio",
				3,
				500*time.Millisecond,
				30*time.Second,
			),
		},
	}
}

// SelectBackend returns the currently available backend for routing.
//
// Priority:
//   1. Primary (if circuit CLOSED or HALF-OPEN)
//   2. Fallback (if primary is OPEN)
//   3. nil (if both circuits are OPEN — total degradation)
func (io *InferOrchestrator) SelectBackend() *InferenceBackend {
	if io.primary.Circuit.Allow() {
		return io.primary
	}
	if io.fallback.Circuit.Allow() {
		log.Printf("[INFER_ORCH] Primary OPEN — routing to fallback (%s)", io.fallback.Name)
		return io.fallback
	}
	log.Printf("[INFER_ORCH] ⚠ ALL CIRCUITS OPEN — total inference degradation")
	return nil
}

// ReportAll logs stats for both backends.
func (io *InferOrchestrator) ReportAll() {
	io.primary.Circuit.ReportStats()
	io.fallback.Circuit.ReportStats()
}
