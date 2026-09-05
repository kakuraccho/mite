package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type StorageOperationError struct {
	Operation      string
	StatusCode     int
	OutcomeUnknown bool
	Cause          error
}

func (e *StorageOperationError) Error() string {
	if e.StatusCode != 0 {
		return fmt.Sprintf("storage %s failed with status %d", e.Operation, e.StatusCode)
	}
	return fmt.Sprintf("storage %s failed: %v", e.Operation, e.Cause)
}

func (e *StorageOperationError) Unwrap() error {
	return e.Cause
}

func IsStorageOutcomeUnknown(err error) bool {
	var operationErr *StorageOperationError
	return errors.As(err, &operationErr) && operationErr.OutcomeUnknown
}

type SupabaseStorage struct {
	baseURL   string
	bucket    string
	secretKey string
	client    *http.Client
}

func NewSupabaseStorage(
	baseURL string,
	bucket string,
	secretKey string,
	client *http.Client,
) (*SupabaseStorage, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("supabase storage base URL is invalid")
	}
	if strings.TrimSpace(bucket) == "" || strings.Contains(bucket, "/") {
		return nil, errors.New("supabase storage bucket is invalid")
	}
	if secretKey == "" {
		return nil, errors.New("supabase storage secret key is required")
	}
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &SupabaseStorage{
		baseURL: strings.TrimRight(baseURL, "/"), bucket: bucket, secretKey: secretKey, client: client,
	}, nil
}

func (s *SupabaseStorage) Put(
	ctx context.Context,
	key string,
	body io.Reader,
	size int64,
	contentType string,
) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.objectURL(key), body)
	if err != nil {
		return &StorageOperationError{Operation: "put", Cause: err}
	}
	request.ContentLength = size
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("x-upsert", "true")
	s.authorize(request)

	response, err := s.client.Do(request)
	if err != nil {
		return &StorageOperationError{Operation: "put", OutcomeUnknown: true, Cause: err}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return &StorageOperationError{Operation: "put", StatusCode: response.StatusCode}
	}
	return nil
}

func (s *SupabaseStorage) Get(ctx context.Context, key string) (StoredObject, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.objectURL(key), nil)
	if err != nil {
		return StoredObject{}, &StorageOperationError{Operation: "get", Cause: err}
	}
	s.authorize(request)
	response, err := s.client.Do(request)
	if err != nil {
		return StoredObject{}, &StorageOperationError{Operation: "get", Cause: err}
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		response.Body.Close()
		return StoredObject{}, &StorageOperationError{Operation: "get", StatusCode: response.StatusCode}
	}
	return StoredObject{
		Body: response.Body, ContentType: response.Header.Get("Content-Type"), Size: response.ContentLength,
	}, nil
}

func (s *SupabaseStorage) Delete(ctx context.Context, key string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodDelete, s.objectURL(key), nil)
	if err != nil {
		return &StorageOperationError{Operation: "delete", Cause: err}
	}
	s.authorize(request)
	response, err := s.client.Do(request)
	if err != nil {
		return &StorageOperationError{Operation: "delete", OutcomeUnknown: true, Cause: err}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 8192))
	if response.StatusCode == http.StatusNotFound || storageResponseIsNotFound(responseBody) {
		return nil
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return &StorageOperationError{Operation: "delete", StatusCode: response.StatusCode}
	}
	return nil
}

func storageResponseIsNotFound(body []byte) bool {
	var response struct {
		StatusCode json.RawMessage `json:"statusCode"`
		Error      string          `json:"error"`
	}
	if json.Unmarshal(body, &response) != nil {
		return false
	}
	if strings.EqualFold(response.Error, "not_found") || strings.EqualFold(response.Error, "NoSuchKey") {
		return true
	}
	var stringStatus string
	if json.Unmarshal(response.StatusCode, &stringStatus) == nil && stringStatus == "404" {
		return true
	}
	var numericStatus int
	return json.Unmarshal(response.StatusCode, &numericStatus) == nil && numericStatus == http.StatusNotFound
}

func (s *SupabaseStorage) objectURL(key string) string {
	segments := strings.Split(key, "/")
	for index := range segments {
		segments[index] = url.PathEscape(segments[index])
	}
	return s.baseURL + "/storage/v1/object/" + url.PathEscape(s.bucket) + "/" + strings.Join(segments, "/")
}

func (s *SupabaseStorage) authorize(request *http.Request) {
	request.Header.Set("apikey", s.secretKey)
	request.Header.Set("Authorization", "Bearer "+s.secretKey)
}

var _ ObjectStorage = (*SupabaseStorage)(nil)
