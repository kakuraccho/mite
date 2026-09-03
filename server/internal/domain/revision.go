package domain

import "math"

const InitialRevision int64 = 1

func CheckExpectedRevision(current, expected int64) error {
	if current < InitialRevision || expected < InitialRevision {
		return NewError(CodeValidationError, "revisionは1以上で指定する")
	}
	if current != expected {
		return NewError(CodeRevisionConflict, "内容が更新されている")
	}
	return nil
}

func NextRevision(current int64) (int64, error) {
	if current < InitialRevision {
		return 0, NewError(CodeValidationError, "revisionは1以上である必要がある")
	}
	if current == math.MaxInt64 {
		return 0, NewError(CodeInternalError, "revisionを更新できない")
	}
	return current + 1, nil
}
