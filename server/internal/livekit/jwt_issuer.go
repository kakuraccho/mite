package livekit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type JWTIssuer struct {
	serverURL string
	apiKey    string
	secret    string
	now       func() time.Time
}

func NewJWTIssuer(serverURL, apiKey, secret string) (*JWTIssuer, error) {
	if strings.TrimSpace(serverURL) == "" || strings.TrimSpace(apiKey) == "" || strings.TrimSpace(secret) == "" {
		return nil, errors.New("LiveKit URL、API key、secretは必須")
	}
	return &JWTIssuer{serverURL: serverURL, apiKey: apiKey, secret: secret, now: func() time.Time { return time.Now().UTC() }}, nil
}

func (i *JWTIssuer) Issue(_ context.Context, request TokenRequest) (Token, error) {
	if strings.TrimSpace(request.RoomName) == "" || strings.TrimSpace(request.ParticipantIdentity) == "" {
		return Token{}, errors.New("LiveKit roomとparticipant identityは必須")
	}
	if request.Role != domain.RoleUser && request.Role != domain.RoleFamily {
		return Token{}, errors.New("LiveKit roleが不正")
	}
	now := i.now()
	if !request.ExpiresAt.After(now) {
		return Token{}, errors.New("LiveKit tokenの有効期限が不正")
	}
	canPublishData := request.Role == domain.RoleFamily
	sources := []string{"microphone"}
	if request.Role == domain.RoleUser {
		sources = append(sources, "screen_share")
	}
	claims := jwtClaims{
		Issuer: i.apiKey, Subject: request.ParticipantIdentity, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: request.ExpiresAt.Unix(),
		Identity: request.ParticipantIdentity,
		Video:    videoGrant{RoomJoin: true, Room: request.RoomName, CanPublish: true, CanSubscribe: true, CanPublishData: canPublishData, CanPublishSources: sources},
	}
	header, err := json.Marshal(struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}{"HS256", "JWT"})
	if err != nil {
		return Token{}, err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return Token{}, err
	}
	unsigned := encodeJWTPart(header) + "." + encodeJWTPart(payload)
	signer := hmac.New(sha256.New, []byte(i.secret))
	_, _ = signer.Write([]byte(unsigned))
	value := unsigned + "." + base64.RawURLEncoding.EncodeToString(signer.Sum(nil))
	return Token{ServerURL: i.serverURL, Value: value, ExpiresAt: request.ExpiresAt}, nil
}

type jwtClaims struct {
	Issuer    string     `json:"iss"`
	Subject   string     `json:"sub"`
	IssuedAt  int64      `json:"iat"`
	NotBefore int64      `json:"nbf"`
	ExpiresAt int64      `json:"exp"`
	Identity  string     `json:"identity"`
	Video     videoGrant `json:"video"`
}

type videoGrant struct {
	RoomJoin          bool     `json:"roomJoin"`
	Room              string   `json:"room"`
	CanPublish        bool     `json:"canPublish"`
	CanSubscribe      bool     `json:"canSubscribe"`
	CanPublishData    bool     `json:"canPublishData"`
	CanPublishSources []string `json:"canPublishSources"`
}

func encodeJWTPart(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }
