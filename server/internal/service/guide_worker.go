package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

const (
	guideAttemptTimeout = 55 * time.Second
	guidePollInterval   = 500 * time.Millisecond
)

type GuideGenerationFailure struct {
	Code  domain.GuideGenerationErrorCode
	Cause error
}

func (e *GuideGenerationFailure) Error() string {
	if e.Cause == nil {
		return string(e.Code)
	}
	return string(e.Code) + ": " + e.Cause.Error()
}

func (e *GuideGenerationFailure) Unwrap() error { return e.Cause }

type GuideWorker struct {
	store     repository.GuideStore
	storage   repository.ObjectStorage
	generator GuideGenerator
	publisher EventPublisher
	logger    *slog.Logger
	now       func() time.Time
	newID     IDFactory
	interval  time.Duration
}

func NewGuideWorker(store repository.GuideStore, storage repository.ObjectStorage, generator GuideGenerator, publisher EventPublisher, logger *slog.Logger) *GuideWorker {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &GuideWorker{store: store, storage: storage, generator: generator, publisher: publisher, logger: logger, now: func() time.Time { return time.Now().UTC() }, newID: guideRandomID, interval: guidePollInterval}
}

func (w *GuideWorker) Recover(ctx context.Context) error {
	var events []domain.Event
	err := w.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		jobs, err := tx.RecoverJobs(ctx, timestamp(w.now()))
		if err != nil {
			return err
		}
		for _, job := range jobs {
			session, err := tx.GetSessionByJob(ctx, job.ID)
			if err != nil {
				return err
			}
			events = append(events, workerEvent(w, domain.EventGuideGenerationJobUpdated, job.ID, job.Revision, job, pairForSession(session)))
		}
		return nil
	})
	if err != nil {
		return translateRepositoryError(err)
	}
	w.publish(ctx, events)
	return nil
}

