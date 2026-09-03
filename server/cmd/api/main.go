package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kakuraccho/mite/server/internal/config"
	"github.com/kakuraccho/mite/server/internal/handler"
	"github.com/kakuraccho/mite/server/internal/livekit"
	"github.com/kakuraccho/mite/server/internal/repository"
	"github.com/kakuraccho/mite/server/internal/service"
	"github.com/kakuraccho/mite/server/internal/websocket"
	"github.com/kakuraccho/mite/server/internal/worker"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("server stopped", "errorCode", "STARTUP_FAILED")
		os.Exit(1)
	}
}

type serverRuntime struct {
	handler http.Handler
	workers []func(context.Context) error
}

func newServerRuntime(
	cfg config.Config,
	logger *slog.Logger,
	pool *pgxpool.Pool,
	guideGenerator service.GuideGenerator,
) (serverRuntime, error) {
	storage, err := repository.NewSupabaseStorage(
		cfg.SupabaseURL,
		cfg.SupabaseStorageBucket,
		cfg.SupabaseSecretKey,
		nil,
	)
	if err != nil {
		return serverRuntime{}, fmt.Errorf("configure Supabase Storage: %w", err)
	}
	liveKitIssuer, err := livekit.NewJWTIssuer(cfg.LiveKitURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret)
	if err != nil {
		return serverRuntime{}, fmt.Errorf("configure LiveKit token issuer: %w", err)
	}
	if guideGenerator == nil {
		guideGenerator, err = service.NewGeminiGuideGenerator(
			cfg.AIBaseURL,
			cfg.GeminiAPIKey,
			cfg.AIModel,
			cfg.AIPromptVersion,
			nil,
		)
		if err != nil {
			return serverRuntime{}, fmt.Errorf("configure Gemini guide generator: %w", err)
		}
	}

	authenticator := handler.NewAuthenticator(cfg.DemoUserToken, cfg.DemoFamilyToken)
	eventHub := websocket.NewHub(authenticator, cfg.ClientOrigins)
	artifactService := service.NewArtifactSupportService(
		repository.NewArtifactSupportRepository(pool),
		storage,
		eventHub,
		logger,
		service.ArtifactSupportServiceOptions{},
	)
	supportSessionService := service.NewSupportSessionService(
		repository.NewPostgresSupportSessionStore(pool),
		eventHub,
		liveKitIssuer,
		logger,
	)
	guideRepository := repository.NewGuideRepository(pool)
	guideService := service.NewGuideService(guideRepository, storage, eventHub, logger)
	api := handler.API{
		ArtifactSupportAPI: handler.NewArtifactSupportHandler(artifactService),
		SupportSessionAPI:  handler.NewSupportSessionHandler(supportSessionService),
		GuideAPI:           handler.NewGuideHandler(guideService),
	}

	return serverRuntime{
		handler: handler.NewRouterWithEvents(cfg, logger, api, eventHub.Handler()),
		workers: []func(context.Context) error{
			worker.NewArtifactDeletionWorker(artifactService, logger).Run,
			service.NewGuideWorker(guideRepository, storage, guideGenerator, eventHub, logger).Run,
		},
	}, nil
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return err
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		return err
	}
	defer pool.Close()

	startupContext, cancelStartup := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelStartup()
	if err := pool.Ping(startupContext); err != nil {
		return err
	}
	cancelStartup()

	runtime, err := newServerRuntime(cfg, logger, pool, nil)
	if err != nil {
		return err
	}

	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           runtime.handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	shutdownSignal, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	workerContext, cancelWorkers := context.WithCancel(context.Background())
	defer cancelWorkers()
	workerErrors := make(chan error, len(runtime.workers))
	for _, runWorker := range runtime.workers {
		runWorker := runWorker
		go func() {
			workerErrors <- runWorker(workerContext)
		}()
	}

	serverError := make(chan error, 1)
	go func() {
		logger.Info("server started", "port", cfg.Port)
		serverError <- server.ListenAndServe()
	}()

	select {
	case err := <-serverError:
		cancelWorkers()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err := <-workerErrors:
		cancelWorkers()
		shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		_ = server.Shutdown(shutdownContext)
		if err == nil {
			return errors.New("background worker stopped unexpectedly")
		}
		return fmt.Errorf("background worker stopped: %w", err)
	case <-shutdownSignal.Done():
	}

	cancelWorkers()
	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := server.Shutdown(shutdownContext); err != nil {
		return err
	}
	for range runtime.workers {
		select {
		case err := <-workerErrors:
			if err != nil && !errors.Is(err, context.Canceled) {
				return fmt.Errorf("background worker shutdown: %w", err)
			}
		case <-shutdownContext.Done():
			return shutdownContext.Err()
		}
	}
	return nil
}
