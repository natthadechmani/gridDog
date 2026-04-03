package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

// ---------------------------------------------------------------------------
// Global stress state
// ---------------------------------------------------------------------------

type StressState struct {
	mu     sync.Mutex
	CPU    bool
	Memory bool
	DB     bool
}

var stress = &StressState{}

// stopCPU and stopMemory are channels used to signal running stress goroutines
// to stop. A new channel is created when stress is toggled on; closing it
// signals all workers to exit.
var (
	stopCPUCh    chan struct{}
	stopMemoryCh chan struct{}
	stopDBCh     chan struct{}
	stressMu     sync.Mutex
)

// ---------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ---------------------------------------------------------------------------
// Structured logger helpers
// ---------------------------------------------------------------------------

// routeLabel maps "METHOD /gin/route/pattern" to a human-readable description
// used as the log message for every completed request instead of the generic
// "request completed" string.
var routeLabel = map[string]string{
	"GET /api/flow/1":               "flow1: java → postgres — GET item by id",
	"GET /api/flow/2":               "flow2: java → postgres — GET item/9999 (expected 404)",
	"GET /api/flow/3/success":       "flow3/success: express — fibonacci compute",
	"GET /api/flow/3/timeout":       "flow3/timeout: express — intentional 15s delay",
	"POST /api/flow/4":              "flow4: java → postgres — INSERT new item",
	"GET /api/flow/cascade":         "flow/cascade: java GET /items/1 → express GET /compute",
	"GET /api/flow/10/promo/:code":  "flow10/promo: java → postgres — promo code lookup",
	"POST /api/flow/10/checkout":    "flow10/checkout: intentional 500 — payment gateway failure",
	"GET /api/shop/items":           "shop/items: go → express → mongodb — fetch shop catalogue",
	"GET /api/items":                "flow6/items: java → postgres — list all items",
	"GET /api/error/flaky":          "flow7/flaky: java — 50% random failure",
	"GET /api/error/chaos":          "flow8/chaos: express — random status 200/429/500/503",
	"GET /api/error/slow-fail":      "flow9/slow-fail: express — 40% failure + artificial delay",
	"GET /api/stress/cpu":           "stress/cpu: toggle CPU stressor",
	"GET /api/stress/memory":        "stress/memory: toggle memory stressor",
	"GET /api/stress/db":            "stress/db: toggle DB stressor",
	"GET /api/stress/status":        "stress/status: stressor state",
	"GET /api/traffic/status":       "traffic/status: generator state",
	"POST /api/traffic/start":       "traffic/start: start traffic generator",
	"POST /api/traffic/stop":        "traffic/stop: stop traffic generator",
}

func requestLogger(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		requestID := uuid.NewString()
		c.Set("request_id", requestID)
		c.Set("logger", logger.With(
			slog.String("request_id", requestID),
			slog.String("method", c.Request.Method),
			slog.String("path", c.Request.URL.Path),
		))

		c.Next()

		if c.Request.URL.Path == "/health" {
			return
		}

		duration := time.Since(start)
		status := c.Writer.Status()

		logLevel := slog.LevelInfo
		if status >= 500 {
			logLevel = slog.LevelError
		} else if status >= 400 {
			logLevel = slog.LevelWarn
		}

		msg := routeLabel[c.Request.Method+" "+c.FullPath()]
		if msg == "" {
			msg = c.Request.Method + " " + c.Request.URL.Path
		}

		base := []slog.Attr{
			slog.String("request_id", requestID),
			slog.String("method", c.Request.Method),
			slog.String("path", c.Request.URL.Path),
			slog.Int("status", status),
			slog.String("duration", duration.String()),
			slog.String("client_ip", c.ClientIP()),
		}
		if extra, exists := c.Get("log_attrs"); exists {
			if extraAttrs, ok := extra.([]slog.Attr); ok {
				base = append(base, extraAttrs...)
			}
		}
		logger.LogAttrs(context.Background(), logLevel, msg, base...)
	}
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Origin, Content-Type, Authorization, X-Request-ID")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func getLogger(c *gin.Context) *slog.Logger {
	if l, exists := c.Get("logger"); exists {
		if logger, ok := l.(*slog.Logger); ok {
			return logger
		}
	}
	return slog.Default()
}

