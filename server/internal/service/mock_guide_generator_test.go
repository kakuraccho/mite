package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func TestMockGuideGeneratorUsesOnlyInputImages(t *testing.T) {
	t.Parallel()
	for _, count := range []int{1, 2, 5, 31} {
		t.Run(fmt.Sprintf("%d images", count), func(t *testing.T) {
			t.Parallel()
			input := domain.GuideGenerationInput{Comment: "This comment must not affect the fixed guides."}
			allowed := map[domain.ID]struct{}{}
			for index := range count {
				id := domain.ID(fmt.Sprintf("artifact_%d", index))
				input.Images = append(input.Images, domain.GuideGenerationInputImage{ArtifactID: id})
				allowed[id] = struct{}{}
			}
			generator := NewMockGuideGenerator()
			guides, err := generator.Generate(context.Background(), input)
			if err != nil || len(guides) != 2 || len(guides[0].Steps) != 2 || len(guides[1].Steps) != 3 {
				t.Fatalf("expected two guides with two and three steps: %+v, %v", guides, err)
			}
			if err := domain.ValidateGeneratedGuides(guides, allowed); err != nil {
				t.Fatalf("mock output violates normal draft validation: %v", err)
			}
			for _, guide := range guides {
				if !strings.HasPrefix(guide.Title, "【動作確認用】") {
					t.Fatalf("sample guide is not identified: %s", guide.Title)
				}
			}
			input.Comment = "a different comment"
			again, err := generator.Generate(context.Background(), input)
			if err != nil || !reflect.DeepEqual(guides, again) {
				t.Fatalf("mock output is not deterministic: %v", err)
			}
			guides[0].Steps[0].Instruction = "edited"
			if again[0].Steps[0].Instruction == "edited" {
				t.Fatal("separate generations share mutable steps")
			}
		})
	}
}

func TestMockGuideGeneratorRejectsMissingImagesAndCancellation(t *testing.T) {
	t.Parallel()
	generator := NewMockGuideGenerator()
	guides, err := generator.Generate(context.Background(), domain.GuideGenerationInput{})
	var failure *GuideGenerationFailure
	if guides != nil || !errors.As(err, &failure) || failure.Code != domain.GuideGenerationAIInputUnavailable {
		t.Fatalf("missing images: %+v, %v", guides, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	guides, err = generator.Generate(ctx, domain.GuideGenerationInput{Images: []domain.GuideGenerationInputImage{{ArtifactID: "artifact_1"}}})
	if guides != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled generation: %+v, %v", guides, err)
	}
}