func (w *GuideWorker) Run(ctx context.Context) error {
	if err := w.Recover(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		processed, err := w.RunOnce(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			w.logger.ErrorContext(ctx, "guide worker iteration failed", "error", err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if processed {
			continue
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (w *GuideWorker) RunOnce(ctx context.Context) (bool, error) {
	var job domain.GuideGenerationJob
	var session domain.SupportSession
	var claimEvents []domain.Event
	err := w.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		var err error
		job, err = tx.ClaimJob(ctx, timestamp(w.now()))
		if err != nil {
			return err
		}
		session, err = tx.GetSessionByJob(ctx, job.ID)
		if err != nil {
			return err
		}
		claimEvents = []domain.Event{workerEvent(w, domain.EventGuideGenerationJobUpdated, job.ID, job.Revision, job, pairForSession(session))}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, translateRepositoryError(err)
	}
	w.publish(ctx, claimEvents)

	attemptCtx, cancel := context.WithTimeout(ctx, guideAttemptTimeout)
	defer cancel()
	var generationContext repository.GenerationContext
	err = w.store.WithinTx(attemptCtx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		var contextErr error
		generationContext, contextErr = tx.GetGenerationContext(attemptCtx, job.ID)
		return contextErr
	})
	if err != nil {
		generationContext = repository.GenerationContext{JobID: job.ID, BatchID: job.BatchID, JobRevision: job.Revision, SupportSessionID: session.ID, SupportRequestID: session.SupportRequestID, UserID: session.UserID, FamilyID: session.FamilyID}
		return true, w.finishFailure(ctx, job, generationContext, domain.GuideGenerationAIInputUnavailable)
	}
	input, loadErr := w.loadInput(attemptCtx, generationContext)
	var output domain.GeneratedGuide
	if loadErr == nil {
		if w.generator == nil {
			loadErr = &GuideGenerationFailure{Code: domain.GuideGenerationAIUnavailable, Cause: errors.New("guide generator is not configured")}
		} else {
			output, loadErr = w.generator.Generate(attemptCtx, input)
		}
	}
	if loadErr == nil {
		allowed := make(map[domain.ID]struct{}, len(input.Images))
		for _, inputImage := range input.Images {
			allowed[inputImage.ArtifactID] = struct{}{}
		}
		if err := domain.ValidateGeneratedGuide(output, allowed); err != nil {
			loadErr = &GuideGenerationFailure{Code: domain.GuideGenerationAIInvalidOutput, Cause: err}
		}
	}
	if loadErr != nil {
		return true, w.finishFailure(ctx, job, generationContext, generationErrorCode(attemptCtx, loadErr))
	}
	return true, w.finishSuccess(ctx, job, generationContext, output)
}

func (w *GuideWorker) loadInput(ctx context.Context, generationContext repository.GenerationContext) (domain.GuideGenerationInput, error) {
	var materials []repository.GenerationMaterial
	err := w.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		var err error
		materials, err = tx.ListGenerationMaterials(ctx, generationContext.BatchID)
		return err
	})
	if err != nil {
		return domain.GuideGenerationInput{}, &GuideGenerationFailure{Code: domain.GuideGenerationAIInputUnavailable, Cause: err}
	}
	indexes := domain.SelectGuideMaterialIndexes(len(materials))
	images := make([]domain.GuideGenerationInputImage, 0, 1+len(indexes))
	initial, err := w.loadAndPrepare(ctx, generationContext.InitialStorageKey)
	if err != nil {
		return domain.GuideGenerationInput{}, err
	}
	images = append(images, domain.GuideGenerationInputImage{Kind: domain.ArtifactPurposeRequestScreenshot, ArtifactID: generationContext.InitialScreenshotArtifactID, CapturedAt: generationContext.InitialCapturedAt.Time, Sequence: 0, JPEG: initial})
	for _, index := range indexes {
		material := materials[index]
		prepared, err := w.loadAndPrepare(ctx, material.StorageKey)
		if err != nil {
			return domain.GuideGenerationInput{}, err
		}
		images = append(images, domain.GuideGenerationInputImage{Kind: domain.ArtifactPurposeGuideMaterial, ArtifactID: material.ArtifactID, CapturedAt: material.CapturedAt.Time, Sequence: material.Sequence, JPEG: prepared})
	}
	return domain.GuideGenerationInput{Comment: generationContext.Comment, Images: images}, nil
}

func (w *GuideWorker) loadAndPrepare(ctx context.Context, key string) ([]byte, error) {
	if w.storage == nil {
		return nil, &GuideGenerationFailure{Code: domain.GuideGenerationAIInputUnavailable, Cause: errors.New("object storage is not configured")}
	}
	object, err := w.storage.Get(ctx, key)
	if err != nil {
		return nil, &GuideGenerationFailure{Code: domain.GuideGenerationAIInputUnavailable, Cause: err}
	}
	defer func() { _ = object.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(object.Body, domain.MaxArtifactBytes+1))
	if err != nil || len(raw) == 0 || int64(len(raw)) > domain.MaxArtifactBytes {
		return nil, &GuideGenerationFailure{Code: domain.GuideGenerationAIInputUnavailable, Cause: err}
	}
	prepared, err := prepareGuideImage(raw)
	if err != nil {
		return nil, &GuideGenerationFailure{Code: domain.GuideGenerationAIInputUnavailable, Cause: err}
	}
	return prepared, nil
}

func prepareGuideImage(raw []byte) ([]byte, error) {
	source, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil || format != "jpeg" {
		return nil, errors.New("guide input image is invalid")
	}
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width < 1 || height < 1 {
		return nil, errors.New("guide input image dimensions are invalid")
	}
	targetWidth, targetHeight := fitDimensions(width, height, 1920, 1080)
	current := source
	if targetWidth != width || targetHeight != height {
		current = resizeNearest(source, targetWidth, targetHeight)
	}
	for {
		for quality := 80; quality >= 30; quality -= 10 {
			var output bytes.Buffer
			if err := jpeg.Encode(&output, current, &jpeg.Options{Quality: quality}); err != nil {
				return nil, err
			}
			if output.Len() <= domain.MaxAIInputImageBytes {
				return output.Bytes(), nil
			}
		}
		bounds = current.Bounds()
		if bounds.Dx() <= 320 || bounds.Dy() <= 180 {
			break
		}
		current = resizeNearest(current, bounds.Dx()*4/5, bounds.Dy()*4/5)
	}
	return nil, errors.New("guide input image cannot fit the size limit")
}

func fitDimensions(width, height, maxWidth, maxHeight int) (int, int) {
	if width <= maxWidth && height <= maxHeight {
		return width, height
	}
	if width*maxHeight > height*maxWidth {
		return maxWidth, max(1, height*maxWidth/width)
	}
	return max(1, width*maxHeight/height), maxHeight
}

func resizeNearest(source image.Image, width, height int) image.Image {
	destination := image.NewRGBA(image.Rect(0, 0, width, height))
	bounds := source.Bounds()
	for y := range height {
		sourceY := bounds.Min.Y + y*bounds.Dy()/height
		for x := range width {
			sourceX := bounds.Min.X + x*bounds.Dx()/width
			destination.Set(x, y, source.At(sourceX, sourceY))
		}
	}
	return destination
}

func generationErrorCode(ctx context.Context, err error) domain.GuideGenerationErrorCode {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return domain.GuideGenerationAITimeout
	}
	var failure *GuideGenerationFailure
	if errors.As(err, &failure) && failure.Code.Valid() {
		return failure.Code
	}
	return domain.GuideGenerationAIUnavailable
}

