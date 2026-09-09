package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/livekit"
	"github.com/kakuraccho/mite/server/internal/repository"
)

const liveKitTokenTTL = 30 * time.Minute

type SupportSessionPair struct {
	SupportRequest domain.SupportRequest
	SupportSession domain.SupportSession
}

type LiveKitConnection struct {
	ServerURL           string
	RoomName            string
	ParticipantIdentity string
	Token               string
	ExpiresAt           time.Time
}

type SupportSessionOperationError struct {
	Err       error
	RequestID string
}

func (e *SupportSessionOperationError) Error() string { return e.Err.Error() }
func (e *SupportSessionOperationError) Unwrap() error { return e.Err }

type SupportSessionService struct {
	store     repository.SupportSessionStore
	publisher EventPublisher
	issuer    livekit.TokenIssuer
	logger    *slog.Logger
	now       func() time.Time
	newID     func(string) (domain.ID, error)
}

func NewSupportSessionService(
	store repository.SupportSessionStore,
	publisher EventPublisher,
	issuer livekit.TokenIssuer,
	logger *slog.Logger,
) *SupportSessionService {
	if logger == nil {
		logger = slog.Default()
	}
	return &SupportSessionService{store: store, publisher: publisher, issuer: issuer, logger: logger, now: func() time.Time { return time.Now().UTC() }, newID: randomDomainID}
}

func (s *SupportSessionService) Get(ctx context.Context, actor domain.Actor, rawID string) (domain.SupportSession, error) {
	if err := actor.Validate(); err != nil {
		return domain.SupportSession{}, err
	}
	id := domain.ID(rawID)
	session, err := s.store.GetSession(ctx, id)
	if err != nil {
		return domain.SupportSession{}, err
	}
	if err := sessionPair(session).Authorize(actor, domain.RoleUser, domain.RoleFamily); err != nil {
		return domain.SupportSession{}, err
	}
	return session, nil
}

func (s *SupportSessionService) Call(
	ctx context.Context, actor domain.Actor, rawRequestID string, expectedRevision int64,
	rawKey, requestID string,
) (SupportSessionPair, error) {
	requestIDValue, key, err := validateMutation(actor, rawRequestID, rawKey, domain.RoleFamily)
	if err != nil {
		return SupportSessionPair{}, err
	}
	if expectedRevision < 1 {
		return SupportSessionPair{}, domain.NewError(domain.CodeValidationError, "expectedRequestRevisionは1以上で指定する")
	}
	request, err := s.store.GetRequest(ctx, requestIDValue)
	if err != nil {
		return SupportSessionPair{}, err
	}
	if err := requestPair(request).Authorize(actor, domain.RoleFamily); err != nil {
		return SupportSessionPair{}, err
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedRequestRevision int64 `json:"expectedRequestRevision"`
	}{expectedRevision})
	if err != nil {
		return SupportSessionPair{}, err
	}
	sessionID, err := s.newID("session")
	if err != nil {
		return SupportSessionPair{}, err
	}
	now := s.now()
	scope := idempotencyScope(actor, http.MethodPost, "/v1/support-requests/"+string(requestIDValue)+"/call", key)
	var result SupportSessionPair
	var resultErr error
	var events []domain.Event
	err = s.store.WithinTransaction(ctx, func(tx repository.SupportSessionTransaction) error {
		lockedRequest, lockErr := tx.LockRequest(ctx, requestIDValue)
		if lockErr != nil {
			return lockErr
		}
		if authErr := requestPair(lockedRequest).Authorize(actor, domain.RoleFamily); authErr != nil {
			return authErr
		}
		replay, beginErr := beginSessionIdempotency(ctx, tx, scope, hash, now)
		if beginErr != nil {
			return beginErr
		}
		if replay != nil {
			result, resultErr = decodePairReplay(*replay, http.StatusCreated)
			return nil
		}
		if validationErr := domain.ValidateExpectedRevision(lockedRequest.Revision, expectedRevision); validationErr != nil {
			resultErr, beginErr = persistMutationError(ctx, tx, scope, validationErr, requestID, now)
			return beginErr
		}
		newSession, validationErr := domain.NewRingingSupportSession(sessionID, lockedRequest, now)
		if validationErr != nil {
			resultErr, beginErr = persistMutationError(ctx, tx, scope, validationErr, requestID, now)
			return beginErr
		}
		createdSession, createErr := tx.CreateSession(ctx, newSession)
		if createErr != nil {
			return createErr
		}
		updatedRequest, updateErr := tx.AttachSession(ctx, lockedRequest.ID, createdSession.ID, now)
		if updateErr != nil {
			return updateErr
		}
		body, marshalErr := marshalPairResponse(updatedRequest, createdSession)
		if marshalErr != nil {
			return marshalErr
		}
		if completeErr := tx.CompleteIdempotency(ctx, scope, http.StatusCreated, body, now); completeErr != nil {
			return completeErr
		}
		result = SupportSessionPair{SupportRequest: updatedRequest, SupportSession: createdSession}
		events, createErr = s.pairEvents(now, domain.EventSupportRequestUpdated, updatedRequest, domain.EventSupportSessionCreated, createdSession)
		return createErr
	})
	if err != nil {
		return SupportSessionPair{}, err
	}
	if resultErr != nil {
		return SupportSessionPair{}, resultErr
	}
	s.publish(ctx, events)
	return result, nil
}

