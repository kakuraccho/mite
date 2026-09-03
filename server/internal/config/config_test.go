package config

import (
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	t.Parallel()
	environment := validEnvironment()
	config, err := load(func(name string) (string, bool) {
		value, ok := environment[name]
		return value, ok
	})
	if err != nil {
		t.Fatalf("load() error = %v", err)
	}
	if config.Port != 3000 {
		t.Fatalf("Port = %d, want 3000", config.Port)
	}
	if _, ok := config.ClientOrigins["mite-user://app"]; !ok {
		t.Fatal("mite-user origin is missing")
	}
}

func TestLoadRejectsUnsafeConfiguration(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		field string
		value string
		want  string
	}{
		{name: "same tokens", field: "DEMO_FAMILY_TOKEN", value: "user-token", want: "must differ"},
		{name: "wildcard origin", field: "CLIENT_ORIGINS", value: "*", want: "invalid origin"},
		{name: "origin path", field: "CLIENT_ORIGINS", value: "https://client.example/path", want: "without paths"},
		{name: "wrong livekit scheme", field: "LIVEKIT_URL", value: "https://livekit.example", want: "unsupported scheme"},
		{name: "wrong provider", field: "AI_PROVIDER", value: "other", want: "must be gemini"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment[test.field] = test.value
			_, err := load(func(name string) (string, bool) {
				value, ok := environment[name]
				return value, ok
			})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("load() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func validEnvironment() map[string]string {
	return map[string]string{
		"DATABASE_URL":            "postgresql://postgres:password@db.example/postgres",
		"SUPABASE_URL":            "https://example.supabase.co",
		"SUPABASE_SECRET_KEY":     "supabase-secret",
		"SUPABASE_STORAGE_BUCKET": "mite-artifacts",
		"DEMO_USER_TOKEN":         "user-token",
		"DEMO_FAMILY_TOKEN":       "family-token",
		"LIVEKIT_URL":             "wss://example.livekit.cloud",
		"LIVEKIT_API_KEY":         "livekit-key",
		"LIVEKIT_API_SECRET":      "livekit-secret",
		"AI_PROVIDER":             "gemini",
		"AI_BASE_URL":             "https://generativelanguage.googleapis.com/v1beta",
		"GEMINI_API_KEY":          "gemini-key",
		"AI_MODEL":                "gemini-3.8-flash",
		"AI_PROMPT_VERSION":       "v1",
		"CLIENT_ORIGINS":          "http://localhost:5173,mite-user://app",
	}
}
