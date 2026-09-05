package domain

import "time"

func NewRingingSupportSession(id ID, request SupportRequest, now time.Time) (SupportSession, error) {
	if request.Status != SupportRequestPending || request.SupportSessionID != nil {
		return SupportSession{}, NewError(CodeInvalidState, "現在の支援依頼には発信できない")
	}
	return SupportSession{
		ID: id, SupportRequestID: request.ID, UserID: request.UserID, FamilyID: request.FamilyID,
		LiveKitRoomName: "mite-" + string(id), Status: SupportSessionRinging,
		CreatedAt: now, UpdatedAt: now, Revision: 1,
	}, nil
}

func ValidateExpectedRevision(actual, expected int64) error {
	if expected < 1 {
		return NewError(CodeValidationError, "expectedRevisionは1以上で指定する")
	}
	if actual != expected {
		return NewError(CodeRevisionConflict, "revisionが更新されている")
	}
	return nil
}

func ValidateAcceptSupportSession(session SupportSession, request SupportRequest, consent Consent) error {
	if session.Status != SupportSessionRinging || request.Status != SupportRequestPending ||
		request.SupportSessionID == nil || *request.SupportSessionID != session.ID {
		return NewError(CodeInvalidState, "現在の支援セッションには応答できない")
	}
	if !consent.Accepted() {
		return NewError(CodeValidationError, "音声、画面共有、定期取得への同意が必要")
	}
	return nil
}

func ValidateResolveSupportSession(session SupportSession, request SupportRequest, decision GuideDecision) error {
	if !decision.Valid() {
		return NewError(CodeValidationError, "guideDecisionが不正")
	}
	if session.Status != SupportSessionActive || request.Status != SupportRequestInSupport ||
		request.SupportSessionID == nil || *request.SupportSessionID != session.ID {
		return NewError(CodeInvalidState, "現在の支援セッションは解決できない")
	}
	return nil
}

func ValidateEndWithoutGuide(
	session SupportSession,
	actor Actor,
	reason SupportSessionEndReason,
	jobStatus *GuideGenerationJobStatus,
) error {
	switch actor.Role {
	case RoleUser:
		if reason != EndReasonNoMaterials {
			return NewError(CodeForbidden, "利用者はNO_MATERIALSだけを指定できる")
		}
		if session.Status != SupportSessionGeneratingGuide ||
			session.GuideMaterialBatchID != nil || session.GuideGenerationJobID != nil {
			return NewError(CodeInvalidState, "画像なしで終了できる状態ではない")
		}
	case RoleFamily:
		if reason != EndReasonGuideCancelled {
			return NewError(CodeForbidden, "家族はGUIDE_CANCELLEDだけを指定できる")
		}
		if session.Status == SupportSessionReviewingGuide {
			return nil
		}
		if session.Status != SupportSessionGeneratingGuide {
			return NewError(CodeInvalidState, "ガイド作成を中止できる状態ではない")
		}
		if session.GuideGenerationJobID != nil {
			if jobStatus == nil || *jobStatus != GuideGenerationJobFailed {
				return NewError(CodeInvalidState, "ガイド生成ジョブの実行中は中止できない")
			}
		}
	default:
		return NewError(CodeForbidden, "この役割では終了できない")
	}
	return nil
}
