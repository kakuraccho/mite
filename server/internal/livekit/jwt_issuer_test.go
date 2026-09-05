package livekit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func TestJWTIssuerGrants(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		role        domain.Role
		wantData    bool
		wantSources []string
	}{
		{"user", domain.RoleUser, false, []string{"microphone", "screen_share"}},
		{"family", domain.RoleFamily, true, []string{"microphone"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			issuer, err := NewJWTIssuer("wss://test.livekit.cloud", "api-key", "secret")
			if err != nil {
				t.Fatal(err)
			}
			issuer.now = func() time.Time { return now }
			token, err := issuer.Issue(context.Background(), TokenRequest{RoomName: "mite-session_1", ParticipantIdentity: string(tt.role) + ":actor", Role: tt.role, ExpiresAt: now.Add(30 * time.Minute)})
			if err != nil {
				t.Fatal(err)
			}
			parts := strings.Split(token.Value, ".")
			if len(parts) != 3 {
				t.Fatalf("JWT parts = %d", len(parts))
			}
			mac := hmac.New(sha256.New, []byte("secret"))
			_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
			signature, _ := base64.RawURLEncoding.DecodeString(parts[2])
			if !hmac.Equal(signature, mac.Sum(nil)) {
				t.Fatal("invalid signature")
			}
			payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
			var claims jwtClaims
			if err := json.Unmarshal(payload, &claims); err != nil {
				t.Fatal(err)
			}
			if claims.Issuer != "api-key" || claims.Subject != string(tt.role)+":actor" || claims.Identity != claims.Subject {
				t.Fatalf("claims = %+v", claims)
			}
			if claims.ExpiresAt-claims.IssuedAt != 1800 {
				t.Fatalf("ttl = %d", claims.ExpiresAt-claims.IssuedAt)
			}
			if claims.Video.Room != "mite-session_1" || !claims.Video.RoomJoin || !claims.Video.CanPublish || !claims.Video.CanSubscribe || claims.Video.CanPublishData != tt.wantData {
				t.Fatalf("grant = %+v", claims.Video)
			}
			if strings.Join(claims.Video.CanPublishSources, ",") != strings.Join(tt.wantSources, ",") {
				t.Fatalf("sources = %v", claims.Video.CanPublishSources)
			}
		})
	}
}
