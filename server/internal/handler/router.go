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
	return NewRouterWithEvents(cfg, logger, api, nil)
}

// NewRouterWithEvents wires the WebSocket endpoint outside REST bearer
// middleware because /v1/events authenticates with its first message.
func NewRouterWithEvents(
	cfg config.Config,
	logger *slog.Logger,
	api generated.StrictServerInterface,
	events http.Handler,
) http.Handler {
	router := chi.NewRouter()
	router.Use(RequestID)
	router.Use(Recover(logger))
	if events != nil {
		router.Handle("/v1/events", events)
	}

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
		// A mounted router runs CORS before matching generated REST methods.
		// An inline group would reject OPTIONS before its middleware runs.
		rest := chi.NewRouter()
		rest.Use(AccessLog(logger))
		rest.Use(CORS(cfg.ClientOrigins))
		rest.Use(NewAuthenticator(cfg.DemoUserToken, cfg.DemoFamilyToken).Middleware)
		generated.HandlerFromMux(strictHandler, rest)
		router.Mount("/", rest)
	}
	return router
}