func getRequestID(c *gin.Context) string {
	if id, exists := c.Get("request_id"); exists {
		if s, ok := id.(string); ok {
			return s
		}
	}
	return ""
}

// setLogFields deposits extra slog attributes onto the Gin context so that
// requestLogger can append them to the final "request completed" log line.
// Call this from any handler to enrich the audit log with business context.
func setLogFields(c *gin.Context, attrs ...slog.Attr) {
	c.Set("log_attrs", attrs)
}

// ---------------------------------------------------------------------------
// Outbound HTTP client helpers
// ---------------------------------------------------------------------------

// doRequest performs an HTTP request, logs the outbound call, and returns the
// raw response body together with the HTTP status code. Callers are
// responsible for unmarshalling the body.
func doRequest(ctx context.Context, logger *slog.Logger, method, url string, body io.Reader, timeoutSecs int) ([]byte, int, error) {
	client := &http.Client{Timeout: time.Duration(timeoutSecs) * time.Second}

	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, 0, fmt.Errorf("create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	start := time.Now()
	resp, err := client.Do(req)
	duration := time.Since(start)

	if err != nil {
		logger.Error("outbound call failed",
			slog.String("target_url", url),
			slog.String("method", method),
			slog.String("duration", duration.String()),
			slog.String("error", err.Error()),
		)
		return nil, 0, err
	}
	defer resp.Body.Close()

	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, resp.StatusCode, fmt.Errorf("read response body: %w", readErr)
	}

	// For non-2xx responses, log the status and a body excerpt so the error
	// is visible even when the calling handler doesn't explicitly handle it.
	// 2xx responses are not logged here — each handler logs with business context.
	if resp.StatusCode >= 400 {
		excerpt := string(data)
		if len(excerpt) > 300 {
			excerpt = excerpt[:300] + "…"
		}
		lvl := slog.LevelWarn
		msg := "upstream returned client error"
		if resp.StatusCode >= 500 {
			lvl = slog.LevelError
			msg = "upstream returned server error"
		}
		logger.LogAttrs(ctx, lvl, msg,
			slog.String("target_url", url),
			slog.String("method", method),
			slog.Int("status", resp.StatusCode),
			slog.String("duration", duration.String()),
			slog.String("response_body", excerpt),
		)
	}

	return data, resp.StatusCode, nil
}

// ---------------------------------------------------------------------------
// Handler: /health
// ---------------------------------------------------------------------------

func healthHandler(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":     "ok",
		"request_id": getRequestID(c),
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
	})
}

// ---------------------------------------------------------------------------
// Handler: /api/flow/1  – Java GET /items/1 (happy path)
// ---------------------------------------------------------------------------

func flow1Handler(javaURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		target := javaURL + "/items/1"

		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, target, nil, 10)
		if err != nil {
			logger.Error("flow1: java call error", slog.String("error", err.Error()))
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		if status != http.StatusOK {
			logger.Warn("flow1: unexpected upstream status", slog.Int("upstream_status", status))
			c.Data(status, "application/json", data)
			return
		}

		var result map[string]interface{}
		if err := json.Unmarshal(data, &result); err != nil {
			c.Data(http.StatusOK, "application/json", data)
			return
		}
		logger.Info("flow1: item fetched from postgres",
			slog.Any("item_id", result["id"]),
			slog.Any("item_name", result["name"]),
			slog.Any("item_value", result["value"]),
			slog.Int("upstream_status", status),
		)
		setLogFields(c,
			slog.Any("item_id", result["id"]),
			slog.Any("item_name", result["name"]),
			slog.Any("item_value", result["value"]),
		)
		c.JSON(http.StatusOK, result)
	}
}

// ---------------------------------------------------------------------------
// Handler: /api/flow/2  – Java GET /items/9999 (wrong id → 404)
// ---------------------------------------------------------------------------