func (w *GuideWorker) finishFailure(ctx context.Context, claimed domain.GuideGenerationJob, generationContext repository.GenerationContext, code domain.GuideGenerationErrorCode) error {
	var events []domain.Event
	err := w.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		session, err := tx.GetSession(ctx, generationContext.SupportSessionID, true)
		if err != nil {
			return err
		}
		job, err := tx.GetJob(ctx, claimed.ID, true)
		if err != nil {
			return err
		}
		if job.Status != domain.GuideGenerationJobRunning || job.Revision != claimed.Revision {
			return nil
		}
		job, err = tx.FailJob(ctx, job.ID, claimed.Revision, code, timestamp(w.now()))
		if err != nil {
			return err
		}
		events = []domain.Event{workerEvent(w, domain.EventGuideGenerationJobUpdated, job.ID, job.Revision, job, pairForSession(session))}
		return nil
	})
	if err != nil {
		return translateRepositoryError(err)
	}
	w.publish(ctx, events)
	return nil
}

func (w *GuideWorker) finishSuccess(ctx context.Context, claimed domain.GuideGenerationJob, generationContext repository.GenerationContext, output domain.GeneratedGuide) error {
	var events []domain.Event
	err := w.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		session, err := tx.GetSession(ctx, generationContext.SupportSessionID, true)
		if err != nil {
			return err
		}
		job, err := tx.GetJob(ctx, claimed.ID, true)
		if err != nil {
			return err
		}
		if job.Status != domain.GuideGenerationJobRunning || job.Revision != claimed.Revision || session.Status != domain.SupportSessionGeneratingGuide {
			return nil
		}
		now := w.now()
		steps := make([]domain.GuideStep, len(output.Steps))
		for index, step := range output.Steps {
			steps[index] = domain.GuideStep{Position: index + 1, ArtifactID: step.SourceArtifactID, Instruction: step.Instruction}
		}
		draft := domain.GuideDraft{ID: w.newID("draft_"), SupportSessionID: session.ID, Title: output.Title, Steps: steps, Status: domain.GuideDraftEditing, Revision: 1, CreatedAt: now, UpdatedAt: now}
		draft, err = tx.CreateDraft(ctx, draft)
		if err != nil {
			return err
		}
		job, err = tx.SucceedJob(ctx, job.ID, claimed.Revision, draft.ID, timestamp(now))
		if err != nil {
			return err
		}
		session, err = tx.ReviewDraft(ctx, session.ID, draft.ID, timestamp(now))
		if err != nil {
			return err
		}
		pair := pairForSession(session)
		events = []domain.Event{workerEvent(w, domain.EventGuideDraftCreated, draft.ID, draft.Revision, draft, pair), workerEvent(w, domain.EventGuideGenerationJobUpdated, job.ID, job.Revision, job, pair), workerEvent(w, domain.EventSupportSessionUpdated, session.ID, session.Revision, session, pair)}
		return nil
	})
	if err != nil {
		return translateRepositoryError(err)
	}
	w.publish(ctx, events)
	return nil
}

func workerEvent(w *GuideWorker, eventType domain.EventType, id domain.ID, revision int64, data any, pair domain.UserPair) domain.Event {
	body, _ := jsonMarshal(data)
	return domain.Event{EventID: w.newID("evt_"), Type: eventType, OccurredAt: w.now(), EntityID: id, Revision: revision, Data: body, Audience: pair}
}

func jsonMarshal(value any) ([]byte, error) { return json.Marshal(value) }

func (w *GuideWorker) publish(ctx context.Context, events []domain.Event) {
	if w.publisher == nil {
		return
	}
	for _, event := range events {
		if err := w.publisher.Publish(ctx, event); err != nil {
			w.logger.WarnContext(ctx, "event delivery failed", "eventId", event.EventID, "eventType", event.Type, "entityId", event.EntityID, "revision", event.Revision)
		}
	}
}
