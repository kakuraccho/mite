package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultPort                   = 3000
	defaultPresenceOnlineAfter    = 60 * time.Second
	defaultPresenceOfflineAfter   = 90 * time.Second
	defaultPresenceReconnectAfter = 10 * time.Minute
)

type Config struct {
	Port                   int
	Environment            string
	DatabaseURL            string
	SupabaseURL            string
	SupabaseSecretKey      string
	SupabaseStorageBucket  string
	DemoUserToken          string
	DemoFamilyToken        string
	LiveKitURL             string
	LiveKitAPIKey          string
	LiveKitAPISecret       string
	AIProvider             string
	AIBaseURL              string
	GeminiAPIKey           string
	AIModel                string
	AIPromptVersion        string
	ClientOrigins          map[string]struct{}
	PresenceOnlineAfter    time.Duration
	PresenceOfflineAfter   time.Duration
	PresenceReconnectAfter time.Duration
	WebPushVAPIDPublicKey  string
	WebPushVAPIDPrivateKey string
	WebPushSubject         string
}

type lookupEnv func(string) (string, bool)

func Load() (Config, error) {
	values, err := readDotEnv(".env")
	if err != nil {
		return Config{}, err
	}
	return load(func(name string) (string, bool) {
		if value, ok := os.LookupEnv(name); ok {
			return value, true
		}
		value, ok := values[name]
		return value, ok
	})
}

func load(lookup lookupEnv) (Config, error) {
	port, err := optionalPort(lookup)
	if err != nil {
		return Config{}, err
	}

	environment, _ := lookup("MITE_ENV")
	if strings.TrimSpace(environment) == "" {
		environment = "production"
	}
	if environment != "production" && environment != "development" {
		return Config{}, errors.New("MITE_ENV must be production or development")
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
	switch values["AI_PROVIDER"] {
	case "gemini":
		for _, name := range []string{"AI_BASE_URL", "GEMINI_API_KEY", "AI_MODEL", "AI_PROMPT_VERSION"} {
			value, ok := lookup(name)
			if !ok || strings.TrimSpace(value) == "" {
				return Config{}, fmt.Errorf("required environment variable is missing: %s", name)
			}
			values[name] = value
		}
		if err := validateURL("AI_BASE_URL", values["AI_BASE_URL"], "https"); err != nil {
			return Config{}, err
		}
	case "mock":
		if environment != "development" {
			return Config{}, errors.New("AI_PROVIDER=mock requires MITE_ENV=development")
		}
	default:
		return Config{}, errors.New("AI_PROVIDER must be gemini or mock")
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

	origins, err := parseOrigins(values["CLIENT_ORIGINS"])
	if err != nil {
		return Config{}, err
	}
	presenceOnlineAfter, err := optionalPositiveSeconds(lookup, "PRESENCE_ONLINE_AFTER_SECONDS", defaultPresenceOnlineAfter)
	if err != nil {
		return Config{}, err
	}
	presenceOfflineAfter, err := optionalPositiveSeconds(lookup, "PRESENCE_OFFLINE_AFTER_SECONDS", defaultPresenceOfflineAfter)
	if err != nil {
		return Config{}, err
	}
	presenceReconnectAfter, err := optionalPositiveSeconds(lookup, "PRESENCE_RECONNECT_AFTER_SECONDS", defaultPresenceReconnectAfter)
	if err != nil {
		return Config{}, err
	}
	if presenceOnlineAfter >= presenceOfflineAfter || presenceOfflineAfter >= presenceReconnectAfter {
		return Config{}, errors.New("presence durations must satisfy online < offline < reconnect")
	}
	webPushPublicKey, webPushPrivateKey, webPushSubject, err := optionalWebPush(lookup)
	if err != nil {
		return Config{}, err
	}

	return Config{
		Port:                   port,
		Environment:            environment,
		DatabaseURL:            values["DATABASE_URL"],
		SupabaseURL:            values["SUPABASE_URL"],
		SupabaseSecretKey:      values["SUPABASE_SECRET_KEY"],
		SupabaseStorageBucket:  values["SUPABASE_STORAGE_BUCKET"],
		DemoUserToken:          values["DEMO_USER_TOKEN"],
		DemoFamilyToken:        values["DEMO_FAMILY_TOKEN"],
		LiveKitURL:             values["LIVEKIT_URL"],
		LiveKitAPIKey:          values["LIVEKIT_API_KEY"],
		LiveKitAPISecret:       values["LIVEKIT_API_SECRET"],
		AIProvider:             values["AI_PROVIDER"],
		AIBaseURL:              values["AI_BASE_URL"],
		GeminiAPIKey:           values["GEMINI_API_KEY"],
		AIModel:                values["AI_MODEL"],
		AIPromptVersion:        values["AI_PROMPT_VERSION"],
		ClientOrigins:          origins,
		PresenceOnlineAfter:    presenceOnlineAfter,
		PresenceOfflineAfter:   presenceOfflineAfter,
		PresenceReconnectAfter: presenceReconnectAfter,
		WebPushVAPIDPublicKey:  webPushPublicKey,
		WebPushVAPIDPrivateKey: webPushPrivateKey,
		WebPushSubject:         webPushSubject,
	}, nil
}

func optionalPositiveSeconds(lookup lookupEnv, name string, fallback time.Duration) (time.Duration, error) {
	value, ok := lookup(name)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return time.Duration(seconds) * time.Second, nil
}

func optionalWebPush(lookup lookupEnv) (string, string, string, error) {
	publicKey, publicSet := lookup("WEB_PUSH_VAPID_PUBLIC_KEY")
	privateKey, privateSet := lookup("WEB_PUSH_VAPID_PRIVATE_KEY")
	subject, subjectSet := lookup("WEB_PUSH_SUBJECT")
	publicSet = publicSet && strings.TrimSpace(publicKey) != ""
	privateSet = privateSet && strings.TrimSpace(privateKey) != ""
	subjectSet = subjectSet && strings.TrimSpace(subject) != ""
	if !publicSet && !privateSet && !subjectSet {
		return "", "", "", nil
	}
	if !publicSet || !privateSet || !subjectSet {
		return "", "", "", errors.New("all WEB_PUSH settings must be provided together")
	}
	parsed, err := url.Parse(subject)
	if err != nil || (parsed.Scheme != "mailto" && parsed.Scheme != "https") {
		return "", "", "", errors.New("WEB_PUSH_SUBJECT must be a mailto or HTTPS URI")
	}
	return publicKey, privateKey, subject, nil
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
