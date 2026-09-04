package domain

import (
	"fmt"
	"strings"
)

const MaxSupportRequestCommentRunes = 500

func ArtifactStorageKey(ownerUserID, artifactID ID) string {
	return fmt.Sprintf("%s/%s.jpg", ownerUserID, artifactID)
}

func (a Artifact) Validate() error {
	if _, err := NewID(string(a.ID)); err != nil {
		return err
	}
	if _, err := NewID(string(a.OwnerUserID)); err != nil {
		return err
	}
	if !a.Purpose.Valid() {
		return NewError(CodeValidationError, "Artifact purposeが不正")
	}
	if a.MimeType != "image/jpeg" {
		return NewError(CodeValidationError, "Artifact mimeTypeが不正")
	}
	if a.StorageKey != ArtifactStorageKey(a.OwnerUserID, a.ID) {
		return NewError(CodeValidationError, "Artifact storageKeyが不正")
	}
	if _, err := NewRequestHash(a.SHA256); err != nil {
		return NewError(CodeValidationError, "Artifact SHA-256が不正")
	}
	if a.ByteSize < 1 || a.ByteSize > MaxArtifactBytes {
		return NewError(CodeValidationError, "Artifact byteSizeが不正")
	}
	if a.Width < 1 || a.Height < 1 {
		return NewError(CodeValidationError, "Artifact寸法が不正")
	}
	if a.CapturedAt.IsZero() || a.CreatedAt.IsZero() || a.UpdatedAt.IsZero() || a.UpdatedAt.Before(a.CreatedAt) {
		return NewError(CodeValidationError, "Artifact日時が不正")
	}
	if a.Revision < 1 {
		return NewError(CodeValidationError, "Artifact revisionが不正")
	}
	return nil
}

func (r SupportRequest) Validate() error {
	for _, id := range []ID{r.ID, r.UserID, r.FamilyID, r.InitialScreenshotArtifactID} {
		if _, err := NewID(string(id)); err != nil {
			return err
		}
	}
	if r.UserID == r.FamilyID {
		return NewError(CodeValidationError, "SupportRequestのペアが不正")
	}
	if err := ValidateSupportRequestComment(r.Comment); err != nil {
		return err
	}
	if !r.Status.Valid() {
		return NewError(CodeValidationError, "SupportRequest statusが不正")
	}
	if r.SupportSessionID != nil {
		if _, err := NewID(string(*r.SupportSessionID)); err != nil {
			return err
		}
	}
	if r.GuideContext != nil {
		if err := r.GuideContext.Validate(); err != nil {
			return err
		}
	}
	if r.CreatedAt.IsZero() || r.UpdatedAt.IsZero() || r.UpdatedAt.Before(r.CreatedAt) {
		return NewError(CodeValidationError, "SupportRequest日時が不正")
	}
	if r.Revision < 1 {
		return NewError(CodeValidationError, "SupportRequest revisionが不正")
	}
	return nil
}

func (c GuideContext) Validate() error {
	for _, id := range []ID{c.GuideRunID, c.GuideID, c.StepArtifactID} {
		if _, err := NewID(string(id)); err != nil {
			return err
		}
	}
	if c.GuideVersionNumber < 1 || c.StepNumber < 1 {
		return NewError(CodeValidationError, "guideContextの番号が不正")
	}
	if err := ValidateText(c.GuideTitle, 1, 40, true); err != nil {
		return err
	}
	if err := ValidateText(c.StepInstruction, 1, 120, true); err != nil {
		return err
	}
	return nil
}

func ValidateSupportRequestComment(comment string) error {
	if strings.ContainsRune(comment, '\x00') {
		return NewError(CodeValidationError, "コメントに使用できない文字が含まれている")
	}
	return ValidateText(comment, 0, MaxSupportRequestCommentRunes, false)
}
