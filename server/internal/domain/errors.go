package domain

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	CodeValidationError              ErrorCode = "VALIDATION_ERROR"
	CodeUnauthenticated              ErrorCode = "UNAUTHENTICATED"
	CodeForbidden                    ErrorCode = "FORBIDDEN"
	CodeNotFound                     ErrorCode = "NOT_FOUND"
	CodeInvalidState                 ErrorCode = "INVALID_STATE"
	CodeRevisionConflict             ErrorCode = "REVISION_CONFLICT"
	CodeIdempotencyKeyReused         ErrorCode = "IDEMPOTENCY_KEY_REUSED"
	CodeIdempotencyRequestInProgress ErrorCode = "IDEMPOTENCY_REQUEST_IN_PROGRESS"
	CodeDuplicateActiveRequest       ErrorCode = "DUPLICATE_ACTIVE_REQUEST"
	CodeMaterialConflict             ErrorCode = "MATERIAL_CONFLICT"
	CodeFileTooLarge                 ErrorCode = "FILE_TOO_LARGE"
	CodeInsufficientMaterials        ErrorCode = "INSUFFICIENT_MATERIALS"
	CodeInternalError                ErrorCode = "INTERNAL_ERROR"
	CodeExternalServiceUnavailable   ErrorCode = "EXTERNAL_SERVICE_UNAVAILABLE"
)

type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e.Cause == nil {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Cause)
}

func (e *Error) Unwrap() error {
	return e.Cause
}

func NewError(code ErrorCode, message string) *Error {
	return &Error{Code: code, Message: message}
}

func WrapError(code ErrorCode, message string, cause error) *Error {
	return &Error{Code: code, Message: message, Cause: cause}
}

func ErrorCodeOf(err error) (ErrorCode, bool) {
	var domainErr *Error
	if !errors.As(err, &domainErr) {
		return "", false
	}
	return domainErr.Code, true
}
