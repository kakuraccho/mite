package domain

import (
	"math"
	"testing"
)

func TestRevision(t *testing.T) {
	t.Parallel()
	if err := CheckExpectedRevision(3, 3); err != nil {
		t.Fatalf("CheckExpectedRevision() error = %v", err)
	}
	err := CheckExpectedRevision(3, 2)
	if code, ok := ErrorCodeOf(err); !ok || code != CodeRevisionConflict {
		t.Fatalf("CheckExpectedRevision() code = %s, %v; want %s", code, ok, CodeRevisionConflict)
	}
	if next, err := NextRevision(3); err != nil || next != 4 {
		t.Fatalf("NextRevision(3) = %d, %v; want 4, nil", next, err)
	}
	if _, err := NextRevision(math.MaxInt64); err == nil {
		t.Fatal("NextRevision(MaxInt64) succeeded")
	}
}