func (s *SupportSessionService) Accept(
	ctx context.Context, actor domain.Actor, rawSessionID string, expectedRevision int64,
	consent domain.Consent, rawKey, requestID string,
) (SupportSessionPair, error) {
	if err := authorizeActorRole(actor, domain.RoleUser); err != nil {
		return SupportSessionPair{}, err
	}
	if expectedRevision < 1 {
		return SupportSessionPair{}, domain.NewError(domain.CodeValidationError, "expectedSessionRevisionは1以上で指定する")
	}
	if !consent.Accepted() {
		return SupportSessionPair{}, domain.NewError(domain.CodeValidationError, "音声、画面共有、定期取得への同意が必要")
	}
	payload := struct {
		ExpectedSessionRevision int64 `json:"expectedSessionRevision"`
		Consent                 struct {
			Audio           bool   `json:"audio"`
			ScreenShare     bool   `json:"screenShare"`
			PeriodicCapture bool   `json:"periodicCapture"`
			TextVersion     string `json:"textVersion"`
		} `json:"consent"`
	}{ExpectedSessionRevision: expectedRevision, Consent: struct {
		Audio           bool   `json:"audio"`
		ScreenShare     bool   `json:"screenShare"`
		PeriodicCapture bool   `json:"periodicCapture"`
		TextVersion     string `json:"textVersion"`
	}{consent.Audio, consent.ScreenShare, consent.PeriodicCapture, consent.TextVersion}}
	sessionID, key, session, hash, err := s.prepareSessionMutation(ctx, actor, rawSessionID, rawKey, payload, domain.RoleUser)
	if err != nil {
		return SupportSessionPair{}, err
	}
	now := s.now()
	scope := idempotencyScope(actor, http.MethodPost, "/v1/support-sessions/"+string(sessionID)+"/accept", key)
	return s.mutatePair(ctx, actor, session, expectedRevision, scope, hash, requestID, now, http.StatusOK, func(tx repository.SupportSessionTransaction, request domain.SupportRequest, locked domain.SupportSession) (SupportSessionPair, error) {
		if err := domain.ValidateAcceptSupportSession(locked, request, consent); err != nil {
			return SupportSessionPair{}, err
		}
		updatedRequest, err := tx.ActivateRequest(ctx, request.ID, now)
		if err != nil {
			return SupportSessionPair{}, err
		}
		updatedSession, err := tx.ActivateSession(ctx, locked.ID, consent, now)
		return SupportSessionPair{SupportRequest: updatedRequest, SupportSession: updatedSession}, err
	}, domain.EventSupportRequestUpdated, domain.EventSupportSessionUpdated)
}

