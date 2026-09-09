package service

import (
	"context"

	"github.com/kakuraccho/mite/server/internal/domain"
)

// MockGuideGenerator supplies deterministic drafts for development. It uses
// uploaded image references but never interprets their contents or calls AI.
type MockGuideGenerator struct{}

func NewMockGuideGenerator() *MockGuideGenerator { return &MockGuideGenerator{} }

func (*MockGuideGenerator) Generate(ctx context.Context, input domain.GuideGenerationInput) ([]domain.GeneratedGuide, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(input.Images) == 0 {
		return nil, &GuideGenerationFailure{Code: domain.GuideGenerationAIInputUnavailable}
	}
	guides := []domain.GeneratedGuide{
		{
			Title: "【動作確認用】画面を確認する",
			Steps: []domain.GeneratedGuideStep{
				{Instruction: "画像に表示された画面を確認する"},
				{Instruction: "画像の中にある文字を確認する"},
			},
		},
		{
			Title: "【動作確認用】手順を見直す",
			Steps: []domain.GeneratedGuideStep{
				{Instruction: "画像を見て、説明したい場所を確認する"},
				{Instruction: "説明したい場所に表示された名前を確認する"},
				{Instruction: "画像と手順の説明を見比べる"},
			},
		},
	}
	imageIndex := 0
	for guideIndex := range guides {
		for stepIndex := range guides[guideIndex].Steps {
			guides[guideIndex].Steps[stepIndex].SourceArtifactID = input.Images[imageIndex%len(input.Images)].ArtifactID
			imageIndex++
		}
	}
	return guides, nil
}
