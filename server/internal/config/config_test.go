package config

import (
	"strings"
	"testing"
	"time"
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
	if config.Environment != "production" {
		t.Fatalf("Environment = %q, want production by default", config.Environment)
	}
	if _, ok := config.ClientOrigins["mite-user://app"]; !ok {
		t.Fatal("mite-user origin is missing")
	}
	if _, ok := config.ClientOrigins["http://127.0.0.1:5173"]; !ok {
		t.Fatal("user development origin is missing")
	}
	if config.PresenceOnlineAfter != time.Minute || config.PresenceOfflineAfter != 90*time.Second || config.PresenceReconnectAfter != 10*time.Minute {
		t.Fatalf("unexpected presence defaults: online=%s offline=%s reconnect=%s", config.PresenceOnlineAfter, config.PresenceOfflineAfter, config.PresenceReconnectAfter)
	}
	if config.WebPushVAPIDPublicKey != "" || config.WebPushVAPIDPrivateKey != "" || config.WebPushSubject != "" {
		t.Fatal("Web Push must be disabled when its settings are omitted")
	}
}

func TestLoadPresenceAndWebPushConfiguration(t *testing.T) {
	t.Parallel()
	environment := validEnvironment()
	environment["PRESENCE_ONLINE_AFTER_SECONDS"] = "30"
	environment["PRESENCE_OFFLINE_AFTER_SECONDS"] = "60"
	environment["PRESENCE_RECONNECT_AFTER_SECONDS"] = "300"
	environment["WEB_PUSH_VAPID_PUBLIC_KEY"] = "public-key"
	environment["WEB_PUSH_VAPID_PRIVATE_KEY"] = "private-key"
	environment["WEB_PUSH_SUBJECT"] = "mailto:support@example.com"
	config, err := load(func(name string) (string, bool) {
		value, ok := environment[name]
		return value, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.PresenceOnlineAfter != 30*time.Second || config.PresenceOfflineAfter != time.Minute || config.PresenceReconnectAfter != 5*time.Minute {
		t.Fatalf("unexpected presence settings: online=%s offline=%s reconnect=%s", config.PresenceOnlineAfter, config.PresenceOfflineAfter, config.PresenceReconnectAfter)
	}
	if config.WebPushVAPIDPublicKey != "public-key" || config.WebPushVAPIDPrivateKey != "private-key" || config.WebPushSubject != "mailto:support@example.com" {
		t.Fatal("Web Push settings were not loaded")
	}
}

func TestLoadRejectsInvalidCompanionConfiguration(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		values map[string]string
		want   string
	}{
		{name: "non-positive duration", values: map[string]string{"PRESENCE_ONLINE_AFTER_SECONDS": "0"}, want: "positive integer"},
		{name: "unordered durations", values: map[string]string{"PRESENCE_ONLINE_AFTER_SECONDS": "90"}, want: "online < offline < reconnect"},
		{name: "partial Web Push", values: map[string]string{"WEB_PUSH_VAPID_PUBLIC_KEY": "public-key"}, want: "all WEB_PUSH settings"},
		{name: "invalid Web Push subject", values: map[string]string{"WEB_PUSH_VAPID_PUBLIC_KEY": "public-key", "WEB_PUSH_VAPID_PRIVATE_KEY": "private-key", "WEB_PUSH_SUBJECT": "support@example.com"}, want: "mailto or HTTPS"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			for name, value := range test.values {
				environment[name] = value
			}
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

func TestLoadMockConfiguration(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name        string
		environment string
		wantError   string
	}{
		{name: "development", environment: "development"},
		{name: "unset", wantError: "requires MITE_ENV=development"},
		{name: "production", environment: "production", wantError: "requires MITE_ENV=development"},
		{name: "unknown environment", environment: "developmnt", wantError: "MITE_ENV must be"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment["AI_PROVIDER"] = "mock"
			if test.environment != "" {
				environment["MITE_ENV"] = test.environment
			}
			for _, name := range []string{"AI_BASE_URL", "GEMINI_API_KEY", "AI_MODEL", "AI_PROMPT_VERSION"} {
				delete(environment, name)
			}
			cfg, err := load(func(name string) (string, bool) {
				value, ok := environment[name]
				return value, ok
			})
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("load() error = %v, want %q", err, test.wantError)
				}
				return
			}
			if err != nil || cfg.Environment != "development" || cfg.AIProvider != "mock" || cfg.GeminiAPIKey != "" {
				t.Fatalf("mock configuration was not loaded without Gemini settings: %v", err)
			}
		})
	}
}

func TestLoadIgnoresGeminiSettingsInMockMode(t *testing.T) {
	t.Parallel()
	environment := validEnvironment()
	environment["MITE_ENV"] = "development"
	environment["AI_PROVIDER"] = "mock"
	environment["AI_BASE_URL"] = "not-a-url"
	environment["GEMINI_API_KEY"] = ""
	environment["AI_MODEL"] = ""
	environment["AI_PROMPT_VERSION"] = ""
	cfg, err := load(func(name string) (string, bool) {
		value, ok := environment[name]
		return value, ok
	})
	if err != nil || cfg.AIBaseURL != "" || cfg.AIModel != "" || cfg.AIPromptVersion != "" {
		t.Fatalf("mock mode used Gemini settings: %v", err)
	}
}

func TestLoadRequiresGeminiSettingsInDevelopment(t *testing.T) {
	t.Parallel()
	for _, field := range []string{"AI_BASE_URL", "GEMINI_API_KEY", "AI_MODEL", "AI_PROMPT_VERSION"} {
		t.Run(field, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment["MITE_ENV"] = "development"
			delete(environment, field)
			_, err := load(func(name string) (string, bool) {
				value, ok := environment[name]
				return value, ok
			})
			if err == nil || !strings.Contains(err.Error(), "required environment variable is missing: "+field) {
				t.Fatalf("missing Gemini setting was accepted: %v", err)
			}
		})
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
		{name: "insecure remote Supabase", field: "SUPABASE_URL", value: "http://supabase.example", want: "must use HTTPS"},
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

func TestLoadAllowsLoopbackSupabase(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"} {
		value := value
		t.Run(value, func(t *testing.T) {
			t.Parallel()
			environment := validEnvironment()
			environment["SUPABASE_URL"] = value
			if _, err := load(func(name string) (string, bool) {
				result, ok := environment[name]
				return result, ok
			}); err != nil {
				t.Fatalf("load() error = %v", err)
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
		"AI_PROMPT_VERSION":       "v2",
		"CLIENT_ORIGINS":          "http://localhost:5173,http://127.0.0.1:5173,mite-user://app",
	}
}
