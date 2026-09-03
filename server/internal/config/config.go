package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

const defaultPort = 3000

type Config struct {
	Port                  int
	DatabaseURL           string
	SupabaseURL           string
	SupabaseSecretKey     string
	SupabaseStorageBucket string
	DemoUserToken         string
	DemoFamilyToken       string
	LiveKitURL            string
	LiveKitAPIKey         string
	LiveKitAPISecret      string
	AIProvider            string
	AIBaseURL             string
	GeminiAPIKey          string
	AIModel               string
	AIPromptVersion       string
	ClientOrigins         map[string]struct{}
}

type lookupEnv func(string) (string, bool)

func Load() (Config, error) {
	return load(os.LookupEnv)
}

func load(lookup lookupEnv) (Config, error) {
	port, err := optionalPort(lookup)
	if err != nil {
		return Config{}, err
	}

	values := make(map[string]string)
	for _, name := range []string{
		"DATABASE_URL",
		"SUPABASE_URL",
		"SUPABASE_SECRET_KEY",
		"SUPABASE_STORAGE_BUCKET",
		"DEMO_USER_TOKEN",
		"DEMO_FAMILY_TOKEN",
		"LIVEKIT_URL",
		"LIVEKIT_API_KEY",
		"LIVEKIT_API_SECRET",
		"AI_PROVIDER",
		"AI_BASE_URL",
		"GEMINI_API_KEY",
		"AI_MODEL",
		"AI_PROMPT_VERSION",
		"CLIENT_ORIGINS",
	} {
		value, ok := lookup(name)
		if !ok || strings.TrimSpace(value) == "" {
			return Config{}, fmt.Errorf("required environment variable is missing: %s", name)
		}
		values[name] = value
	}

	if values["DEMO_USER_TOKEN"] == values["DEMO_FAMILY_TOKEN"] {
		return Config{}, errors.New("DEMO_USER_TOKEN and DEMO_FAMILY_TOKEN must differ")
	}
	if values["AI_PROVIDER"] != "gemini" {
		return Config{}, errors.New("AI_PROVIDER must be gemini")
	}
	if err := validateURL("DATABASE_URL", values["DATABASE_URL"], "postgres", "postgresql"); err != nil {
		return Config{}, err
	}
	if err := validateSupabaseURL(values["SUPABASE_URL"]); err != nil {
		return Config{}, err
	}
	if err := validateURL("LIVEKIT_URL", values["LIVEKIT_URL"], "wss"); err != nil {
		return Config{}, err
	}
	if err := validateURL("AI_BASE_URL", values["AI_BASE_URL"], "https"); err != nil {
		return Config{}, err
	}

	origins, err := parseOrigins(values["CLIENT_ORIGINS"])
	if err != nil {
		return Config{}, err
	}

	return Config{
		Port:                  port,
		DatabaseURL:           values["DATABASE_URL"],
		SupabaseURL:           values["SUPABASE_URL"],
		SupabaseSecretKey:     values["SUPABASE_SECRET_KEY"],
		SupabaseStorageBucket: values["SUPABASE_STORAGE_BUCKET"],
		DemoUserToken:         values["DEMO_USER_TOKEN"],
		DemoFamilyToken:       values["DEMO_FAMILY_TOKEN"],
		LiveKitURL:            values["LIVEKIT_URL"],
		LiveKitAPIKey:         values["LIVEKIT_API_KEY"],
		LiveKitAPISecret:      values["LIVEKIT_API_SECRET"],
		AIProvider:            values["AI_PROVIDER"],
		AIBaseURL:             values["AI_BASE_URL"],
		GeminiAPIKey:          values["GEMINI_API_KEY"],
		AIModel:               values["AI_MODEL"],
		AIPromptVersion:       values["AI_PROMPT_VERSION"],
		ClientOrigins:         origins,
	}, nil
}

func optionalPort(lookup lookupEnv) (int, error) {
	value, ok := lookup("PORT")
	if !ok || strings.TrimSpace(value) == "" {
		return defaultPort, nil
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, errors.New("PORT must be an integer from 1 to 65535")
	}
	return port, nil
}

func validateURL(name, raw string, schemes ...string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("%s must be a valid URL", name)
	}
	for _, scheme := range schemes {
		if parsed.Scheme == scheme {
			return nil
		}
	}
	return fmt.Errorf("%s has an unsupported scheme", name)
}

func validateSupabaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return errors.New("SUPABASE_URL must be a valid URL")
	}
	if parsed.Scheme == "https" {
		return nil
	}
	host := parsed.Hostname()
	if parsed.Scheme == "http" && (host == "localhost" || net.ParseIP(host).IsLoopback()) {
		return nil
	}
	return errors.New("SUPABASE_URL must use HTTPS except for loopback local development")
}

func parseOrigins(raw string) (map[string]struct{}, error) {
	origins := make(map[string]struct{})
	for _, candidate := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(candidate)
		if origin == "" || origin == "*" {
			return nil, errors.New("CLIENT_ORIGINS contains an invalid origin")
		}
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.String() != origin {
			return nil, errors.New("CLIENT_ORIGINS contains an invalid origin")
		}
		if parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, errors.New("CLIENT_ORIGINS must contain origins without paths")
		}
		origins[origin] = struct{}{}
	}
	if len(origins) == 0 {
		return nil, errors.New("CLIENT_ORIGINS must not be empty")
	}
	return origins, nil
}