func flow2Handler(javaURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		target := javaURL + "/items/9999"

		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, target, nil, 10)
		if err != nil {
			logger.Error("flow2: java call error", slog.String("error", err.Error()))
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}

		var errBody map[string]interface{}
		_ = json.Unmarshal(data, &errBody)
		logger.Info("flow2: db not-found propagated as expected",
			slog.Int("item_id_queried", 9999),
			slog.Int("upstream_status", status),
			slog.String("upstream_url", target),
		)
		setLogFields(c,
			slog.Int("item_id_queried", 9999),
			slog.Int("upstream_status", status),
			slog.Any("upstream_error", errBody["error"]),
			slog.Any("upstream_message", errBody["message"]),
		)
		c.Data(status, "application/json", data)
	}
}

// ---------------------------------------------------------------------------
// Handler: /api/flow/3/success  – Express GET /compute
// ---------------------------------------------------------------------------

func flow3SuccessHandler(expressURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		target := expressURL + "/compute"

		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, target, nil, 10)
		if err != nil {
			logger.Error("flow3/success: express call error", slog.String("error", err.Error()))
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		if status != http.StatusOK {
			c.Data(status, "application/json", data)
			return
		}

		var result map[string]interface{}
		if err := json.Unmarshal(data, &result); err != nil {
			c.Data(http.StatusOK, "application/json", data)
			return
		}
		logger.Info("flow3/success: compute result received from express",
			slog.Any("compute_result", result["result"]),
			slog.Any("compute_time_ms", result["computeTime"]),
			slog.Int("upstream_status", status),
		)
		setLogFields(c,
			slog.Any("compute_result", result["result"]),
			slog.Any("compute_time_ms", result["computeTime"]),
		)
		c.JSON(http.StatusOK, result)
	}
}

// ---------------------------------------------------------------------------
// Handler: /api/flow/3/timeout  – Express GET /compute/timeout (pass-through)
// ---------------------------------------------------------------------------

func flow3TimeoutHandler(expressURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		target := expressURL + "/compute/timeout"

		// Use a generous timeout so we actually let Express time out and
		// propagate whatever error it returns (rather than cutting it off
		// ourselves). 60 s is intentionally longer than expected Express delay.
		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, target, nil, 60)
		if err != nil {
			logger.Error("flow3/timeout: express timeout error",
				slog.String("error", err.Error()),
				slog.String("upstream_url", target),
			)
			c.JSON(http.StatusGatewayTimeout, gin.H{
				"error":  "upstream timeout",
				"detail": err.Error(),
			})
			return
		}

		logger.Info("flow3/timeout: delayed response received from express",
			slog.Int("upstream_status", status),
			slog.String("note", "intentional 15s sleep in express-service"),
		)
		setLogFields(c,
			slog.Int("upstream_status", status),
			slog.String("note", "intentional 15s sleep in express-service"),
		)
		c.Data(status, "application/json", data)
	}
}

// ---------------------------------------------------------------------------
// Handler: POST /api/flow/4  – Java POST /items with random number body
// ---------------------------------------------------------------------------

func flow4Handler(javaURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		target := javaURL + "/items"

		payload := map[string]interface{}{
			"value":      rand.Intn(10000),
			"created_at": time.Now().UTC().Format(time.RFC3339),
		}
		bodyBytes, _ := json.Marshal(payload)

		data, status, err := doRequest(c.Request.Context(), logger, http.MethodPost, target, bytes.NewReader(bodyBytes), 10)
		if err != nil {
			logger.Error("flow4: java call error", slog.String("error", err.Error()))
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}

		var result map[string]interface{}
		if jsonErr := json.Unmarshal(data, &result); jsonErr != nil {
			c.Data(status, "application/json", data)
			return
		}
		logger.Info("flow4: item inserted into postgres",
			slog.Any("item_id", result["id"]),
			slog.Any("item_name", result["name"]),
			slog.Any("item_value", result["value"]),
			slog.Any("created_at", result["created_at"]),
			slog.Int("upstream_status", status),
		)
		setLogFields(c,
			slog.Any("item_id", result["id"]),
			slog.Any("item_name", result["name"]),
			slog.Any("item_value", result["value"]),
			slog.Any("created_at", result["created_at"]),
		)
		c.JSON(status, result)
	}
}

// ---------------------------------------------------------------------------
// Handler: GET /api/flow/cascade
// ---------------------------------------------------------------------------

func flowCascadeHandler(javaURL, expressURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		response := gin.H{}

		// Step 1: call Java /items/1
		javaData, javaStatus, javaErr := doRequest(c.Request.Context(), logger, http.MethodGet, javaURL+"/items/1", nil, 10)
		if javaErr != nil {
			logger.Error("cascade: java call failed, skipping express",
				slog.String("error", javaErr.Error()),
			)
			response["java"] = gin.H{"error": javaErr.Error(), "skipped": true}
			response["express"] = gin.H{"skipped": true, "reason": "java failed"}
			c.JSON(http.StatusPartialContent, response)
			return
		}

		var javaResult interface{}
		if err := json.Unmarshal(javaData, &javaResult); err != nil {
			javaResult = string(javaData)
		}

		if javaStatus != http.StatusOK {
			logger.Warn("cascade: java non-200, skipping express",
				slog.Int("java_status", javaStatus),
			)
			response["java"] = gin.H{"status": javaStatus, "body": javaResult}
			response["express"] = gin.H{"skipped": true, "reason": "java non-200"}
			c.JSON(http.StatusPartialContent, response)
			return
		}

		response["java"] = javaResult
		if javaMap, ok := javaResult.(map[string]interface{}); ok {
			logger.Info("cascade: java step completed",
				slog.Any("item_id", javaMap["id"]),
				slog.Any("item_name", javaMap["name"]),
				slog.Int("java_status", javaStatus),
			)
		}

		// Step 2: call Express /compute only if Java succeeded
		expressData, expressStatus, expressErr := doRequest(c.Request.Context(), logger, http.MethodGet, expressURL+"/compute", nil, 10)
		if expressErr != nil {
			logger.Error("cascade: express call failed",
				slog.String("error", expressErr.Error()),
			)
			response["express"] = gin.H{"error": expressErr.Error()}
			c.JSON(http.StatusPartialContent, response)
			return
		}

		var expressResult interface{}
		if err := json.Unmarshal(expressData, &expressResult); err != nil {
			expressResult = string(expressData)
		}

		if expressMap, ok := expressResult.(map[string]interface{}); ok {
			logger.Info("cascade: express compute completed",
				slog.Any("compute_result", expressMap["result"]),
				slog.Any("compute_time_ms", expressMap["computeTime"]),
				slog.Int("express_status", expressStatus),
			)
			if javaMap, ok2 := javaResult.(map[string]interface{}); ok2 {
				setLogFields(c,
					slog.Any("java_item_id", javaMap["id"]),
					slog.Any("java_item_name", javaMap["name"]),
					slog.Int("java_status", javaStatus),
					slog.Any("express_compute_result", expressMap["result"]),
					slog.Any("express_compute_time_ms", expressMap["computeTime"]),
					slog.Int("express_status", expressStatus),
				)
			}
		}
		response["express"] = gin.H{"status": expressStatus, "body": expressResult}
		c.JSON(http.StatusOK, response)
	}
}

// ---------------------------------------------------------------------------
// Handlers: /api/error/*  – simulated error scenarios
// ---------------------------------------------------------------------------

// flaky: proxies to Java /error/flaky — error originates in Java
func errorFlakyHandler(javaURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, javaURL+"/error/flaky", nil, 10)
		if err != nil {
			logger.Error("flow7/flaky: java-service unreachable",
				slog.String("target", javaURL+"/error/flaky"),
				slog.String("error", err.Error()),
			)
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		if status >= 500 {
			logger.Error("flow7/flaky: java returned simulated failure — 50% roll failed",
				slog.Int("upstream_status", status),
			)
			setLogFields(c, slog.Int("upstream_status", status), slog.String("outcome", "error"))
		} else {
			logger.Info("flow7/flaky: java returned ok — 50% roll passed",
				slog.Int("upstream_status", status),
			)
			setLogFields(c, slog.Int("upstream_status", status), slog.String("outcome", "success"))
		}
		c.Data(status, "application/json", data)
	}
}

