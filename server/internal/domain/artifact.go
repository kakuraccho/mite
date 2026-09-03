package domain

import "time"

const MaxArtifactBytes int64 = 10 * 1024 * 1024

type Artifact struct {
	ID          ID
	OwnerUserID ID
	Purpose     ArtifactPurpose
	MimeType    string
	StorageKey  string
	SHA256      string
	ByteSize    int64
	Width       int
	Height      int
	CapturedAt  time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Revision    int64
}

type ArtifactDeletionTaskStatus string

const (
	ArtifactDeletionPending ArtifactDeletionTaskStatus = "PENDING"
	ArtifactDeletionRunning ArtifactDeletionTaskStatus = "RUNNING"
)

func (s ArtifactDeletionTaskStatus) Valid() bool {
	return s == ArtifactDeletionPending || s == ArtifactDeletionRunning
}

type ArtifactDeletionTask struct {
	ID            ID
	ArtifactID    *ID
	StorageKey    string
	Status        ArtifactDeletionTaskStatus
	Attempt       int
	NextAttemptAt time.Time
	CreatedAt     time.Time
}
