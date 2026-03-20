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

		duration := time.Since(start)
		status := c.Writer.Status()

		logLevel := slog.LevelInfo
		if status >= 500 {
			logLevel = slog.LevelError
		} else if status >= 400 {
			logLevel = slog.LevelWarn
		}

		logger.LogAttrs(context.Background(), logLevel, "request completed",
			slog.String("request_id", requestID),
			slog.String("method", c.Request.Method),
			slog.String("path", c.Request.URL.Path),
			slog.Int("status", status),
			slog.String("duration", duration.String()),
			slog.String("client_ip", c.ClientIP()),
		)
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

	logger.Info("outbound call completed",
		slog.String("target_url", url),
		slog.String("method", method),
		slog.Int("status", resp.StatusCode),
		slog.String("duration", duration.String()),
	)

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

		logger.Warn("flow2: propagating upstream status",
			slog.Int("upstream_status", status),
			slog.String("upstream_url", target),
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

		logger.Warn("flow3/timeout: upstream responded",
			slog.Int("upstream_status", status),
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

		response["express"] = gin.H{"status": expressStatus, "body": expressResult}
		c.JSON(http.StatusOK, response)
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
			flow.GET("/1", flow1Handler(javaURL))
			flow.GET("/2", flow2Handler(javaURL))
			flow.GET("/3/success", flow3SuccessHandler(expressURL))
			flow.GET("/3/timeout", flow3TimeoutHandler(expressURL))
			flow.POST("/4", flow4Handler(javaURL))
			flow.GET("/cascade", flowCascadeHandler(javaURL, expressURL))
		}

		api.GET("/items", itemsProxyHandler(javaURL))

		stressGroup := api.Group("/stress")
		{
			stressGroup.GET("/cpu", stressCPUHandler(db, logger))
			stressGroup.GET("/memory", stressMemoryHandler(logger))
			stressGroup.GET("/db", stressDBHandler(db, logger))
			stressGroup.GET("/status", stressStatusHandler())
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
