package domain

import (
	"net/url"
	"strings"
	"time"
)

const (
	MaxPushEndpointLength = 2048
	MaxPushKeyLength      = 256
)

type UserPresence struct {
	UserID          ID
	Status          PresenceStatus
	ConnectedSince  *time.Time
	LastSeenAt      *time.Time
	UpdatedAt       *time.Time
	ConnectionEpoch int64
	Revision        int64
}

func OfflineUserPresence(userID ID) UserPresence {
	return UserPresence{UserID: userID, Status: PresenceOffline}
}

func (p UserPresence) ValidateStored() error {
	if _, err := NewID(string(p.UserID)); err != nil {
		return err
	}
	if p.ConnectedSince == nil || p.LastSeenAt == nil || p.UpdatedAt == nil ||
		p.ConnectedSince.After(*p.LastSeenAt) || p.LastSeenAt.After(*p.UpdatedAt) ||
		p.ConnectionEpoch < 1 || p.Revision < 1 {
		return NewError(CodeValidationError, "UserPresenceが不正")
	}
	return nil
}

type PushSubscription struct {
	ID        ID
	FamilyID  ID
	Endpoint  string
	P256DH    string
	Auth      string
	CreatedAt time.Time
	UpdatedAt time.Time
	Revision  int64
}

func (s PushSubscription) Validate() error {
	if _, err := NewID(string(s.ID)); err != nil {
		return err
	}
	if _, err := NewID(string(s.FamilyID)); err != nil {
		return err
	}
	parsed, err := url.Parse(s.Endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.Fragment != "" || len(s.Endpoint) > MaxPushEndpointLength {
		return NewError(CodeValidationError, "Push endpointが不正")
	}
	if len(s.P256DH) < 1 || len(s.P256DH) > MaxPushKeyLength ||
		len(s.Auth) < 1 || len(s.Auth) > MaxPushKeyLength ||
		strings.TrimSpace(s.P256DH) != s.P256DH || strings.TrimSpace(s.Auth) != s.Auth {
		return NewError(CodeValidationError, "Push購読鍵が不正")
	}
	if s.CreatedAt.IsZero() || s.UpdatedAt.Before(s.CreatedAt) || s.Revision < 1 {
		return NewError(CodeValidationError, "PushSubscription日時が不正")
	}
	return nil
}
