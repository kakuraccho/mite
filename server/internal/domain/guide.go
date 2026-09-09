package domain

import (
	"encoding/json"
	"time"
)

const (
	CaptureIntervalSeconds = 10
	MaxGuideMaterials      = 360
	MaxGuideSteps          = 8
	MaxAIInputMaterials    = 30
	MaxAIInputImageBytes   = 2 * 1024 * 1024
	MaxAIRequestBytes      = 90 * 1024 * 1024
	MaxGuideJobAttempts    = 3
)

type GuideMaterialBatch struct {
	ID                     ID                       `json:"id"`
	SupportSessionID       ID                       `json:"supportSessionId"`
	Status                 GuideMaterialBatchStatus `json:"status"`
	CaptureIntervalSeconds int                      `json:"captureIntervalSeconds"`
	ExpectedItemCount      int                      `json:"expectedItemCount"`
	ReceivedItemCount      int                      `json:"receivedItemCount"`
	CapturedFrom           time.Time                `json:"capturedFrom"`
	CapturedTo             time.Time                `json:"capturedTo"`
	CompletedAt            *time.Time               `json:"completedAt"`
	CreatedAt              time.Time                `json:"createdAt"`
	UpdatedAt              time.Time                `json:"updatedAt"`
	Revision               int64                    `json:"revision"`
}

type GuideMaterial struct {
	ID              ID        `json:"id"`
	BatchID         ID        `json:"batchId"`
	ClientCaptureID string    `json:"clientCaptureId"`
	ArtifactID      ID        `json:"artifactId"`
	Sequence        int       `json:"sequence"`
	CapturedAt      time.Time `json:"capturedAt"`
	CreatedAt       time.Time `json:"createdAt"`
}

type GuideGenerationErrorCode string

const (
	GuideGenerationAITimeout            GuideGenerationErrorCode = "AI_TIMEOUT"
	GuideGenerationAIUnavailable        GuideGenerationErrorCode = "AI_UNAVAILABLE"
	GuideGenerationAIRefusal            GuideGenerationErrorCode = "AI_REFUSAL"
	GuideGenerationAIIncompleteResponse GuideGenerationErrorCode = "AI_INCOMPLETE_RESPONSE"
	GuideGenerationAIInvalidOutput      GuideGenerationErrorCode = "AI_INVALID_OUTPUT"
	GuideGenerationAIInputUnavailable   GuideGenerationErrorCode = "AI_INPUT_UNAVAILABLE"
	GuideGenerationWorkerRestarted      GuideGenerationErrorCode = "WORKER_RESTARTED"
)

func (c GuideGenerationErrorCode) Valid() bool {
	switch c {
	case GuideGenerationAITimeout,
		GuideGenerationAIUnavailable,
		GuideGenerationAIRefusal,
		GuideGenerationAIIncompleteResponse,
		GuideGenerationAIInvalidOutput,
		GuideGenerationAIInputUnavailable,
		GuideGenerationWorkerRestarted:
		return true
	default:
		return false
	}
}

type GuideGenerationJob struct {
	ID           ID                        `json:"id"`
	BatchID      ID                        `json:"batchId"`
	Status       GuideGenerationJobStatus  `json:"status"`
	Attempt      int                       `json:"attempt"`
	GuideDraftID *ID                       `json:"guideDraftId"`
	ErrorCode    *GuideGenerationErrorCode `json:"errorCode"`
	CreatedAt    time.Time                 `json:"createdAt"`
	StartedAt    *time.Time                `json:"startedAt"`
	FinishedAt   *time.Time                `json:"finishedAt"`
	UpdatedAt    time.Time                 `json:"updatedAt"`
	Revision     int64                     `json:"revision"`
}

type GuideStep struct {
	Position    int    `json:"position"`
	ArtifactID  ID     `json:"artifactId"`
	Instruction string `json:"instruction"`
}

