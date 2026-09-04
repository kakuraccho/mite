package domain

import (
	"strings"
	"testing"
)

func TestValidateTextCountsUnicodeCodePoints(t *testing.T) {
	t.Parallel()
	if err := ValidateText("利用者", 3, 3, true); err != nil {
		t.Fatalf("ValidateText() error = %v", err)
	}
	if err := ValidateText("利用者", 1, 2, true); err == nil {
		t.Fatal("ValidateText() accepted too many code points")
	}
}

func TestValidateTextRejectsWhitespaceOnlyRequiredValue(t *testing.T) {
	t.Parallel()
	if err := ValidateText(" \t\n", 0, 10, true); err == nil {
		t.Fatal("ValidateText() accepted whitespace-only required value")
	}
}

func TestIdempotencyKey(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		value string
		ok    bool
	}{
		{name: "valid", value: "idem_request-01", ok: true},
		{name: "empty", value: "", ok: false},
		{name: "too long", value: strings.Repeat("a", 129), ok: false},
		{name: "non ascii", value: "再送キー", ok: false},
		{name: "control", value: "key\nvalue", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := NewIdempotencyKey(test.value)
			if (err == nil) != test.ok {
				t.Fatalf("NewIdempotencyKey(%q) error = %v, want ok %v", test.value, err, test.ok)
			}
		})
	}
}

func TestRequestHashIsCanonical(t *testing.T) {
	t.Parallel()
	type normalizedRequest struct {
		Revision int    `json:"revision"`
		Comment  string `json:"comment"`
	}
	first, err := HashCanonicalJSON(normalizedRequest{Revision: 1, Comment: "help"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashCanonicalJSON(normalizedRequest{Revision: 1, Comment: "help"})
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("hashes differ: %s != %s", first, second)
	}
	if _, err := NewRequestHash(string(first)); err != nil {
		t.Fatalf("generated request hash is invalid: %v", err)
	}
	if _, err := HashCanonicalJSON(map[string]any{"revision": 1}); err == nil {
		t.Fatal("HashCanonicalJSON accepted an unnormalized map")
	}
}

func TestMultipartHashUsesNormalizedParts(t *testing.T) {
	t.Parallel()
	fileHash, err := NewRequestHash(strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	fields := []MultipartHashPart{{Name: "sequence", Value: "1"}, {Name: "capturedAt", Value: "2026-09-03T10:00:00Z"}}
	first, err := HashCanonicalMultipart(fields, fileHash)
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashCanonicalMultipart(fields, fileHash)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("multipart hashes differ: %s != %s", first, second)
	}
}
