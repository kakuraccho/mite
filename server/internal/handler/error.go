package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      domain.ErrorCode `json:"code"`
	Message   string           `json:"message"`
	RequestID string           `json:"requestId"`
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	domainErr := publicError(err)
	if domainErr.Code == domain.CodeIdempotencyRequestInProgress {
		w.Header().Set("Retry-After", "1")
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusForCode(domainErr.Code))
	_ = json.NewEncoder(w).Encode(errorEnvelope{
		Error: errorBody{
			Code:      domainErr.Code,
			Message:   domainErr.Message,
			RequestID: RequestIDFromContext(r.Context()),
		},
	})
}

func publicError(err error) *domain.Error {
	var domainErr *domain.Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return domain.NewError(domain.CodeInternalError, "サーバー内部でエラーが発生した")
}

func statusForCode(code domain.ErrorCode) int {
	switch code {
	case domain.CodeValidationError:
		return http.StatusBadRequest
	case domain.CodeUnauthenticated:
		return http.StatusUnauthorized
	case domain.CodeForbidden:
		return http.StatusForbidden
	case domain.CodeNotFound:
		return http.StatusNotFound
	case domain.CodeInvalidState,
		domain.CodeRevisionConflict,
		domain.CodeIdempotencyKeyReused,
		domain.CodeIdempotencyRequestInProgress,
		domain.CodeDuplicateActiveRequest,
		domain.CodeMaterialConflict:
		return http.StatusConflict
	case domain.CodeFileTooLarge:
		return http.StatusRequestEntityTooLarge
	case domain.CodeInsufficientMaterials:
		return http.StatusUnprocessableEntity
	case domain.CodeExternalServiceUnavailable:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}
