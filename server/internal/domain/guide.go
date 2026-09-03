package domain

import "time"

const (
	CaptureIntervalSeconds = 5
	MaxGuideMaterials      = 360
	MaxGuideSteps          = 8
	MaxAIInputMaterials    = 30
)

type GuideMaterialBatch struct {
	ID                     ID
	SupportSessionID       ID
	Status                 GuideMaterialBatchStatus
	CaptureIntervalSeconds int
	ExpectedItemCount      int
	ReceivedItemCount      int
	CapturedFrom           time.Time
	CapturedTo             time.Time
	CompletedAt            *time.Time
	CreatedAt              time.Time
	UpdatedAt              time.Time
	Revision               int64
}

type GuideMaterial struct {
	ID              ID
	BatchID         ID
	ClientCaptureID string
	ArtifactID      ID
	Sequence        int
	CapturedAt      time.Time
	CreatedAt       time.Time
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
	ID           ID
	BatchID      ID
	Status       GuideGenerationJobStatus
	Attempt      int
	GuideDraftID *ID
	ErrorCode    *GuideGenerationErrorCode
	CreatedAt    time.Time
	StartedAt    *time.Time
	FinishedAt   *time.Time
	UpdatedAt    time.Time
	Revision     int64
}

type GuideStep struct {
	Position    int
	ArtifactID  ID
	Instruction string
}

type GuideDraft struct {
	ID               ID
	SupportSessionID ID
	Title            string
	Steps            []GuideStep
	Status           GuideDraftStatus
	Revision         int64
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type Guide struct {
	ID                   ID
	UserID               ID
	Title                string
	CurrentVersionNumber int
	CreatedAt            time.Time
	UpdatedAt            time.Time
	Revision             int64
}

type GuideVersion struct {
	GuideID       ID
	VersionNumber int
	Title         string
	CreatedBy     ID
	CreatedAt     time.Time
	Steps         []GuideStep
}

type GuideRun struct {
	ID                 ID
	GuideID            ID
	GuideVersionNumber int
	UserID             ID
	Status             GuideRunStatus
	CurrentStepNumber  int
	SupportRequestID   *ID
	StartedAt          time.Time
	CompletedAt        *time.Time
	PausedAt           *time.Time
	UpdatedAt          time.Time
	Revision           int64
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
	SourceArtifactID ID
	Instruction      string
}

type GeneratedGuide struct {
	Title string
	Steps []GeneratedGuideStep
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
