package service

import (
	"context"

	"github.com/kakuraccho/mite/server/internal/domain"
)

// GuideGenerator is the external AI boundary. Feature code must validate its
// output before persisting a GuideDraft.
type GuideGenerator interface {
	Generate(context.Context, domain.GuideGenerationInput) (domain.GeneratedGuide, error)
}
