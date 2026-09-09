package domain

import (
	"fmt"
	"testing"
	"unicode/utf8"
)

func TestValidateGuideDraftContentBoundaries(t *testing.T) {
	t.Parallel()
	allowed := make(map[ID]struct{})
	steps := make([]GuideStep, 0, MaxGuideSteps)
	for index := 1; index <= MaxGuideSteps; index++ {
		artifactID := ID(fmt.Sprintf("art_%d", index))
		allowed[artifactID] = struct{}{}
		steps = append(steps, GuideStep{Position: index, ArtifactID: artifactID, Instruction: "ボタンを押す"})
	}
	if err := ValidateGuideDraftContent("操作ガイド", steps[:1], allowed); err != nil {
		t.Fatalf("one step error = %v", err)
	}
	if err := ValidateGuideDraftContent("操作ガイド", steps, allowed); err != nil {
		t.Fatalf("eight steps error = %v", err)
	}
	if err := ValidateGuideDraftContent("操作ガイド", nil, allowed); err == nil {
		t.Fatal("zero steps accepted")
	}
	nineSteps := append(append([]GuideStep(nil), steps...), GuideStep{Position: 9, ArtifactID: "art_9", Instruction: "完了する"})
	if err := ValidateGuideDraftContent("操作ガイド", nineSteps, allowed); err == nil {
		t.Fatal("nine steps accepted")
	}
}

func TestSelectGuideMaterialIndexes(t *testing.T) {
	t.Parallel()
	tests := []struct{ total, want int }{{0, 0}, {1, 1}, {30, 30}, {31, 30}, {360, 30}}
	for _, test := range tests {
		indexes := SelectGuideMaterialIndexes(test.total)
		if len(indexes) != test.want {
			t.Fatalf("total %d: len = %d, want %d", test.total, len(indexes), test.want)
		}
		for index := 1; index < len(indexes); index++ {
			if indexes[index] <= indexes[index-1] {
				t.Fatalf("total %d: indexes are not strictly increasing: %v", test.total, indexes)
			}
		}
		if test.total > 0 && (indexes[0] != 0 || indexes[len(indexes)-1] != test.total-1) {
			t.Fatalf("total %d: first/last not retained: %v", test.total, indexes)
		}
	}
}

func TestValidateGeneratedGuideBoundaries(t *testing.T) {
	t.Parallel()
	allowed := map[ID]struct{}{"art_1": {}}
	valid := GeneratedGuide{Title: "ガイド", Steps: []GeneratedGuideStep{{SourceArtifactID: "art_1", Instruction: "ボタンを押す"}}}
	if err := ValidateGeneratedGuide(valid, allowed); err != nil {
		t.Fatalf("valid output rejected: %v", err)
	}
	invalid := []GeneratedGuide{
		{Title: "", Steps: valid.Steps},
		{Title: string(make([]rune, 41)), Steps: valid.Steps},
		{Title: "ガイド", Steps: nil},
		{Title: "ガイド", Steps: []GeneratedGuideStep{{SourceArtifactID: "other", Instruction: "押す"}}},
		{Title: "ガイド", Steps: []GeneratedGuideStep{{SourceArtifactID: "art_1", Instruction: " "}}},
	}
	for index, output := range invalid {
		if err := ValidateGeneratedGuide(output, allowed); err == nil {
			t.Fatalf("invalid output %d accepted", index)
		}
	}
	if !utf8.ValidString(valid.Title) {
		t.Fatal("test fixture is invalid UTF-8")
	}
}

func TestValidateGuideDraftContentRejectsInvalidStep(t *testing.T) {
	t.Parallel()
	allowed := map[ID]struct{}{"art_1": {}}
	tests := []struct {
		name  string
		steps []GuideStep
	}{
		{name: "position gap", steps: []GuideStep{{Position: 2, ArtifactID: "art_1", Instruction: "押す"}}},
		{name: "unknown artifact", steps: []GuideStep{{Position: 1, ArtifactID: "art_other", Instruction: "押す"}}},
		{name: "blank instruction", steps: []GuideStep{{Position: 1, ArtifactID: "art_1", Instruction: "  "}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := ValidateGuideDraftContent("操作ガイド", test.steps, allowed); err == nil {
				t.Fatal("invalid steps accepted")
			}
		})
	}
}

func TestConsentAccepted(t *testing.T) {
	t.Parallel()
	accepted := Consent{Audio: true, ScreenShare: true, PeriodicCapture: true, TextVersion: "v1"}
	if !accepted.Accepted() {
		t.Fatal("complete v1 consent was rejected")
	}
	accepted.Audio = false
	if accepted.Accepted() {
		t.Fatal("partial consent was accepted")
	}
}

func TestMoveGuideStep(t *testing.T) {
	t.Parallel()
	if next, err := MoveGuideStep(1, 3, GuideRunNext); err != nil || next != 2 {
		t.Fatalf("MoveGuideStep NEXT = %d, %v; want 2, nil", next, err)
	}
	if next, err := MoveGuideStep(2, 3, GuideRunPrevious); err != nil || next != 1 {
		t.Fatalf("MoveGuideStep PREVIOUS = %d, %v; want 1, nil", next, err)
	}
	if _, err := MoveGuideStep(1, 3, GuideRunPrevious); err == nil {
		t.Fatal("MoveGuideStep accepted an out-of-range move")
	}
	if !CanCompleteGuideRun(3, 3) || CanCompleteGuideRun(2, 3) {
		t.Fatal("CanCompleteGuideRun returned an unexpected result")
	}
}
