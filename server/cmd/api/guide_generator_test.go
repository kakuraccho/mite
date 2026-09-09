package main

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/kakuraccho/mite/server/internal/config"
	"github.com/kakuraccho/mite/server/internal/service"
)

func TestNewGuideGenerator(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name        string
		provider    string
		environment string
		wantError   bool
	}{
		{name: "development mock", provider: "mock", environment: "development"},
		{name: "default rejects mock", provider: "mock", wantError: true},
		{name: "production rejects mock", provider: "mock", environment: "production", wantError: true},
		{name: "Gemini does not fall back without credentials", provider: "gemini", environment: "development", wantError: true},
		{name: "unknown provider", provider: "other", environment: "development", wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			generator, err := newGuideGenerator(config.Config{AIProvider: test.provider, Environment: test.environment})
			if test.wantError {
				if err == nil {
					t.Fatal("expected configuration error")
				}
				return
			}
			if _, ok := generator.(*service.MockGuideGenerator); err != nil || !ok {
				t.Fatalf("development mock was not selected: %T, %v", generator, err)
			}
		})
	}
	// Normal configuration must still select Gemini, without making a request.
	generator, err := newGuideGenerator(config.Config{AIProvider: "gemini", AIBaseURL: "https://gemini.invalid", GeminiAPIKey: "test-key", AIModel: "gemini-3.8-flash", AIPromptVersion: "v2"})
	if _, ok := generator.(*service.GeminiGuideGenerator); err != nil || !ok {
		t.Fatalf("Gemini was not selected: %T, %v", generator, err)
	}
}

func TestServerRuntimeWithMockGenerator(t *testing.T) {
	t.Parallel()
	cfg := config.Config{
		Environment:           "development",
		AIProvider:            "mock",
		SupabaseURL:           "http://127.0.0.1:54321",
		SupabaseStorageBucket: "mite-artifacts",
		SupabaseSecretKey:     "test-secret",
		DemoUserToken:         "test-user-token",
		DemoFamilyToken:       "test-family-token",
		LiveKitURL:            "wss://livekit.invalid",
		LiveKitAPIKey:         "test-livekit-key",
		LiveKitAPISecret:      "test-livekit-secret",
		ClientOrigins:         map[string]struct{}{"http://localhost:5173": {}},
	}
	var logs bytes.Buffer
	runtime, err := newServerRuntime(cfg, slog.New(slog.NewTextHandler(&logs, nil)), nil, nil)
	if err != nil || runtime.handler == nil || len(runtime.workers) != 2 {
		t.Fatalf("configure runtime without Gemini credentials: %v", err)
	}
	if !strings.Contains(logs.String(), "using mock guide generator for development") {
		t.Fatal("mock mode was not identified in the startup log")
	}
}
