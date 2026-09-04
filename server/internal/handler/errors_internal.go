package handler

import "github.com/kakuraccho/mite/server/internal/domain"

func domainInternalError() error {
	return domain.NewError(domain.CodeInternalError, "サーバー内部でエラーが発生した")
}

func forbiddenOriginError() error {
	return domain.NewError(domain.CodeForbidden, "許可されていない接続元")
}

func validationRequestError() error {
	return domain.NewError(domain.CodeValidationError, "入力形式が不正")
}