// ---------------------------------------------------------------------------
// Handlers: /api/flow/10/*  – e-commerce checkout simulation
// ---------------------------------------------------------------------------

// flow10Promo: proxies to Java /promo/verify/:code — DB lookup originates in Java → Postgres
func flow10PromoHandler(javaURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		code := c.Param("code")
		target := javaURL + "/promo/verify/" + code

		logger.Info("[flow10/promo] Proxying promo verify to java-service",
			slog.String("promo_code", code),
			slog.String("target", target),
		)

		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, target, nil, 10)
		if err != nil {
			logger.Error("[flow10/promo] Failed to reach java-service for promo verification — upstream unreachable",
				slog.String("promo_code", code),
				slog.String("target", target),
				slog.String("error", err.Error()),
			)
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		var promoResp map[string]interface{}
		if jsonErr := json.Unmarshal(data, &promoResp); jsonErr == nil {
			if valid, _ := promoResp["valid"].(bool); valid {
				logger.Info("[flow10/promo] promo code valid — discount applied",
					slog.String("promo_code", code),
					slog.Any("discount_percent", promoResp["discount_percent"]),
					slog.Int("upstream_status", status),
				)
				setLogFields(c,
					slog.String("promo_code", code),
					slog.Bool("promo_valid", true),
					slog.Any("discount_percent", promoResp["discount_percent"]),
				)
			} else {
				logger.Warn("[flow10/promo] promo code invalid or inactive",
					slog.String("promo_code", code),
					slog.Int("upstream_status", status),
				)
				setLogFields(c,
					slog.String("promo_code", code),
					slog.Bool("promo_valid", false),
				)
			}
		}
		c.Data(status, "application/json", data)
	}
}

// flow10Checkout: intentional 500 — payment gateway failure simulation (no downstream call)
func flow10CheckoutHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		logger.Error("[flow10/checkout] Intentional 500 — payment gateway unavailable, checkout failure simulation triggered",
			slog.String("path", "/api/flow/10/checkout"),
			slog.Int("status", 500),
			slog.Bool("simulated", true),
		)
		setLogFields(c,
			slog.Bool("simulated", true),
			slog.String("failure_reason", "payment_gateway_unavailable"),
		)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":     "checkout_failed",
			"message":   "Payment gateway unavailable — simulated failure",
			"simulated": true,
		})
	}
}

// chaos: proxies to Express /error/chaos — error originates in Express
func errorChaosHandler(expressURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, expressURL+"/error/chaos", nil, 10)
		if err != nil {
			logger.Error("flow8/chaos: express-service unreachable",
				slog.String("target", expressURL+"/error/chaos"),
				slog.String("error", err.Error()),
			)
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		var body map[string]interface{}
		_ = json.Unmarshal(data, &body)
		errMsg, _ := body["error"].(string)
		if errMsg == "" {
			errMsg, _ = body["message"].(string)
		}
		switch {
		case status >= 500:
			logger.Error("flow8/chaos: express returned server error",
				slog.Int("upstream_status", status),
				slog.String("error_message", errMsg),
			)
			setLogFields(c, slog.Int("upstream_status", status), slog.String("error_message", errMsg), slog.String("outcome", "error"))
		case status >= 400:
			logger.Warn("flow8/chaos: express returned client error",
				slog.Int("upstream_status", status),
				slog.String("error_message", errMsg),
			)
			setLogFields(c, slog.Int("upstream_status", status), slog.String("error_message", errMsg), slog.String("outcome", "rate_limited"))
		default:
			logger.Info("flow8/chaos: express returned ok",
				slog.Int("upstream_status", status),
			)
			setLogFields(c, slog.Int("upstream_status", status), slog.String("outcome", "success"))
		}
		c.Data(status, "application/json", data)
	}
}

