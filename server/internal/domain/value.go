package domain

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

type ID string

func NewID(value string) (ID, error) {
	if !utf8.ValidString(value) || strings.TrimSpace(value) == "" {
		return "", NewError(CodeValidationError, "IDが不正")
	}
	return ID(value), nil
}

func ValidateText(value string, minRunes, maxRunes int, required bool) error {
	if !utf8.ValidString(value) {
		return NewError(CodeValidationError, "文字列がUTF-8ではない")
	}
	length := utf8.RuneCountInString(value)
	if required && strings.TrimSpace(value) == "" {
		return NewError(CodeValidationError, "必須文字列が空")
	}
	if length < minRunes || length > maxRunes {
		return NewError(
			CodeValidationError,
			fmt.Sprintf("文字数は%d〜%d文字で指定する", minRunes, maxRunes),
		)
	}
	return nil
}
