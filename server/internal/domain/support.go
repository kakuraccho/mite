package domain

import "time"

type GuideContext struct {
	GuideRunID         ID
	GuideID            ID
	GuideVersionNumber int
	StepNumber         int
	GuideTitle         string
	StepInstruction    string
	StepArtifactID     ID
}

type SupportRequest struct {
	ID                          ID
	UserID                      ID
	FamilyID                    ID
	InitialScreenshotArtifactID ID
	Comment                     string
	Status                      SupportRequestStatus
	SupportSessionID            *ID
	GuideContext                *GuideContext
	CreatedAt                   time.Time
	UpdatedAt                   time.Time
	Revision                    int64
}

type Consent struct {
	Audio           bool
	ScreenShare     bool
	PeriodicCapture bool
	TextVersion     string
}

func (c Consent) Accepted() bool {
	return c.Audio && c.ScreenShare && c.PeriodicCapture && c.TextVersion == "v1"
}

type SupportSession struct {
	ID                   ID
	SupportRequestID     ID
	UserID               ID
	FamilyID             ID
	LiveKitRoomName      string
	Status               SupportSessionStatus
	GuideDecision        *GuideDecision
	GuideMaterialBatchID *ID
	GuideGenerationJobID *ID
	GuideDraftID         *ID
	GuideID              *ID
	Consent              *Consent
	ConsentedAt          *time.Time
	StartedAt            *time.Time
	EndedAt              *time.Time
	EndReason            *SupportSessionEndReason
	CreatedAt            time.Time
	UpdatedAt            time.Time
	Revision             int64
}
