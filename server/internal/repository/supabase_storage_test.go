package repository

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestSupabaseStoragePutGetDelete(t *testing.T) {
	t.Parallel()
	const secret = "test-secret"
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if r.URL.EscapedPath() != "/storage/v1/object/mite-artifacts/user_demo/art_1.jpg" {
			t.Errorf("path = %q", r.URL.EscapedPath())
		}
		if r.Header.Get("apikey") != secret || r.Header.Get("Authorization") != "Bearer "+secret {
			t.Error("storage authorization headers are missing")
		}
		switch r.Method {
		case http.MethodPost:
			if r.Header.Get("x-upsert") != "true" || r.Header.Get("Content-Type") != "image/jpeg" {
				t.Error("upload headers are invalid")
			}
			data, _ := io.ReadAll(r.Body)
			if string(data) != "jpeg" {
				t.Errorf("upload body = %q", data)
			}
			w.WriteHeader(http.StatusCreated)
		case http.MethodGet:
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Content-Length", "4")
			_, _ = w.Write([]byte("jpeg"))
		case http.MethodDelete:
			w.WriteHeader(http.StatusNotFound)
		default:
			t.Errorf("method = %s", r.Method)
		}
	}))
	defer server.Close()

	storage, err := NewSupabaseStorage(server.URL, "mite-artifacts", secret, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(context.Background(), "user_demo/art_1.jpg", bytes.NewBufferString("jpeg"), 4, "image/jpeg"); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	object, err := storage.Get(context.Background(), "user_demo/art_1.jpg")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	data, _ := io.ReadAll(object.Body)
	object.Body.Close()
	if string(data) != "jpeg" || object.ContentType != "image/jpeg" || object.Size != 4 {
		t.Fatalf("object = content %q type %q size %d", data, object.ContentType, object.Size)
	}
	if err := storage.Delete(context.Background(), "user_demo/art_1.jpg"); err != nil {
		t.Fatalf("Delete() should treat 404 as success: %v", err)
	}
	if len(methods) != 3 || methods[0] != http.MethodPost || methods[1] != http.MethodGet || methods[2] != http.MethodDelete {
		t.Fatalf("methods = %v", methods)
	}
}

func TestSupabaseStorageFailureClassification(t *testing.T) {
	t.Parallel()

	t.Run("non-2xx upload is known", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		}))
		defer server.Close()
		storage, err := NewSupabaseStorage(server.URL, "bucket", "secret", server.Client())
		if err != nil {
			t.Fatal(err)
		}
		err = storage.Put(context.Background(), "owner/id.jpg", bytes.NewReader([]byte("x")), 1, "image/jpeg")
		if err == nil || IsStorageOutcomeUnknown(err) {
			t.Fatalf("Put() error = %v unknown=%v", err, IsStorageOutcomeUnknown(err))
		}
	})

	t.Run("transport upload failure is unknown", func(t *testing.T) {
		client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, errors.New("connection reset")
		})}
		storage, err := NewSupabaseStorage("https://example.invalid", "bucket", "secret", client)
		if err != nil {
			t.Fatal(err)
		}
		err = storage.Put(context.Background(), "owner/id.jpg", bytes.NewReader([]byte("x")), 1, "image/jpeg")
		if err == nil || !IsStorageOutcomeUnknown(err) {
			t.Fatalf("Put() error = %v unknown=%v", err, IsStorageOutcomeUnknown(err))
		}
	})
}

func TestNewSupabaseStorageValidatesConfiguration(t *testing.T) {
	t.Parallel()
	tests := []struct {
		baseURL string
		bucket  string
		secret  string
	}{
		{baseURL: "not-a-url", bucket: "bucket", secret: "secret"},
		{baseURL: "https://example.com", bucket: "bad/bucket", secret: "secret"},
		{baseURL: "https://example.com", bucket: "bucket", secret: ""},
	}
	for _, test := range tests {
		if _, err := NewSupabaseStorage(test.baseURL, test.bucket, test.secret, nil); err == nil {
			t.Fatalf("NewSupabaseStorage(%q, %q) accepted invalid configuration", test.baseURL, test.bucket)
		}
	}
}

func TestSupabaseStorageIntegration(t *testing.T) {
	baseURL := os.Getenv("MITE_TEST_SUPABASE_URL")
	secret := os.Getenv("MITE_TEST_SUPABASE_SECRET_KEY")
	if baseURL == "" || secret == "" {
		t.Skip("MITE_TEST_SUPABASE_URL and MITE_TEST_SUPABASE_SECRET_KEY are not set")
	}
	storage, err := NewSupabaseStorage(baseURL, "mite-artifacts", secret, nil)
	if err != nil {
		t.Fatal(err)
	}
	key := "storage_integration/artifact_" + time.Now().UTC().Format("20060102150405.000000000") + ".jpg"
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, image.NewRGBA(image.Rect(0, 0, 2, 2)), &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = storage.Delete(context.Background(), key) }()
	if err := storage.Put(context.Background(), key, bytes.NewReader(jpegData.Bytes()), int64(jpegData.Len()), "image/jpeg"); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	object, err := storage.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	got, err := io.ReadAll(object.Body)
	object.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, jpegData.Bytes()) || object.ContentType != "image/jpeg" {
		t.Fatalf("stored object mismatch: size=%d contentType=%q", len(got), object.ContentType)
	}
	if err := storage.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if err := storage.Delete(context.Background(), key); err != nil {
		t.Fatalf("second Delete() should be idempotent: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}
