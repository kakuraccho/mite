package domain

import (
	"encoding/json"
	"time"
)

type EventType string

const (
	EventSupportRequestCreated     EventType = "supportRequest.created"
	EventSupportRequestUpdated     EventType = "supportRequest.updated"
	EventSupportSessionCreated     EventType = "supportSession.created"
	EventSupportSessionUpdated     EventType = "supportSession.updated"
	EventGuideMaterialBatchCreated EventType = "guideMaterialBatch.created"
	EventGuideMaterialBatchUpdated EventType = "guideMaterialBatch.updated"
	EventGuideGenerationJobCreated EventType = "guideGenerationJob.created"
	EventGuideGenerationJobUpdated EventType = "guideGenerationJob.updated"
	EventGuideDraftCreated         EventType = "guideDraft.created"
	EventGuideDraftUpdated         EventType = "guideDraft.updated"
	EventGuideCreated              EventType = "guide.created"
	EventGuideRunCreated           EventType = "guideRun.created"
	EventGuideRunUpdated           EventType = "guideRun.updated"
)

type Event struct {
	EventID    ID              `json:"eventId"`
	Type       EventType       `json:"type"`
	OccurredAt time.Time       `json:"occurredAt"`
	EntityID   ID              `json:"entityId"`
	Revision   int64           `json:"revision"`
	Data       json.RawMessage `json:"data"`
	Audience   UserPair        `json:"-"`
}
