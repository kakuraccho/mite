package service

import (
	"encoding/json"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type supportRequestSnapshot struct {
	AcknowledgedAt              *time.Time            `json:"acknowledgedAt"`
	AcknowledgementKind         *string               `json:"acknowledgementKind"`
	Comment                     string                `json:"comment"`
	CreatedAt                   time.Time             `json:"createdAt"`
	FamilyID                    string                `json:"familyId"`
	GuideContext                *guideContextSnapshot `json:"guideContext"`
	ID                          string                `json:"id"`
	InitialScreenshotArtifactID string                `json:"initialScreenshotArtifactId"`
	Revision                    int64                 `json:"revision"`
	Status                      string                `json:"status"`
	SupportSessionID            *string               `json:"supportSessionId"`
	UpdatedAt                   time.Time             `json:"updatedAt"`
	EstimatedSupportAt          *time.Time            `json:"estimatedSupportAt"`
	UserID                      string                `json:"userId"`
}

type guideContextSnapshot struct {
	GuideID            string `json:"guideId"`
	GuideRunID         string `json:"guideRunId"`
	GuideTitle         string `json:"guideTitle"`
	GuideVersionNumber int    `json:"guideVersionNumber"`
	StepArtifactID     string `json:"stepArtifactId"`
	StepInstruction    string `json:"stepInstruction"`
	StepNumber         int    `json:"stepNumber"`
}

type supportSessionSnapshot struct {
	Consent              *consentSnapshot `json:"consent"`
	ConsentedAt          *time.Time       `json:"consentedAt"`
	CreatedAt            time.Time        `json:"createdAt"`
	EndReason            *string          `json:"endReason"`
	EndedAt              *time.Time       `json:"endedAt"`
	FamilyID             string           `json:"familyId"`
	GuideDecision        *string          `json:"guideDecision"`
	GuideDraftID         *string          `json:"guideDraftId"`
	GuideGenerationJobID *string          `json:"guideGenerationJobId"`
	GuideID              *string          `json:"guideId"`
	GuideMaterialBatchID *string          `json:"guideMaterialBatchId"`
	ID                   string           `json:"id"`
	LiveKitRoomName      string           `json:"livekitRoomName"`
	Revision             int64            `json:"revision"`
	StartedAt            *time.Time       `json:"startedAt"`
	Status               string           `json:"status"`
	SupportRequestID     string           `json:"supportRequestId"`
	UpdatedAt            time.Time        `json:"updatedAt"`
	UserID               string           `json:"userId"`
}

type consentSnapshot struct {
	Audio           bool   `json:"audio"`
	PeriodicCapture bool   `json:"periodicCapture"`
	ScreenShare     bool   `json:"screenShare"`
	TextVersion     string `json:"textVersion"`
}

type pairResponseEnvelope struct {
	Data struct {
		SupportRequest supportRequestSnapshot `json:"supportRequest"`
		SupportSession supportSessionSnapshot `json:"supportSession"`
	} `json:"data"`
}

type sessionResponseEnvelope struct {
	Data supportSessionSnapshot `json:"data"`
}

type supportSessionStoredErrorEnvelope struct {
	Error supportSessionStoredError `json:"error"`
}

type supportSessionStoredError struct {
	Code      domain.ErrorCode `json:"code"`
	Message   string           `json:"message"`
	RequestID string           `json:"requestId"`
}

func requestSnapshot(value domain.SupportRequest) supportRequestSnapshot {
	result := supportRequestSnapshot{
		Comment: value.Comment, CreatedAt: value.CreatedAt, FamilyID: string(value.FamilyID), ID: string(value.ID),
		InitialScreenshotArtifactID: string(value.InitialScreenshotArtifactID), Revision: value.Revision,
		Status: string(value.Status), SupportSessionID: idStringPointer(value.SupportSessionID), UpdatedAt: value.UpdatedAt, UserID: string(value.UserID),
		AcknowledgedAt: value.AcknowledgedAt, AcknowledgementKind: acknowledgementKindStringPointer(value.AcknowledgementKind), EstimatedSupportAt: value.EstimatedSupportAt,
	}
	if value.GuideContext != nil {
		result.GuideContext = &guideContextSnapshot{
			GuideID: string(value.GuideContext.GuideID), GuideRunID: string(value.GuideContext.GuideRunID), GuideTitle: value.GuideContext.GuideTitle,
			GuideVersionNumber: value.GuideContext.GuideVersionNumber, StepArtifactID: string(value.GuideContext.StepArtifactID),
			StepInstruction: value.GuideContext.StepInstruction, StepNumber: value.GuideContext.StepNumber,
		}
	}
	return result
}

func sessionSnapshot(value domain.SupportSession) supportSessionSnapshot {
	result := supportSessionSnapshot{
		ConsentedAt: value.ConsentedAt, CreatedAt: value.CreatedAt, EndReason: endReasonStringPointer(value.EndReason), EndedAt: value.EndedAt,
		FamilyID: string(value.FamilyID), GuideDecision: guideDecisionStringPointer(value.GuideDecision), GuideDraftID: idStringPointer(value.GuideDraftID),
		GuideGenerationJobID: idStringPointer(value.GuideGenerationJobID), GuideID: idStringPointer(value.GuideID),
		GuideMaterialBatchID: idStringPointer(value.GuideMaterialBatchID), ID: string(value.ID), LiveKitRoomName: value.LiveKitRoomName,
		Revision: value.Revision, StartedAt: value.StartedAt, Status: string(value.Status), SupportRequestID: string(value.SupportRequestID),
		UpdatedAt: value.UpdatedAt, UserID: string(value.UserID),
	}
	if value.Consent != nil {
		result.Consent = &consentSnapshot{Audio: value.Consent.Audio, PeriodicCapture: value.Consent.PeriodicCapture, ScreenShare: value.Consent.ScreenShare, TextVersion: value.Consent.TextVersion}
	}
	return result
}

func pairEnvelope(request domain.SupportRequest, session domain.SupportSession) pairResponseEnvelope {
	var result pairResponseEnvelope
	result.Data.SupportRequest = requestSnapshot(request)
	result.Data.SupportSession = sessionSnapshot(session)
	return result
}

func sessionEnvelope(session domain.SupportSession) sessionResponseEnvelope {
	return sessionResponseEnvelope{Data: sessionSnapshot(session)}
}

func (value supportRequestSnapshot) domainValue() domain.SupportRequest {
	result := domain.SupportRequest{ID: domain.ID(value.ID), UserID: domain.ID(value.UserID), FamilyID: domain.ID(value.FamilyID), InitialScreenshotArtifactID: domain.ID(value.InitialScreenshotArtifactID), Comment: value.Comment, Status: domain.SupportRequestStatus(value.Status), SupportSessionID: stringIDPointer(value.SupportSessionID), AcknowledgedAt: value.AcknowledgedAt, AcknowledgementKind: stringAcknowledgementKindPointer(value.AcknowledgementKind), EstimatedSupportAt: value.EstimatedSupportAt, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision}
	if value.GuideContext != nil {
		result.GuideContext = &domain.GuideContext{GuideRunID: domain.ID(value.GuideContext.GuideRunID), GuideID: domain.ID(value.GuideContext.GuideID), GuideVersionNumber: value.GuideContext.GuideVersionNumber, StepNumber: value.GuideContext.StepNumber, GuideTitle: value.GuideContext.GuideTitle, StepInstruction: value.GuideContext.StepInstruction, StepArtifactID: domain.ID(value.GuideContext.StepArtifactID)}
	}
	return result
}

func (value supportSessionSnapshot) domainValue() domain.SupportSession {
	result := domain.SupportSession{ID: domain.ID(value.ID), SupportRequestID: domain.ID(value.SupportRequestID), UserID: domain.ID(value.UserID), FamilyID: domain.ID(value.FamilyID), LiveKitRoomName: value.LiveKitRoomName, Status: domain.SupportSessionStatus(value.Status), GuideDecision: stringGuideDecisionPointer(value.GuideDecision), GuideMaterialBatchID: stringIDPointer(value.GuideMaterialBatchID), GuideGenerationJobID: stringIDPointer(value.GuideGenerationJobID), GuideDraftID: stringIDPointer(value.GuideDraftID), GuideID: stringIDPointer(value.GuideID), ConsentedAt: value.ConsentedAt, StartedAt: value.StartedAt, EndedAt: value.EndedAt, EndReason: stringEndReasonPointer(value.EndReason), CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision}
	if value.Consent != nil {
		result.Consent = &domain.Consent{Audio: value.Consent.Audio, ScreenShare: value.Consent.ScreenShare, PeriodicCapture: value.Consent.PeriodicCapture, TextVersion: value.Consent.TextVersion}
	}
	return result
}

func marshalPairResponse(request domain.SupportRequest, session domain.SupportSession) (json.RawMessage, error) {
	return json.Marshal(pairEnvelope(request, session))
}
func marshalSessionResponse(session domain.SupportSession) (json.RawMessage, error) {
	return json.Marshal(sessionEnvelope(session))
}

func idStringPointer(value *domain.ID) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}
func stringIDPointer(value *string) *domain.ID {
	if value == nil {
		return nil
	}
	converted := domain.ID(*value)
	return &converted
}
func acknowledgementKindStringPointer(value *domain.SupportAcknowledgementKind) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}
func stringAcknowledgementKindPointer(value *string) *domain.SupportAcknowledgementKind {
	if value == nil {
		return nil
	}
	converted := domain.SupportAcknowledgementKind(*value)
	return &converted
}
func guideDecisionStringPointer(value *domain.GuideDecision) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}
func stringGuideDecisionPointer(value *string) *domain.GuideDecision {
	if value == nil {
		return nil
	}
	converted := domain.GuideDecision(*value)
	return &converted
}
func endReasonStringPointer(value *domain.SupportSessionEndReason) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}
func stringEndReasonPointer(value *string) *domain.SupportSessionEndReason {
	if value == nil {
		return nil
	}
	converted := domain.SupportSessionEndReason(*value)
	return &converted
}