func (s *SupportSessionService) Resolve(
	ctx context.Context, actor domain.Actor, rawSessionID string, expectedRevision int64,
	decision domain.GuideDecision, rawKey, requestID string,
) (SupportSessionPair, error) {
	if err := authorizeActorRole(actor, domain.RoleFamily); err != nil {
		return SupportSessionPair{}, err
	}
	if expectedRevision < 1 {
		return SupportSessionPair{}, domain.NewError(domain.CodeValidationError, "expectedSessionRevisionは1以上で指定する")
	}
	if !decision.Valid() {
		return SupportSessionPair{}, domain.NewError(domain.CodeValidationError, "guideDecisionが不正")
	}
	payload := struct {
		ExpectedSessionRevision int64                `json:"expectedSessionRevision"`
		GuideDecision           domain.GuideDecision `json:"guideDecision"`
	}{expectedRevision, decision}
	sessionID, key, session, hash, err := s.prepareSessionMutation(ctx, actor, rawSessionID, rawKey, payload, domain.RoleFamily)
	if err != nil {
		return SupportSessionPair{}, err
	}
	now := s.now()
	scope := idempotencyScope(actor, http.MethodPost, "/v1/support-sessions/"+string(sessionID)+"/resolve", key)
	return s.mutatePair(ctx, actor, session, expectedRevision, scope, hash, requestID, now, http.StatusOK, func(tx repository.SupportSessionTransaction, request domain.SupportRequest, locked domain.SupportSession) (SupportSessionPair, error) {
		if err := domain.ValidateResolveSupportSession(locked, request, decision); err != nil {
			return SupportSessionPair{}, err
		}
		updatedRequest, err := tx.ResolveRequest(ctx, request.ID, now)
		if err != nil {
			return SupportSessionPair{}, err
		}
		updatedSession, err := tx.ResolveSession(ctx, locked.ID, decision, now)
		return SupportSessionPair{SupportRequest: updatedRequest, SupportSession: updatedSession}, err
	}, domain.EventSupportRequestUpdated, domain.EventSupportSessionUpdated)
}

