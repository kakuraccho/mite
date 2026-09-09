package service

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

type GuideDraftRevision struct {
	ID               domain.ID `json:"id"`
	ExpectedRevision int64     `json:"expectedRevision"`
}

type CompleteGuideReviewCommand struct {
	Meta                    CommandMeta
	SupportSessionID        domain.ID
	ExpectedSessionRevision int64
	Drafts                  []GuideDraftRevision
}

type GuideReviewCompleted struct {
	Guides         []domain.GuideDetail  `json:"guides"`
	SupportSession domain.SupportSession `json:"supportSession"`
}

func (s *GuideService) ListSessionGuideDrafts(ctx context.Context, actor domain.Actor, sessionID domain.ID) ([]domain.GuideDraft, error) {
	var result []domain.GuideDraft
	err := s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		session, err := tx.GetSession(ctx, sessionID, false)
		if err != nil {
			return err
		}
		if err := pairForSession(session).Authorize(actor, domain.RoleUser, domain.RoleFamily); err != nil {
			return err
		}
		result, err = tx.ListDrafts(ctx, sessionID, false)
		return err
	})
	return result, translateRepositoryErrorOrNil(err)
}

func (s *GuideService) CompleteGuideReview(ctx context.Context, command CompleteGuideReviewCommand) (GuideReviewCompleted, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleFamily); err != nil {
		return GuideReviewCompleted{}, err
	}
	if command.ExpectedSessionRevision < 1 || len(command.Drafts) == 0 {
		return GuideReviewCompleted{}, domain.NewError(domain.CodeValidationError, "支援のrevisionと全下書きが必要")
	}
	revisions := make(map[domain.ID]int64, len(command.Drafts))
	for _, draft := range command.Drafts {
		if _, err := domain.NewID(string(draft.ID)); err != nil {
			return GuideReviewCompleted{}, err
		}
		if draft.ExpectedRevision < 1 || revisions[draft.ID] != 0 {
			return GuideReviewCompleted{}, domain.NewError(domain.CodeValidationError, "下書きのrevisionまたはIDが不正")
		}
		revisions[draft.ID] = draft.ExpectedRevision
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedSessionRevision int64                `json:"expectedSessionRevision"`
		Drafts                  []GuideDraftRevision `json:"drafts"`
	}{command.ExpectedSessionRevision, command.Drafts})
	if err != nil {
		return GuideReviewCompleted{}, err
	}
	result := storedEnvelope[GuideReviewCompleted]{}
	path := "/v1/support-sessions/" + string(command.SupportSessionID) + "/complete-guide-review"
	_, events, err := s.idempotent(ctx, command.Meta, path, hash, 201, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		session, err := tx.GetSession(ctx, command.SupportSessionID, true)
		if err != nil {
			return nil, err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleFamily); err != nil {
			return nil, err
		}
		if err := checkRevision(session.Revision, command.ExpectedSessionRevision); err != nil {
			return nil, err
		}
		if session.Status != domain.SupportSessionReviewingGuide || session.GuideMaterialBatchID == nil || session.GuideGenerationJobID == nil {
			return nil, domain.NewError(domain.CodeInvalidState, "レビューを完了できない")
		}
		if _, err := tx.GetBatch(ctx, *session.GuideMaterialBatchID, true); err != nil {
			return nil, err
		}
		if _, err := tx.GetJob(ctx, *session.GuideGenerationJobID, true); err != nil {
			return nil, err
		}
		drafts, err := tx.ListDrafts(ctx, session.ID, true)
		if err != nil {
			return nil, err
		}
		if len(drafts) != len(revisions) {
			return nil, domain.NewError(domain.CodeInvalidState, "すべての下書きを指定する")
		}
		for _, draft := range drafts {
			revision, exists := revisions[draft.ID]
			if !exists || draft.SupportSessionID != session.ID || draft.Status != domain.GuideDraftEditing {
				return nil, domain.NewError(domain.CodeInvalidState, "すべての編集中の下書きを指定する")
			}
			if err := checkRevision(draft.Revision, revision); err != nil {
				return nil, err
			}
		}
		reviewed, events, err := s.persistReviewedDrafts(ctx, tx, command.Meta.Actor, session, drafts)
		result.Data = reviewed
		return events, err
	})
	if err != nil {
		return GuideReviewCompleted{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}

// The caller locks the session, batch, job and complete draft set before entering.
// Validation, all guide writes and cleanup share the caller's transaction.
func (s *GuideService) persistReviewedDrafts(ctx context.Context, tx repository.GuideTx, actor domain.Actor, session domain.SupportSession, drafts []domain.GuideDraft) (GuideReviewCompleted, []domain.Event, error) {
	fail := func(err error) (GuideReviewCompleted, []domain.Event, error) { return GuideReviewCompleted{}, nil, err }
	allowed, err := tx.ListAllowedDraftArtifacts(ctx, session.ID)
	if err != nil {
		return fail(err)
	}
	for _, draft := range drafts {
		if err := domain.ValidateGuideDraftContent(draft.Title, draft.Steps, allowed); err != nil {
			return fail(err)
		}
	}
	now := s.now()
	result := GuideReviewCompleted{Guides: make([]domain.GuideDetail, 0, len(drafts))}
	var events []domain.Event
	var used []domain.ID
	seen := make(map[domain.ID]struct{})
	pair := pairForSession(session)
	for _, draft := range drafts {
		guide, err := tx.CreateGuide(ctx, domain.Guide{ID: s.newID("guide_"), UserID: session.UserID, Title: draft.Title, CurrentVersionNumber: 1, CreatedAt: now, UpdatedAt: now, Revision: 1})
		if err != nil {
			return fail(err)
		}
		version := domain.GuideVersion{GuideID: guide.ID, VersionNumber: 1, Title: guide.Title, CreatedBy: actor.ID, CreatedAt: now, Steps: append([]domain.GuideStep(nil), draft.Steps...)}
		if _, err := tx.CreateGuideVersion(ctx, version); err != nil {
			return fail(err)
		}
		for _, step := range draft.Steps {
			if _, err := tx.CreateGuideVersionStep(ctx, guide.ID, step); err != nil {
				return fail(err)
			}
			if _, exists := seen[step.ArtifactID]; !exists {
				seen[step.ArtifactID] = struct{}{}
				used = append(used, step.ArtifactID)
				if err := tx.PromoteArtifact(ctx, step.ArtifactID, timestamp(now)); err != nil {
					return fail(err)
				}
			}
		}
		saved, err := tx.SaveDraft(ctx, draft.ID, guide.ID, timestamp(now))
		if err != nil {
			return fail(err)
		}
		detail := domain.GuideDetail{Guide: guide, RepresentativeArtifactID: draft.Steps[0].ArtifactID, CurrentVersion: version}
		result.Guides = append(result.Guides, detail)
		events = append(events, s.event(domain.EventGuideDraftUpdated, saved.ID, saved.Revision, saved, pair), s.event(domain.EventGuideCreated, guide.ID, guide.Revision, detail, pair))
	}
	unused, err := tx.ListUnusedArtifacts(ctx, session.ID, used)
	if err != nil {
		return fail(err)
	}
	for _, artifact := range unused {
		id := artifact.ID
		if err := tx.CreateDeletionTask(ctx, domain.ArtifactDeletionTask{ID: s.newID("delete_"), ArtifactID: &id, StorageKey: artifact.StorageKey, Status: domain.ArtifactDeletionPending, NextAttemptAt: now, CreatedAt: now}); err != nil {
			return fail(err)
		}
	}
	ended, err := tx.FinishGuideSession(ctx, session.ID, result.Guides[0].Guide.ID, timestamp(now))
	if err != nil {
		return fail(err)
	}
	if err := tx.DeleteGenerationJob(ctx, *session.GuideGenerationJobID); err != nil {
		return fail(err)
	}
	if err := tx.DeleteMaterials(ctx, *session.GuideMaterialBatchID); err != nil {
		return fail(err)
	}
	if err := tx.DeleteBatch(ctx, *session.GuideMaterialBatchID); err != nil {
		return fail(err)
	}
	result.SupportSession = ended
	events = append(events, s.event(domain.EventSupportSessionUpdated, ended.ID, ended.Revision, ended, pair))
	return result, events, nil
}
