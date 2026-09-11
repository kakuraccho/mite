package service

import (
	"os"
	"strings"
	"testing"
)

// CD must send the version required by this binary, rather than retaining the
// previous release's setting on the VPS.
func TestDeploymentPromptVersionMatchesGenerator(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../deploy/mite-api.env")
	if err != nil {
		t.Fatal(err)
	}
	want := "AI_PROMPT_VERSION=" + GeminiPromptVersion + "\n"
	if string(data) != want {
		t.Fatalf("deployment environment = %q, want %q", data, want)
	}
	version := strings.TrimPrefix(strings.TrimSpace(string(data)), "AI_PROMPT_VERSION=")
	if _, err := NewGeminiGuideGenerator("https://gemini.invalid", "test-key", GeminiModel, version, nil); err != nil {
		t.Fatalf("deployment configuration prevents startup: %v", err)
	}
}

func TestGeminiRejectsPreviousDeploymentPromptVersion(t *testing.T) {
	t.Parallel()
	if _, err := NewGeminiGuideGenerator("https://gemini.invalid", "test-key", GeminiModel, "v1", nil); err == nil {
		t.Fatal("v1 must not be accepted for a v2 prompt; CD must update the setting")
	}
}
