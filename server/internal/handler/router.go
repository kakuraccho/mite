package handler

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/kakuraccho/mite/server/internal/config"
	"github.com/kakuraccho/mite/server/internal/generated"
)

func NewRouter(
	cfg config.Config,
	logger *slog.Logger,
	api generated.StrictServerInterface,
) http.Handler {
	router := chi.NewRouter()
	router.Use(RequestID)
	router.Use(Recover(logger))
	router.Use(AccessLog(logger))
	router.Use(CORS(cfg.ClientOrigins))
	router.Use(NewAuthenticator(cfg.DemoUserToken, cfg.DemoFamilyToken).Middleware)

	if api != nil {
		strictHandler := generated.NewStrictHandlerWithOptions(
			api,
			nil,
			generated.StrictHTTPServerOptions{
				RequestErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, _ error) {
					WriteError(w, r, validationRequestError())
				},
				ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, _ error) {
					WriteError(w, r, domainInternalError())
				},
			},
		)
		generated.HandlerFromMux(strictHandler, router)
	}
	return router
}
