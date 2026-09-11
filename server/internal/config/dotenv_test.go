package config

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestParseDotEnv(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		text string
		want map[string]string
	}{
		{"empty", "\n # comment\n\t\n", map[string]string{}},
		{"assignments", " A = first \n_B2=second\nEMPTY=\nA=last", map[string]string{"A": "last", "_B2": "second", "EMPTY": ""}},
		{"quotes and CRLF", "A=' spaced value '\r\nB=\"日本語 # =\"\r\nC=''\r\nD=\"\"\r\n", map[string]string{"A": " spaced value ", "B": "日本語 # =", "C": "", "D": ""}},
		{"literal values", "A=${HOME}\nB=$(echo secret)\nC=`echo secret`\nD=C:\\new\\test\nE=token=a#b\nF=value # literal\nG=don't", map[string]string{"A": "${HOME}", "B": "$(echo secret)", "C": "`echo secret`", "D": `C:\new\test`, "E": "token=a#b", "F": "value # literal", "G": "don't"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseDotEnv(test.text)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("parseDotEnv() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestParseDotEnvRejectsInvalidLinesWithoutSecrets(t *testing.T) {
	t.Parallel()
	for _, line := range []string{
		"secret-without-equals", "=secret", "1KEY=secret", "BAD-KEY=secret",
		"export KEY=secret", "KEY='secret", "KEY=\"secret'", "KEY='secret' trailing",
		"KEY='sec'ret'", "KEY='", "KEY=secret\x00", "KEY=secret\xff",
		"KEY=\"secret\ncontinued\"",
	} {
		got, err := parseDotEnv("# comment\n" + line)
		if err == nil || err.Error() != "invalid .env format at line 2" || got != nil {
			t.Fatalf("invalid input returned values or unexpected error: %v", err)
		}
	}
}

func TestLoadDotEnvFromWorkingDirectory(t *testing.T) {
	tests := []struct {
		name        string
		file        string
		missingFile bool
		directory   bool
		environment map[string]string
		wantError   string
		wantPort    int
	}{
		{name: "file with BOM and CRLF", file: "\uFEFF" + validDotEnv() + "PORT='4321'\r\n", wantPort: 4321},
		{name: "environment wins", file: validDotEnv() + "PORT=4321", environment: map[string]string{"PORT": "5432", "DEMO_USER_TOKEN": "process-user"}, wantPort: 5432},
		{name: "deployment prompt version overrides legacy dotenv", file: strings.ReplaceAll(validDotEnv(), "AI_PROMPT_VERSION=v2", "AI_PROMPT_VERSION=v1"), environment: map[string]string{"AI_PROMPT_VERSION": "v2"}, wantPort: 3000},
		{name: "empty environment wins", file: validDotEnv(), environment: map[string]string{"DEMO_USER_TOKEN": ""}, wantError: "required environment variable is missing: DEMO_USER_TOKEN"},
		{name: "no file", missingFile: true, environment: validEnvironment(), wantPort: 3000},
		{name: "no file and missing configuration", missingFile: true, wantError: "required environment variable is missing: DATABASE_URL"},
		{name: "incomplete file", file: "PORT=3000", wantError: "required environment variable is missing: DATABASE_URL"},
		{name: "invalid configuration", file: validDotEnv() + "PORT=secret", wantError: "PORT must be an integer from 1 to 65535"},
		{name: "invalid file despite complete environment", file: "secret", environment: validEnvironment(), wantError: "invalid .env format at line 1"},
		{name: "unreadable file", directory: true, environment: validEnvironment(), wantError: "cannot read .env"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Chdir(t.TempDir())
			keys := validEnvironment()
			keys["PORT"] = ""
			keys["MITE_ENV"] = ""
			for key := range keys {
				t.Setenv(key, "") // Restore even originally absent variables after the test.
				if err := os.Unsetenv(key); err != nil {
					t.Fatal(err)
				}
			}
			for key, value := range test.environment {
				t.Setenv(key, value)
			}
			if test.directory {
				if err := os.Mkdir(".env", 0700); err != nil {
					t.Fatal(err)
				}
			} else if !test.missingFile {
				if err := os.WriteFile(".env", []byte(test.file), 0600); err != nil {
					t.Fatal(err)
				}
			}
			cfg, err := Load()
			if test.wantError != "" {
				if err == nil || err.Error() != test.wantError {
					t.Fatalf("Load() error = %v, want %q", err, test.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Port != test.wantPort {
				t.Fatalf("Port = %d, want %d", cfg.Port, test.wantPort)
			}
			if cfg.AIPromptVersion != "v2" {
				t.Fatalf("AIPromptVersion = %q, want v2", cfg.AIPromptVersion)
			}
			wantToken := "user-token"
			if value, ok := test.environment["DEMO_USER_TOKEN"]; ok {
				wantToken = value
			}
			if cfg.DemoUserToken != wantToken {
				t.Fatal("unexpected demo user token")
			}
			for key := range keys {
				value, exists := os.LookupEnv(key)
				want, wantExists := test.environment[key]
				if exists != wantExists || value != want {
					t.Fatalf("Load changed the process environment for %s", key)
				}
			}
		})
	}
}

func validDotEnv() string {
	var content strings.Builder
	for key, value := range validEnvironment() {
		content.WriteString(key + "=" + value + "\r\n")
	}
	return content.String()
}