type GuideDraft struct {
	Position         int              `json:"-"`
	ID               ID               `json:"id"`
	SupportSessionID ID               `json:"supportSessionId"`
	Title            string           `json:"title"`
	Steps            []GuideStep      `json:"steps"`
	Status           GuideDraftStatus `json:"status"`
	Revision         int64            `json:"revision"`
	CreatedAt        time.Time        `json:"createdAt"`
	UpdatedAt        time.Time        `json:"updatedAt"`
}

type Guide struct {
	ID                   ID        `json:"id"`
	UserID               ID        `json:"userId"`
	Title                string    `json:"title"`
	CurrentVersionNumber int       `json:"currentVersionNumber"`
	CreatedAt            time.Time `json:"createdAt"`
	UpdatedAt            time.Time `json:"updatedAt"`
	Revision             int64     `json:"revision"`
}

type GuideVersion struct {
	GuideID       ID          `json:"-"`
	VersionNumber int         `json:"versionNumber"`
	Title         string      `json:"title"`
	CreatedBy     ID          `json:"createdBy"`
	CreatedAt     time.Time   `json:"createdAt"`
	Steps         []GuideStep `json:"steps"`
}

type GuideSummary struct {
	ID                       ID        `json:"id"`
	Title                    string    `json:"title"`
	CurrentVersionNumber     int       `json:"currentVersionNumber"`
	RepresentativeArtifactID ID        `json:"representativeArtifactId"`
	UpdatedAt                time.Time `json:"updatedAt"`
}

type GuideDetail struct {
	Guide                    Guide        `json:"-"`
	RepresentativeArtifactID ID           `json:"representativeArtifactId"`
	CurrentVersion           GuideVersion `json:"currentVersion"`
}

func (detail GuideDetail) MarshalJSON() ([]byte, error) {
	type wire struct {
		ID                       ID           `json:"id"`
		UserID                   ID           `json:"userId"`
		Title                    string       `json:"title"`
		CurrentVersionNumber     int          `json:"currentVersionNumber"`
		Revision                 int64        `json:"revision"`
		CreatedAt                time.Time    `json:"createdAt"`
		UpdatedAt                time.Time    `json:"updatedAt"`
		RepresentativeArtifactID ID           `json:"representativeArtifactId"`
		CurrentVersion           GuideVersion `json:"currentVersion"`
	}
	return json.Marshal(wire{
		ID: detail.Guide.ID, UserID: detail.Guide.UserID, Title: detail.Guide.Title,
		CurrentVersionNumber: detail.Guide.CurrentVersionNumber, Revision: detail.Guide.Revision,
		CreatedAt: detail.Guide.CreatedAt, UpdatedAt: detail.Guide.UpdatedAt,
		RepresentativeArtifactID: detail.RepresentativeArtifactID, CurrentVersion: detail.CurrentVersion,
	})
}