func (s *SupportSessionService) EndWithoutGuide(
	ctx context.Context, actor domain.Actor, rawSessionID string, expectedRevision int64,
	reason domain.SupportSessionEndReason, rawKey, requestID string,
) (domain.SupportSession, error) {
	if err := authorizeActorRole(actor, domain.RoleUser, domain.RoleFamily); err != nil {
		return domain.SupportSession{}, err
	}
	if expectedRevision < 1 {
		return domain.SupportSession{}, domain.NewError(domain.CodeValidationError, "expectedSessionRevisionは1以上で指定する")
	}
	if reason != domain.EndReasonGuideCancelled && reason != domain.EndReasonNoMaterials {
		return domain.SupportSession{}, domain.NewError(domain.CodeValidationError, "reasonが不正")
	}
	if (actor.Role == domain.RoleUser && reason != domain.EndReasonNoMaterials) ||
		(actor.Role == domain.RoleFamily && reason != domain.EndReasonGuideCancelled) {
		return domain.SupportSession{}, domain.NewError(domain.CodeForbidden, "この役割では指定したreasonを使用できない")
	}
	payload := struct {
		ExpectedSessionRevision int64                          `json:"expectedSessionRevision"`
		Reason                  domain.SupportSessionEndReason `json:"reason"`
	}{expectedRevision, reason}
	sessionID, key, session, hash, err := s.prepareSessionMutation(ctx, actor, rawSessionID, rawKey, payload, domain.RoleUser, domain.RoleFamily)
	if err != nil {
		return domain.SupportSession{}, err
	}
	now := s.now()
	scope := idempotencyScope(actor, http.MethodPost, "/v1/support-sessions/"+string(sessionID)+"/end-without-guide", key)
	var result domain.SupportSession
	var resultErr error
	var events []domain.Event
	err = s.store.WithinTransaction(ctx, func(tx repository.SupportSessionTransaction) error {
		if _, lockErr := tx.LockRequest(ctx, session.SupportRequestID); lockErr != nil {
			return lockErr
		}
		locked, lockErr := tx.LockSession(ctx, sessionID)
		if lockErr != nil {
			return lockErr
		}
		if authErr := sessionPair(locked).Authorize(actor, domain.RoleUser, domain.RoleFamily); authErr != nil {
			return authErr
		}
		replay, beginErr := beginSessionIdempotency(ctx, tx, scope, hash, now)
		if beginErr != nil {
			return beginErr
		}
		if replay != nil {
			result, resultErr = decodeSessionReplay(*replay, http.StatusOK)
			return nil
		}
		if validationErr := domain.ValidateExpectedRevision(locked.Revision, expectedRevision); validationErr != nil {
			resultErr, beginErr = persistMutationError(ctx, tx, scope, validationErr, requestID, now)
			return beginErr
		}
		var jobStatus *domain.GuideGenerationJobStatus
		if locked.GuideGenerationJobID != nil {
			status, statusErr := tx.GenerationJobStatus(ctx, *locked.GuideGenerationJobID)
			if statusErr != nil {
				return statusErr
			}
			jobStatus = &status
		}
		if validationErr := domain.ValidateEndWithoutGuide(locked, actor, reason, jobStatus); validationErr != nil {
			resultErr, beginErr = persistMutationError(ctx, tx, scope, validationErr, requestID, now)
			return beginErr
		}
		if locked.GuideMaterialBatchID != nil {
			artifacts, cleanupErr := tx.CleanupArtifacts(ctx, *locked.GuideMaterialBatchID)
			if cleanupErr != nil {
				return cleanupErr
			}
			for _, artifact := range artifacts {
				taskID, idErr := s.newID("deletion")
				if idErr != nil {
					return idErr
				}
				if queueErr := tx.QueueArtifactDeletion(ctx, taskID, artifact, now); queueErr != nil {
					return queueErr
				}
			}
		}
		updated, updateErr := tx.EndWithoutGuide(ctx, locked.ID, reason, now)
		if updateErr != nil {
			return updateErr
		}
		if locked.GuideGenerationJobID != nil {
			if deleteErr := tx.DeleteGenerationJob(ctx, *locked.GuideGenerationJobID); deleteErr != nil {
				return deleteErr
			}
		}
		if locked.GuideMaterialBatchID != nil {
			if deleteErr := tx.DeleteGuideMaterials(ctx, *locked.GuideMaterialBatchID); deleteErr != nil {
				return deleteErr
			}
			if deleteErr := tx.DeleteGuideMaterialBatch(ctx, *locked.GuideMaterialBatchID); deleteErr != nil {
				return deleteErr
			}
		}
		if locked.GuideDraftID != nil {
			if deleteErr := tx.DeleteGuideDrafts(ctx, locked.ID); deleteErr != nil {
				return deleteErr
			}
		}
		body, marshalErr := marshalSessionResponse(updated)
		if marshalErr != nil {
			return marshalErr
		}
		if completeErr := tx.CompleteIdempotency(ctx, scope, http.StatusOK, body, now); completeErr != nil {
			return completeErr
		}
		result = updated
		event, eventErr := s.sessionEvent(now, domain.EventSupportSessionUpdated, updated)
		if eventErr != nil {
			return eventErr
		}
		events = []domain.Event{event}
		return nil
	})
	if err != nil {
		return domain.SupportSession{}, err
	}
	if resultErr != nil {
		return domain.SupportSession{}, resultErr
	}
	s.publish(ctx, events)
	return result, nil
}

