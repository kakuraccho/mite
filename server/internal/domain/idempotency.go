package domain

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"
)

const (
	IdempotencyRetention = 24 * time.Hour
	IdempotencyLease     = 2 * time.Minute
)

type IdempotencyKey string

func NewIdempotencyKey(value string) (IdempotencyKey, error) {
	if len(value) < 1 || len(value) > 128 {
		return "", NewError(CodeValidationError, "Idempotency-Keyは1〜128文字で指定する")
	}
	for _, char := range []byte(value) {
		if char < 0x20 || char > 0x7e {
			return "", NewError(CodeValidationError, "Idempotency-KeyはASCII文字で指定する")
		}
	}
	return IdempotencyKey(value), nil
}

type RequestHash string

func NewRequestHash(value string) (RequestHash, error) {
	if len(value) != sha256.Size*2 {
		return "", NewError(CodeValidationError, "requestHashが不正")
	}
	if _, err := hex.DecodeString(value); err != nil || strings.ToLower(value) != value {
		return "", NewError(CodeValidationError, "requestHashが不正")
	}
	return RequestHash(value), nil
}

func HashCanonicalJSON(value any) (RequestHash, error) {
	reflected := reflect.ValueOf(value)
	if reflected.Kind() == reflect.Pointer {
		if reflected.IsNil() {
			return "", NewError(CodeValidationError, "正規化済みリクエストが必要")
		}
		reflected = reflected.Elem()
	}
	if reflected.Kind() != reflect.Struct {
		return "", NewError(CodeValidationError, "正規化済みの構造体が必要")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return "", WrapError(CodeValidationError, "リクエストを正規化できない", err)
	}
	digest := sha256.Sum256(canonical)
	return RequestHash(hex.EncodeToString(digest[:])), nil
}

type MultipartHashPart struct {
	Name  string
	Value string
}

func HashCanonicalMultipart(fields []MultipartHashPart, fileSHA256 RequestHash) (RequestHash, error) {
	if _, err := NewRequestHash(string(fileSHA256)); err != nil {
		return "", err
	}
	hash := sha256.New()
	for _, field := range fields {
		if field.Name == "" {
			return "", NewError(CodeValidationError, "multipart field名が空")
		}
		writeHashPart(hash, field.Name, field.Value)
	}
	writeHashPart(hash, "fileSha256", string(fileSHA256))
	return RequestHash(hex.EncodeToString(hash.Sum(nil))), nil
}

type hashWriter interface {
	Write([]byte) (int, error)
}

func writeHashPart(writer hashWriter, name, value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(name)))
	_, _ = writer.Write(size[:])
	_, _ = writer.Write([]byte(name))
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = writer.Write(size[:])
	_, _ = writer.Write([]byte(value))
}

type IdempotencyStatus string

const (
	IdempotencyInProgress IdempotencyStatus = "IN_PROGRESS"
	IdempotencyCompleted  IdempotencyStatus = "COMPLETED"
)

func (s IdempotencyStatus) Valid() bool {
	return s == IdempotencyInProgress || s == IdempotencyCompleted
}

type IdempotencyScope struct {
	ActorID ID
	Method  string
	Path    string
	Key     IdempotencyKey
}

func (s IdempotencyScope) Validate() error {
	if _, err := NewID(string(s.ActorID)); err != nil {
		return err
	}
	if s.Method != "POST" {
		return NewError(CodeValidationError, "Idempotency-Keyの対象methodが不正")
	}
	if strings.TrimSpace(s.Path) == "" {
		return NewError(CodeValidationError, "pathが不正")
	}
	if _, err := NewIdempotencyKey(string(s.Key)); err != nil {
		return err
	}
	return nil
}

type IdempotencyRecord struct {
	Scope          IdempotencyScope
	RequestHash    RequestHash
	Status         IdempotencyStatus
	ResourceID     *ID
	ResponseStatus *int
	ResponseBody   json.RawMessage
	LeaseExpiresAt *time.Time
	CreatedAt      time.Time
	CompletedAt    *time.Time
	ExpiresAt      *time.Time
}

func (r IdempotencyRecord) Validate() error {
	if err := r.Scope.Validate(); err != nil {
		return err
	}
	if _, err := NewRequestHash(string(r.RequestHash)); err != nil {
		return err
	}
	switch r.Status {
	case IdempotencyInProgress:
		if r.LeaseExpiresAt == nil || r.ResponseStatus != nil || r.CompletedAt != nil || r.ExpiresAt != nil || r.ResponseBody != nil {
			return NewError(CodeInternalError, "処理中のIdempotencyRecordが不正")
		}
	case IdempotencyCompleted:
		if r.LeaseExpiresAt != nil || r.ResponseStatus == nil || len(r.ResponseBody) == 0 || r.CompletedAt == nil || r.ExpiresAt == nil {
			return NewError(CodeInternalError, "完了済みIdempotencyRecordが不正")
		}
		if !r.ExpiresAt.Equal(r.CompletedAt.Add(IdempotencyRetention)) {
			return NewError(CodeInternalError, "IdempotencyRecordの保存期限が不正")
		}
	default:
		return NewError(CodeInternalError, fmt.Sprintf("未知のIdempotencyRecord状態: %s", r.Status))
	}
	return nil
}
