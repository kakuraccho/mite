package service

import (
	"context"
	"net/http"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

// End closes the call after a saved guide has been tried together. Guide
// persistence and material cleanup already completed in SaveGuideDraft.
func (s *SupportSessionService) End(
	ctx context.Context, actor domain.Actor, rawSessionID string, expectedRevision int64,
	rawKey, requestID string,
) (domain.SupportSession, error) {
	if err := authorizeActorRole(actor, domain.RoleFamily); err != nil {
		return domain.SupportSession{}, err
	}
	if expectedRevision < 1 {
		return domain.SupportSession{}, domain.NewError(domain.CodeValidationError, "expectedSessionRevisionは1以上で指定する")
	}
	payload := struct {
		ExpectedSessionRevision int64 `json:"expectedSessionRevision"`
	}{expectedRevision}
	id, key, session, hash, err := s.prepareSessionMutation(ctx, actor, rawSessionID, rawKey, payload, domain.RoleFamily)
	if err != nil {
		return domain.SupportSession{}, err
	}
	now := s.now()
	scope := idempotencyScope(actor, http.MethodPost, "/v1/support-sessions/"+string(id)+"/end", key)
	var result domain.SupportSession
	var resultErr error
	var events []domain.Event
	err = s.store.WithinTransaction(ctx, func(tx repository.SupportSessionTransaction) error {
		if _, err := tx.LockRequest(ctx, session.SupportRequestID); err != nil {
			return err
		}
		locked, err := tx.LockSession(ctx, id)
		if err != nil {
			return err
		}
		if err := sessionPair(locked).Authorize(actor, domain.RoleFamily); err != nil {
			return err
		}
		replay, err := beginSessionIdempotency(ctx, tx, scope, hash, now)
		if err != nil {
			return err
		}
		if replay != nil {
			result, resultErr = decodeSessionReplay(*replay, http.StatusOK)
			return nil
		}
		if validationErr := domain.ValidateExpectedRevision(locked.Revision, expectedRevision); validationErr != nil {
			resultErr, err = persistMutationError(ctx, tx, scope, validationErr, requestID, now)
			return err
		}
		if validationErr := domain.ValidateEndSavedSupportSession(locked); validationErr != nil {
			resultErr, err = persistMutationError(ctx, tx, scope, validationErr, requestID, now)
			return err
		}
		result, err = tx.EndSavedGuide(ctx, id, now)
		if err != nil {
			return err
		}
		body, err := marshalSessionResponse(result)
		if err != nil {
			return err
		}
		if err := tx.CompleteIdempotency(ctx, scope, http.StatusOK, body, now); err != nil {
			return err
		}
		event, err := s.sessionEvent(now, domain.EventSupportSessionUpdated, result)
		if err != nil {
			return err
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