// slow-fail: proxies to Express /error/slow-fail — delay + error originate in Express
func errorSlowFailHandler(expressURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, expressURL+"/error/slow-fail", nil, 10)
		if err != nil {
			logger.Error("flow9/slow-fail: express-service unreachable",
				slog.String("target", expressURL+"/error/slow-fail"),
				slog.String("error", err.Error()),
			)
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		var sfBody map[string]interface{}
		_ = json.Unmarshal(data, &sfBody)
		delayMs := sfBody["delay_ms"]
		if status >= 500 {
			logger.Error("flow9/slow-fail: express returned simulated failure — 40% failure rate triggered",
				slog.Int("upstream_status", status),
				slog.Any("delay_ms", delayMs),
			)
			setLogFields(c, slog.Int("upstream_status", status), slog.Any("delay_ms", delayMs), slog.String("outcome", "error"))
		} else {
			logger.Info("flow9/slow-fail: express returned ok — 60% success rate passed",
				slog.Int("upstream_status", status),
				slog.Any("delay_ms", delayMs),
			)
			setLogFields(c, slog.Int("upstream_status", status), slog.Any("delay_ms", delayMs), slog.String("outcome", "success"))
		}
		c.Data(status, "application/json", data)
	}
}

// ---------------------------------------------------------------------------
// Handler: GET /api/shop/items  – go → express → mongodb
// ---------------------------------------------------------------------------

func shopItemsHandler(expressURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		target := expressURL + "/shop/items"

		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, target, nil, 10)
		if err != nil {
			logger.Error("shop/items: express-service unreachable",
				slog.String("target", target),
				slog.String("error", err.Error()),
			)
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		if status != http.StatusOK {
			c.Data(status, "application/json", data)
			return
		}

		var items []interface{}
		if jsonErr := json.Unmarshal(data, &items); jsonErr == nil {
			logger.Info(fmt.Sprintf("shop/items: fetched %d item(s) from mongodb via express", len(items)),
				slog.Int("item_count", len(items)),
				slog.Int("upstream_status", status),
			)
			setLogFields(c, slog.Int("item_count", len(items)))
		}
		c.Data(status, "application/json", data)
	}
}

// ---------------------------------------------------------------------------
// Handler: GET /api/items  – proxy to Java GET /items
// ---------------------------------------------------------------------------

func itemsProxyHandler(javaURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		logger := getLogger(c)
		target := javaURL + "/items"

		data, status, err := doRequest(c.Request.Context(), logger, http.MethodGet, target, nil, 10)
		if err != nil {
			logger.Error("items proxy: java call error", slog.String("error", err.Error()))
			c.JSON(http.StatusBadGateway, gin.H{"error": "upstream error", "detail": err.Error()})
			return
		}
		var items []interface{}
		if jsonErr := json.Unmarshal(data, &items); jsonErr == nil {
			logger.Info("flow6/items: list fetched from postgres",
				slog.Int("item_count", len(items)),
				slog.Int("upstream_status", status),
			)
			setLogFields(c, slog.Int("item_count", len(items)))
		}
		c.Data(status, "application/json", data)
	}
}

// ---------------------------------------------------------------------------
// Stress: CPU
// ---------------------------------------------------------------------------

func startCPUStress() {
	ch := make(chan struct{})
	stressMu.Lock()
	stopCPUCh = ch
	stressMu.Unlock()

	numCPU := runtime.NumCPU()
	for i := 0; i < numCPU; i++ {
		go func() {
			for {
				select {
				case <-ch:
					return
				default:
					// Busy math work to saturate CPU
					x := 0.0
					for j := 0; j < 1_000_000; j++ {
						x += math.Sqrt(float64(j))
					}
					_ = x
				}
			}
		}()
	}
}

func stopCPUStress() {
	stressMu.Lock()
	defer stressMu.Unlock()
	if stopCPUCh != nil {
		close(stopCPUCh)
		stopCPUCh = nil
	}
}

// ---------------------------------------------------------------------------
// Stress: Memory
// ---------------------------------------------------------------------------

