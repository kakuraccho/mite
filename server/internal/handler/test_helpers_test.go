package handler

import (
	"context"
	"net/http"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func contextWithRequestID(request *http.Request, requestID string) context.Context {
	return context.WithValue(request.Context(), requestIDContextKey, requestID)
}

func idempotencyInProgressError() error {
	return domain.NewError(domain.CodeIdempotencyRequestInProgress, "同じリクエストを処理中")
}
