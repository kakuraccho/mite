package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestGeminiGuideGeneratorRequestAndResponse(t *testing.T) {
	t.Parallel()
	var captured []byte
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "https://generativelanguage.googleapis.com/v1beta/interactions" {
			t.Fatalf("URL = %s", request.URL)
		}
		if request.Header.Get("x-goog-api-key") != "secret" {
			t.Fatal("API key header is missing")
		}
		captured, _ = io.ReadAll(request.Body)
		body := `{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"{\"guides\":[{\"title\":\"設定\",\"steps\":[{\"sourceArtifactId\":\"art_1\",\"instruction\":\"設定を押す\"}]}]}"}]}]}`
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
	generator, err := NewGeminiGuideGenerator("https://generativelanguage.googleapis.com/v1beta", "secret", GeminiModel, GeminiPromptVersion, client)
	if err != nil {
		t.Fatal(err)
	}
	output, err := generator.Generate(context.Background(), domain.GuideGenerationInput{Comment: "困った", Images: []domain.GuideGenerationInputImage{{Kind: domain.ArtifactPurposeRequestScreenshot, ArtifactID: "art_1", CapturedAt: time.Unix(1, 0), JPEG: []byte{1}}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(output) != 1 || output[0].Title != "設定" || len(output[0].Steps) != 1 || output[0].Steps[0].SourceArtifactID != "art_1" {
		t.Fatalf("output = %+v", output)
	}
	var request map[string]any
	if err := json.Unmarshal(captured, &request); err != nil {
		t.Fatal(err)
	}
	if request["model"] != GeminiModel || request["store"] != false || request["background"] != false || request["stream"] != false {
		t.Fatalf("request flags/model = %#v", request)
	}
	if bytes.Contains(captured, []byte("secret")) {
		t.Fatal("API key leaked into request body")
	}
	configuration := request["generation_config"].(map[string]any)
	if configuration["thinking_level"] != "low" || configuration["max_output_tokens"] != float64(8192) {
		t.Fatalf("generation config = %#v", configuration)
	}
	responseFormat, ok := request["response_format"].(map[string]any)
	if !ok {
		t.Fatalf("response_format = %#v", request["response_format"])
	}
	if responseFormat["type"] != "text" || responseFormat["mime_type"] != "application/json" {
		t.Fatalf("response_format type/mime_type = %#v", responseFormat)
	}
	if _, ok := responseFormat["schema"]; !ok {
		t.Fatalf("response_format.schema is missing: %#v", responseFormat)
	}
	if _, ok := responseFormat["json_schema"]; ok {
		t.Fatalf("response_format.json_schema must not be sent: %#v", responseFormat)
	}
}

func TestParseGeminiResponseFailures(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, body string
		code       domain.GuideGenerationErrorCode
	}{
		{"refusal", `{"status":"completed","refusal":{}}`, domain.GuideGenerationAIRefusal},
		{"content refusal", `{"status":"completed","steps":[{"type":"model_output","content":[{"type":"refusal"}]}]}`, domain.GuideGenerationAIRefusal},
		{"not completed", `{"status":"running","steps":[]}`, domain.GuideGenerationAIIncompleteResponse},
		{"empty", `{"status":"completed","steps":[]}`, domain.GuideGenerationAIIncompleteResponse},
		{"multiple", `{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"{}"},{"type":"text","text":"{}"}]}]}`, domain.GuideGenerationAIIncompleteResponse},
		{"unknown field", `{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"{\"title\":\"x\",\"steps\":[],\"extra\":true}"}]}]}`, domain.GuideGenerationAIInvalidOutput},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseGeminiResponse([]byte(test.body))
			var failure *GuideGenerationFailure
			if !errors.As(err, &failure) || failure.Code != test.code {
				t.Fatalf("error = %v, want %s", err, test.code)
			}
		})
	}
}

func TestBuildGeminiRequestEnforcesImageLimits(t *testing.T) {
	t.Parallel()
	images := make([]domain.GuideGenerationInputImage, domain.MaxAIInputMaterials+2)
	for index := range images {
		images[index] = domain.GuideGenerationInputImage{ArtifactID: domain.ID("a"), JPEG: []byte{1}}
	}
	if _, err := buildGeminiRequest(GeminiModel, domain.GuideGenerationInput{Images: images}); err == nil {
		t.Fatal("32 images accepted")
	}
	if _, err := buildGeminiRequest(GeminiModel, domain.GuideGenerationInput{Images: []domain.GuideGenerationInputImage{{ArtifactID: "a", JPEG: make([]byte, domain.MaxAIInputImageBytes+1)}}}); err == nil {
		t.Fatal("oversized image accepted")
	}
}

func TestPrepareGuideImageResizesAndCompresses(t *testing.T) {
	t.Parallel()
	input := image.NewRGBA(image.Rect(0, 0, 2200, 1200))
	for y := 0; y < 1200; y++ {
		for x := 0; x < 2200; x++ {
			input.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: uint8(x + y), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, input, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	prepared, err := prepareGuideImage(encoded.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared) > domain.MaxAIInputImageBytes {
		t.Fatalf("prepared bytes = %d", len(prepared))
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(prepared))
	if err != nil {
		t.Fatal(err)
	}
	if config.Width > 1920 || config.Height > 1080 {
		t.Fatalf("dimensions = %dx%d", config.Width, config.Height)
	}
}

func TestParseGeminiResponseWithMultipleGuides(t *testing.T) {
	output := `{"guides":[{"title":"ログインする","steps":[{"sourceArtifactId":"art_1","instruction":"ログインを押す"}]},{"title":"住所を変更する","steps":[{"sourceArtifactId":"art_2","instruction":"住所を入力する"}]}]}`
	response, err := json.Marshal(map[string]any{"status": "completed", "steps": []any{map[string]any{"type": "model_output", "content": []any{map[string]any{"type": "text", "text": output}}}}})
	if err != nil {
		t.Fatal(err)
	}
	guides, err := parseGeminiResponse(response)
	if err != nil || len(guides) != 2 || guides[0].Title != "ログインする" || guides[1].Title != "住所を変更する" || guides[1].Steps[0].SourceArtifactID != "art_2" {
		t.Fatalf("guides=%+v, err=%v", guides, err)
	}
}