func startMemoryStress() {
	ch := make(chan struct{})
	stressMu.Lock()
	stopMemoryCh = ch
	stressMu.Unlock()

	go func() {
		// Hold ~100 MB allocations; release only when stopped.
		const sliceSize = 100 * 1024 * 1024 // 100 MB per slice
		var held [][]byte
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()

		for {
			select {
			case <-ch:
				held = nil
				runtime.GC()
				return
			case <-ticker.C:
				// Keep a rolling window of two 100 MB allocations
				buf := make([]byte, sliceSize)
				for i := range buf {
					buf[i] = byte(i % 256)
				}
				held = append(held, buf)
				if len(held) > 2 {
					held = held[1:]
				}
			}
		}
	}()
}

func stopMemoryStress() {
	stressMu.Lock()
	defer stressMu.Unlock()
	if stopMemoryCh != nil {
		close(stopMemoryCh)
		stopMemoryCh = nil
	}
}

// ---------------------------------------------------------------------------
// Stress: DB
// ---------------------------------------------------------------------------

func startDBStress(db *sql.DB, logger *slog.Logger) {
	ch := make(chan struct{})
	stressMu.Lock()
	stopDBCh = ch
	stressMu.Unlock()

	const workers = 5
	for i := 0; i < workers; i++ {
		go func(workerID int) {
			for {
				select {
				case <-ch:
					return
				default:
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					_, err := db.QueryContext(ctx, "SELECT 1")
					cancel()
					if err != nil {
						logger.Warn("db stress query error",
							slog.Int("worker", workerID),
							slog.String("error", err.Error()),
						)
					}
					time.Sleep(50 * time.Millisecond)
				}
			}
		}(i)
	}
}

func stopDBStress() {
	stressMu.Lock()
	defer stressMu.Unlock()
	if stopDBCh != nil {
		close(stopDBCh)
		stopDBCh = nil
	}
}

// ---------------------------------------------------------------------------
// Stress handlers
// ---------------------------------------------------------------------------

func stressCPUHandler(db *sql.DB, logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		stress.mu.Lock()
		stress.CPU = !stress.CPU
		current := stress.CPU
		stress.mu.Unlock()

		if current {
			startCPUStress()
			logger.Info("stress: CPU stress ENABLED")
		} else {
			stopCPUStress()
			logger.Info("stress: CPU stress DISABLED")
		}

		c.JSON(http.StatusOK, gin.H{
			"stressor": "cpu",
			"active":   current,
		})
	}
}

func stressMemoryHandler(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		stress.mu.Lock()
		stress.Memory = !stress.Memory
		current := stress.Memory
		stress.mu.Unlock()

		if current {
			startMemoryStress()
			logger.Info("stress: memory stress ENABLED")
		} else {
			stopMemoryStress()
			logger.Info("stress: memory stress DISABLED")
		}

		c.JSON(http.StatusOK, gin.H{
			"stressor": "memory",
			"active":   current,
		})
	}
}

func stressDBHandler(db *sql.DB, logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		stress.mu.Lock()
		stress.DB = !stress.DB
		current := stress.DB
		stress.mu.Unlock()

		if current {
			if db != nil {
				startDBStress(db, logger)
				logger.Info("stress: DB stress ENABLED")
			} else {
				// Revert toggle if no DB is configured
				stress.mu.Lock()
				stress.DB = false
				stress.mu.Unlock()
				c.JSON(http.StatusServiceUnavailable, gin.H{
					"error": "no database connection configured",
				})
				return
			}
		} else {
			stopDBStress()
			logger.Info("stress: DB stress DISABLED")
		}

		c.JSON(http.StatusOK, gin.H{
			"stressor": "db",
			"active":   current,
		})
	}
}

// ---------------------------------------------------------------------------
// Traffic control handlers — proxy to the Puppeteer traffic service
// ---------------------------------------------------------------------------

func trafficProxyHandler(trafficURL, path, method string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if trafficURL == "" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "traffic service not configured"})
			return
		}

		client := &http.Client{Timeout: 5 * time.Second}
		req, err := http.NewRequest(method, trafficURL+path, nil)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		resp, err := client.Do(req)
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "traffic service unavailable"})
			return
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		c.Data(resp.StatusCode, "application/json", body)
	}
}

func stressStatusHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		stress.mu.Lock()
		defer stress.mu.Unlock()
		c.JSON(http.StatusOK, gin.H{
			"cpu":    stress.CPU,
			"memory": stress.Memory,
			"db":     stress.DB,
		})
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	// Structured JSON logger to stdout
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))
	slog.SetDefault(logger)

	port := getEnv("PORT", "8080")
	javaURL := getEnv("JAVA_SERVICE_URL", "http://localhost:8081")
	expressURL := getEnv("EXPRESS_SERVICE_URL", "http://localhost:3001")
	trafficURL := getEnv("TRAFFIC_SERVICE_URL", "")
	databaseURL := getEnv("DATABASE_URL", "")

	logger.Info("starting backend service",
		slog.String("port", port),
		slog.String("java_service_url", javaURL),
		slog.String("express_service_url", expressURL),
	)

	// Database connection (optional – service starts without it)
	var db *sql.DB
	if databaseURL != "" {
		var err error
		db, err = sql.Open("postgres", databaseURL)
		if err != nil {
			logger.Error("failed to open database connection", slog.String("error", err.Error()))
		} else {
			db.SetMaxOpenConns(25)
			db.SetMaxIdleConns(5)
			db.SetConnMaxLifetime(5 * time.Minute)

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if pingErr := db.PingContext(ctx); pingErr != nil {
				logger.Warn("database ping failed – continuing without DB",
					slog.String("error", pingErr.Error()),
				)
				db = nil
			} else {
				logger.Info("database connection established")
			}
		}
	} else {
		logger.Warn("DATABASE_URL not set – DB features disabled")
	}

	// Gin setup
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())
	router.Use(corsMiddleware())
	router.Use(requestLogger(logger))

	// Routes
	router.GET("/health", healthHandler)

	api := router.Group("/api")
	{
		flow := api.Group("/flow")
		{
			api.GET("/shop/items", shopItemsHandler(expressURL))

		flow.GET("/1", flow1Handler(javaURL))
			flow.GET("/2", flow2Handler(javaURL))
			flow.GET("/3/success", flow3SuccessHandler(expressURL))
			flow.GET("/3/timeout", flow3TimeoutHandler(expressURL))
			flow.POST("/4", flow4Handler(javaURL))
			flow.GET("/cascade", flowCascadeHandler(javaURL, expressURL))
			flow.GET("/10/promo/:code", flow10PromoHandler(javaURL))
			flow.POST("/10/checkout", flow10CheckoutHandler())
		}

		api.GET("/items", itemsProxyHandler(javaURL))

		errorGroup := api.Group("/error")
		{
			errorGroup.GET("/flaky", errorFlakyHandler(javaURL))
			errorGroup.GET("/chaos", errorChaosHandler(expressURL))
			errorGroup.GET("/slow-fail", errorSlowFailHandler(expressURL))
		}

		stressGroup := api.Group("/stress")
		{
			stressGroup.GET("/cpu", stressCPUHandler(db, logger))
			stressGroup.GET("/memory", stressMemoryHandler(logger))
			stressGroup.GET("/db", stressDBHandler(db, logger))
			stressGroup.GET("/status", stressStatusHandler())
		}

		trafficGroup := api.Group("/traffic")
		{
			trafficGroup.GET("/status", trafficProxyHandler(trafficURL, "/status", "GET"))
			trafficGroup.POST("/start", trafficProxyHandler(trafficURL, "/start", "POST"))
			trafficGroup.POST("/stop", trafficProxyHandler(trafficURL, "/stop", "POST"))
		}
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 90 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server in background
	go func() {
		logger.Info("listening", slog.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", slog.String("error", err.Error()))
			os.Exit(1)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down server...")

	// Stop all stress goroutines
	stress.mu.Lock()
	if stress.CPU {
		stopCPUStress()
	}
	if stress.Memory {
		stopMemoryStress()
	}
	if stress.DB {
		stopDBStress()
	}
	stress.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("forced shutdown", slog.String("error", err.Error()))
	}

	if db != nil {
		db.Close()
	}

	logger.Info("server stopped")
}
