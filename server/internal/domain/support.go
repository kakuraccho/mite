package domain

import "time"

type GuideContext struct {
	GuideRunID         ID     `json:"guideRunId"`
	GuideID            ID     `json:"guideId"`
	GuideVersionNumber int    `json:"guideVersionNumber"`
	StepNumber         int    `json:"stepNumber"`
	GuideTitle         string `json:"guideTitle"`
	StepInstruction    string `json:"stepInstruction"`
	StepArtifactID     ID     `json:"stepArtifactId"`
}

type SupportRequest struct {
	ID                          ID                   `json:"id"`
	UserID                      ID                   `json:"userId"`
	FamilyID                    ID                   `json:"familyId"`
	InitialScreenshotArtifactID ID                   `json:"initialScreenshotArtifactId"`
	Comment                     string               `json:"comment"`
	Status                      SupportRequestStatus `json:"status"`
	SupportSessionID            *ID                  `json:"supportSessionId"`
	GuideContext                *GuideContext        `json:"guideContext"`
	CreatedAt                   time.Time            `json:"createdAt"`
	UpdatedAt                   time.Time            `json:"updatedAt"`
	Revision                    int64                `json:"revision"`
}

type Consent struct {
	Audio           bool   `json:"audio"`
	ScreenShare     bool   `json:"screenShare"`
	PeriodicCapture bool   `json:"periodicCapture"`
	TextVersion     string `json:"textVersion"`
}

func (c Consent) Accepted() bool {
	return c.Audio && c.ScreenShare && c.PeriodicCapture && c.TextVersion == "v1"
}

type SupportSession struct {
	ID                   ID                       `json:"id"`
	SupportRequestID     ID                       `json:"supportRequestId"`
	UserID               ID                       `json:"userId"`
	FamilyID             ID                       `json:"familyId"`
	LiveKitRoomName      string                   `json:"livekitRoomName"`
	Status               SupportSessionStatus     `json:"status"`
	GuideDecision        *GuideDecision           `json:"guideDecision"`
	GuideMaterialBatchID *ID                      `json:"guideMaterialBatchId"`
	GuideGenerationJobID *ID                      `json:"guideGenerationJobId"`
	GuideDraftID         *ID                      `json:"guideDraftId"`
	GuideID              *ID                      `json:"guideId"`
	Consent              *Consent                 `json:"consent"`
	ConsentedAt          *time.Time               `json:"consentedAt"`
	StartedAt            *time.Time               `json:"startedAt"`
	EndedAt              *time.Time               `json:"endedAt"`
	EndReason            *SupportSessionEndReason `json:"endReason"`
	CreatedAt            time.Time                `json:"createdAt"`
	UpdatedAt            time.Time                `json:"updatedAt"`
	Revision             int64                    `json:"revision"`
}