func (detail *GuideDetail) UnmarshalJSON(data []byte) error {
	type wire struct {
		ID                       ID           `json:"id"`
		UserID                   ID           `json:"userId"`
		Title                    string       `json:"title"`
		CurrentVersionNumber     int          `json:"currentVersionNumber"`
		Revision                 int64        `json:"revision"`
		CreatedAt                time.Time    `json:"createdAt"`
		UpdatedAt                time.Time    `json:"updatedAt"`
		RepresentativeArtifactID ID           `json:"representativeArtifactId"`
		CurrentVersion           GuideVersion `json:"currentVersion"`
	}
	var value wire
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	detail.Guide = Guide{ID: value.ID, UserID: value.UserID, Title: value.Title, CurrentVersionNumber: value.CurrentVersionNumber, Revision: value.Revision, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
	detail.RepresentativeArtifactID = value.RepresentativeArtifactID
	detail.CurrentVersion = value.CurrentVersion
	detail.CurrentVersion.GuideID = value.ID
	return nil
}

type GuideRun struct {
	ID                 ID             `json:"id"`
	GuideID            ID             `json:"guideId"`
	GuideVersionNumber int            `json:"guideVersionNumber"`
	UserID             ID             `json:"userId"`
	Status             GuideRunStatus `json:"status"`
	CurrentStepNumber  int            `json:"currentStepNumber"`
	SupportRequestID   *ID            `json:"supportRequestId"`
	StartedAt          time.Time      `json:"startedAt"`
	CompletedAt        *time.Time     `json:"completedAt"`
	PausedAt           *time.Time     `json:"pausedAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
	Revision           int64          `json:"revision"`
}

func MoveGuideStep(current, total int, action GuideRunAction) (int, error) {
	if total < 1 || total > MaxGuideSteps || current < 1 || current > total || !action.Valid() {
		return 0, NewError(CodeValidationError, "ガイドのステップ指定が不正")
	}
	next := current
	if action == GuideRunNext {
		next++
	} else {
		next--
	}
	if next < 1 || next > total {
		return 0, NewError(CodeValidationError, "ガイドの範囲外へ移動できない")
	}
	return next, nil
}

func CanCompleteGuideRun(current, total int) bool {
	return total >= 1 && total <= MaxGuideSteps && current == total
}

type GuideGenerationInputImage struct {
	Kind       ArtifactPurpose
	ArtifactID ID
	CapturedAt time.Time
	Sequence   int
	JPEG       []byte
}

type GuideGenerationInput struct {
	Comment string
	Images  []GuideGenerationInputImage
}

type GeneratedGuideStep struct {
	SourceArtifactID ID     `json:"sourceArtifactId"`
	Instruction      string `json:"instruction"`
}

type GeneratedGuide struct {
	Title string               `json:"title"`
	Steps []GeneratedGuideStep `json:"steps"`
}

func ValidateGuideDraftContent(title string, steps []GuideStep, allowedArtifacts map[ID]struct{}) error {
	if err := ValidateText(title, 1, 40, true); err != nil {
		return err
	}
	if len(steps) < 1 || len(steps) > MaxGuideSteps {
		return NewError(CodeValidationError, "ガイドの手順数は1〜8件で指定する")
	}
	for index, step := range steps {
		if step.Position != index+1 {
			return NewError(CodeValidationError, "ガイドの手順番号は1からの連番にする")
		}
		if err := ValidateText(step.Instruction, 1, 120, true); err != nil {
			return err
		}
		if _, ok := allowedArtifacts[step.ArtifactID]; !ok {
			return NewError(CodeValidationError, "ガイドで利用できない画像が指定されている")
		}
	}
	return nil
}

func ValidateGeneratedGuides(outputs []GeneratedGuide, allowedArtifacts map[ID]struct{}) error {
	if len(outputs) == 0 {
		return NewError(CodeValidationError, "ガイドが必要")
	}
	for _, output := range outputs {
		if err := ValidateGeneratedGuide(output, allowedArtifacts); err != nil {
			return err
		}
	}
	return nil
}

func ValidateGeneratedGuide(output GeneratedGuide, allowedArtifacts map[ID]struct{}) error {
	steps := make([]GuideStep, 0, len(output.Steps))
	for index, step := range output.Steps {
		steps = append(steps, GuideStep{
			Position:    index + 1,
			ArtifactID:  step.SourceArtifactID,
			Instruction: step.Instruction,
		})
	}
	return ValidateGuideDraftContent(output.Title, steps, allowedArtifacts)
}

// SelectGuideMaterialIndexes selects at most MaxAIInputMaterials ordered
// materials, always retaining the first and last when truncation is needed.
func SelectGuideMaterialIndexes(total int) []int {
	if total <= 0 {
		return nil
	}
	if total <= MaxAIInputMaterials {
		indexes := make([]int, total)
		for index := range indexes {
			indexes[index] = index
		}
		return indexes
	}
	indexes := make([]int, MaxAIInputMaterials)
	last := total - 1
	denominator := MaxAIInputMaterials - 1
	for index := range indexes {
		indexes[index] = index * last / denominator
	}
	return indexes
}