func (s *SupportSessionService) CreateLiveKitToken(ctx context.Context, actor domain.Actor, rawSessionID string) (LiveKitConnection, error) {
	sessionID, err := validateActorAndID(actor, rawSessionID)
	if err != nil {
		return LiveKitConnection{}, err
	}
	session, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return LiveKitConnection{}, err
	}
	if err := sessionPair(session).Authorize(actor, domain.RoleUser, domain.RoleFamily); err != nil {
		return LiveKitConnection{}, err
	}
	if !session.Status.AllowsLiveKit() {
		return LiveKitConnection{}, domain.NewError(domain.CodeInvalidState, "通話可能な支援セッションだけがLiveKitへ接続できる")
	}
	if s.issuer == nil {
		return LiveKitConnection{}, domain.NewError(domain.CodeExternalServiceUnavailable, "LiveKitトークンを発行できない")
	}
	identity := "user:" + string(actor.ID)
	if actor.Role == domain.RoleFamily {
		identity = "family:" + string(actor.ID)
	}
	expiresAt := s.now().Add(liveKitTokenTTL)
	token, err := s.issuer.Issue(ctx, livekit.TokenRequest{RoomName: session.LiveKitRoomName, ParticipantIdentity: identity, Role: actor.Role, ExpiresAt: expiresAt})
	if err != nil {
		return LiveKitConnection{}, domain.WrapError(domain.CodeExternalServiceUnavailable, "LiveKitトークンを発行できない", err)
	}
	return LiveKitConnection{ServerURL: token.ServerURL, RoomName: session.LiveKitRoomName, ParticipantIdentity: identity, Token: token.Value, ExpiresAt: expiresAt}, nil
}

func (s *SupportSessionService) mutatePair(
	ctx context.Context, actor domain.Actor, preloaded domain.SupportSession, expectedRevision int64,
	scope domain.IdempotencyScope, hash domain.RequestHash, requestID string, now time.Time, successStatus int,
	change func(repository.SupportSessionTransaction, domain.SupportRequest, domain.SupportSession) (SupportSessionPair, error),
	requestEvent domain.EventType, sessionEvent domain.EventType,
) (SupportSessionPair, error) {
	var result SupportSessionPair
	var resultErr error
	var events []domain.Event
	err := s.store.WithinTransaction(ctx, func(tx repository.SupportSessionTransaction) error {
		request, err := tx.LockRequest(ctx, preloaded.SupportRequestID)
		if err != nil {
			return err
		}
		locked, err := tx.LockSession(ctx, preloaded.ID)
		if err != nil {
			return err
		}
		if err := sessionPair(locked).Authorize(actor, actor.Role); err != nil {
			return err
		}
		replay, err := beginSessionIdempotency(ctx, tx, scope, hash, now)
		if err != nil {
			return err
		}
		if replay != nil {
			result, resultErr = decodePairReplay(*replay, successStatus)
			return nil
		}
		if validationErr := domain.ValidateExpectedRevision(locked.Revision, expectedRevision); validationErr != nil {
			resultErr, err = persistMutationError(ctx, tx, scope, validationErr, requestID, now)
			return err
		}
		result, err = change(tx, request, locked)
		if err != nil {
			if isPersistentBusinessError(err) {
				resultErr, err = persistMutationError(ctx, tx, scope, err, requestID, now)
			}
			return err
		}
		body, err := marshalPairResponse(result.SupportRequest, result.SupportSession)
		if err != nil {
			return err
		}
		if err := tx.CompleteIdempotency(ctx, scope, successStatus, body, now); err != nil {
			return err
		}
		events, err = s.pairEvents(now, requestEvent, result.SupportRequest, sessionEvent, result.SupportSession)
		return err
	})
	if err != nil {
		return SupportSessionPair{}, err
	}
	if resultErr != nil {
		return SupportSessionPair{}, resultErr
	}
	s.publish(ctx, events)
	return result, nil
}

func (s *SupportSessionService) prepareSessionMutation(ctx context.Context, actor domain.Actor, rawID, rawKey string, payload any, roles ...domain.Role) (domain.ID, domain.IdempotencyKey, domain.SupportSession, domain.RequestHash, error) {
	if err := authorizeActorRole(actor, roles...); err != nil {
		return "", "", domain.SupportSession{}, "", err
	}
	id, err := domain.NewID(rawID)
	if err != nil {
		return "", "", domain.SupportSession{}, "", err
	}
	key, err := domain.NewIdempotencyKey(rawKey)
	if err != nil {
		return "", "", domain.SupportSession{}, "", err
	}
	session, err := s.store.GetSession(ctx, id)
	if err != nil {
		return "", "", domain.SupportSession{}, "", err
	}
	if err := sessionPair(session).Authorize(actor, roles...); err != nil {
		return "", "", domain.SupportSession{}, "", err
	}
	hash, err := domain.HashCanonicalJSON(payload)
	return id, key, session, hash, err
}

func beginSessionIdempotency(ctx context.Context, tx repository.SupportSessionTransaction, scope domain.IdempotencyScope, hash domain.RequestHash, now time.Time) (*domain.IdempotencyRecord, error) {
	created, err := tx.BeginIdempotency(ctx, scope, hash, now)
	if err != nil {
		return nil, err
	}
	if created {
		return nil, nil
	}
	record, found, err := tx.LockIdempotency(ctx, scope)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, domain.NewError(domain.CodeInternalError, "IdempotencyRecordを取得できない")
	}
	evaluation, err := EvaluateIdempotency(&record, hash, now)
	if err != nil {
		return nil, err
	}
	if evaluation.Decision == IdempotencyReplay {
		return &evaluation.Record, nil
	}
	if evaluation.Decision == IdempotencyTakeOver {
		record, taken, err := tx.TakeOverIdempotency(ctx, scope, now)
		if err != nil {
			return nil, err
		}
		if !taken {
			return nil, domain.NewError(domain.CodeIdempotencyRequestInProgress, "同じリクエストを処理中")
		}
		_ = record
		return nil, nil
	}
	return nil, domain.NewError(domain.CodeInternalError, "Idempotency判定が不正")
}

func persistMutationError(ctx context.Context, tx repository.SupportSessionTransaction, scope domain.IdempotencyScope, err error, requestID string, now time.Time) (error, error) {
	code, ok := domain.ErrorCodeOf(err)
	if !ok {
		return nil, err
	}
	var typed *domain.Error
	if value, isTyped := err.(*domain.Error); isTyped {
		typed = value
	} else {
		typed = domain.NewError(code, "操作を完了できない")
	}
	wrapped := &SupportSessionOperationError{Err: typed, RequestID: requestID}
	body, marshalErr := json.Marshal(supportSessionStoredErrorEnvelope{Error: supportSessionStoredError{Code: code, Message: typed.Message, RequestID: requestID}})
	if marshalErr != nil {
		return nil, marshalErr
	}
	if completeErr := tx.CompleteIdempotency(ctx, scope, supportSessionStatusForDomainCode(code), body, now); completeErr != nil {
		return nil, completeErr
	}
	return wrapped, nil
}

func decodePairReplay(record domain.IdempotencyRecord, successStatus int) (SupportSessionPair, error) {
	if record.ResponseStatus != nil && *record.ResponseStatus == successStatus {
		var envelope pairResponseEnvelope
		if err := json.Unmarshal(record.ResponseBody, &envelope); err != nil {
			return SupportSessionPair{}, fmt.Errorf("decode idempotency pair response: %w", err)
		}
		return SupportSessionPair{SupportRequest: envelope.Data.SupportRequest.domainValue(), SupportSession: envelope.Data.SupportSession.domainValue()}, nil
	}
	return SupportSessionPair{}, decodeStoredError(record)
}

func decodeSessionReplay(record domain.IdempotencyRecord, successStatus int) (domain.SupportSession, error) {
	if record.ResponseStatus != nil && *record.ResponseStatus == successStatus {
		var envelope sessionResponseEnvelope
		if err := json.Unmarshal(record.ResponseBody, &envelope); err != nil {
			return domain.SupportSession{}, fmt.Errorf("decode idempotency session response: %w", err)
		}
		return envelope.Data.domainValue(), nil
	}
	return domain.SupportSession{}, decodeStoredError(record)
}

func decodeStoredError(record domain.IdempotencyRecord) error {
	var envelope supportSessionStoredErrorEnvelope
	if err := json.Unmarshal(record.ResponseBody, &envelope); err != nil {
		return fmt.Errorf("decode idempotency error response: %w", err)
	}
	return &SupportSessionOperationError{Err: domain.NewError(envelope.Error.Code, envelope.Error.Message), RequestID: envelope.Error.RequestID}
}

