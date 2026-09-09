package handler

import (
	"context"
	"testing"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

type reviewUseCasesStub struct {
	GuideUseCases
	command service.CompleteGuideReviewCommand
	drafts  []domain.GuideDraft
	err     error
}

func (s *reviewUseCasesStub) ListSessionGuideDrafts(_ context.Context, _ domain.Actor, _ domain.ID) ([]domain.GuideDraft, error) {
	return s.drafts, s.err
}
func (s *reviewUseCasesStub) CompleteGuideReview(_ context.Context, command service.CompleteGuideReviewCommand) (service.GuideReviewCompleted, error) {
	s.command = command
	return service.GuideReviewCompleted{
		Guides:         []domain.GuideDetail{{Guide: domain.Guide{ID: "guide_1"}}, {Guide: domain.Guide{ID: "guide_2"}}},
		SupportSession: domain.SupportSession{ID: command.SupportSessionID, Status: domain.SupportSessionEnded, Revision: 7},
	}, s.err
}

func TestGuideReviewHandlerPreservesGroupAndRevisionContract(t *testing.T) {
	stub := &reviewUseCasesStub{drafts: []domain.GuideDraft{{ID: "draft_1", Revision: 2}, {ID: "draft_2", Revision: 3}}}
	handler := NewGuideHandler(stub)
	ctx := context.WithValue(guideHandlerContext(), actorContextKey, domain.Actor{ID: "family_demo", Role: domain.RoleFamily})
	listed, err := handler.ListSessionGuideDrafts(ctx, generated.ListSessionGuideDraftsRequestObject{Id: "session_1"})
	if err != nil {
		t.Fatal(err)
	}
	items := listed.(generated.ListSessionGuideDrafts200JSONResponse).Data.Items
	if len(items) != 2 || items[1].Id != "draft_2" || items[1].Revision != 3 {
		t.Fatalf("items=%+v", items)
	}
	body := generated.CompleteGuideReviewJSONRequestBody{ExpectedSessionRevision: 6, Drafts: []generated.GuideDraftRevision{{Id: "draft_1", ExpectedRevision: 2}, {Id: "draft_2", ExpectedRevision: 3}}}
	response, err := handler.CompleteGuideReview(ctx, generated.CompleteGuideReviewRequestObject{Id: "session_1", Params: generated.CompleteGuideReviewParams{IdempotencyKey: "group-key"}, Body: &body})
	if err != nil {
		t.Fatal(err)
	}
	data := response.(generated.CompleteGuideReview201JSONResponse).Data
	if len(data.Guides) != 2 || data.Guides[1].Id != "guide_2" || data.SupportSession.Revision != 7 {
		t.Fatalf("response=%+v", data)
	}
	if stub.command.Meta.Key != "group-key" || stub.command.Meta.Actor.ID != "family_demo" || stub.command.SupportSessionID != "session_1" || stub.command.ExpectedSessionRevision != 6 || len(stub.command.Drafts) != 2 || stub.command.Drafts[1].ExpectedRevision != 3 {
		t.Fatalf("command=%+v", stub.command)
	}

	stub.err = domain.NewError(domain.CodeRevisionConflict, "conflict")
	response, err = handler.CompleteGuideReview(ctx, generated.CompleteGuideReviewRequestObject{Id: "session_1", Params: generated.CompleteGuideReviewParams{IdempotencyKey: "group-key"}, Body: &body})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(generated.CompleteGuideReview409JSONResponse); !ok {
		t.Fatalf("conflict response=%T", response)
	}
}