func (s *SupportSessionService) pairEvents(now time.Time, requestType domain.EventType, request domain.SupportRequest, sessionType domain.EventType, session domain.SupportSession) ([]domain.Event, error) {
	requestData, err := json.Marshal(requestSnapshot(request))
	if err != nil {
		return nil, err
	}
	sessionData, err := json.Marshal(sessionSnapshot(session))
	if err != nil {
		return nil, err
	}
	requestEventID, err := s.newID("event")
	if err != nil {
		return nil, err
	}
	sessionEventID, err := s.newID("event")
	if err != nil {
		return nil, err
	}
	audience := requestPair(request)
	return []domain.Event{{EventID: requestEventID, Type: requestType, OccurredAt: now, EntityID: request.ID, Revision: request.Revision, Data: requestData, Audience: audience}, {EventID: sessionEventID, Type: sessionType, OccurredAt: now, EntityID: session.ID, Revision: session.Revision, Data: sessionData, Audience: audience}}, nil
}

func (s *SupportSessionService) sessionEvent(now time.Time, eventType domain.EventType, session domain.SupportSession) (domain.Event, error) {
	data, err := json.Marshal(sessionSnapshot(session))
	if err != nil {
		return domain.Event{}, err
	}
	eventID, err := s.newID("event")
	if err != nil {
		return domain.Event{}, err
	}
	return domain.Event{EventID: eventID, Type: eventType, OccurredAt: now, EntityID: session.ID, Revision: session.Revision, Data: data, Audience: sessionPair(session)}, nil
}

func (s *SupportSessionService) publish(ctx context.Context, events []domain.Event) {
	if s.publisher == nil {
		return
	}
	for _, event := range events {
		if err := s.publisher.Publish(ctx, event); err != nil {
			s.logger.WarnContext(ctx, "event delivery failed", "eventId", event.EventID, "eventType", event.Type, "entityId", event.EntityID, "revision", event.Revision)
		}
	}
}

func validateActorAndID(actor domain.Actor, rawID string) (domain.ID, error) {
	if err := actor.Validate(); err != nil {
		return "", err
	}
	return domain.NewID(rawID)
}
func validateMutation(actor domain.Actor, rawID, rawKey string, roles ...domain.Role) (domain.ID, domain.IdempotencyKey, error) {
	if err := authorizeActorRole(actor, roles...); err != nil {
		return "", "", err
	}
	id, err := domain.NewID(rawID)
	if err != nil {
		return "", "", err
	}
	key, err := domain.NewIdempotencyKey(rawKey)
	return id, key, err
}
func authorizeActorRole(actor domain.Actor, roles ...domain.Role) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	allowed := false
	for _, role := range roles {
		if actor.Role == role {
			allowed = true
			break
		}
	}
	if !allowed {
		return domain.NewError(domain.CodeForbidden, "この役割では実行できない")
	}
	return nil
}
func requestPair(value domain.SupportRequest) domain.UserPair {
	return domain.UserPair{UserID: value.UserID, FamilyID: value.FamilyID}
}
func sessionPair(value domain.SupportSession) domain.UserPair {
	return domain.UserPair{UserID: value.UserID, FamilyID: value.FamilyID}
}
func idempotencyScope(actor domain.Actor, method, path string, key domain.IdempotencyKey) domain.IdempotencyScope {
	return domain.IdempotencyScope{ActorID: actor.ID, Method: method, Path: path, Key: key}
}
func isPersistentBusinessError(err error) bool {
	code, ok := domain.ErrorCodeOf(err)
	return ok && code != domain.CodeInternalError && code != domain.CodeExternalServiceUnavailable
}
func supportSessionStatusForDomainCode(code domain.ErrorCode) int {
	switch code {
	case domain.CodeValidationError:
		return 400
	case domain.CodeUnauthenticated:
		return 401
	case domain.CodeForbidden:
		return 403
	case domain.CodeNotFound:
		return 404
	default:
		return 409
	}
}
func randomDomainID(prefix string) (domain.ID, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", domain.WrapError(domain.CodeInternalError, "IDを生成できない", err)
	}
	return domain.ID(prefix + "_" + hex.EncodeToString(bytes[:])), nil
}
