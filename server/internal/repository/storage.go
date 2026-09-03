package repository

import (
	"context"
	"io"
)

type StoredObject struct {
	Body        io.ReadCloser
	ContentType string
	Size        int64
}

// ObjectStorage is the Supabase Storage boundary.
type ObjectStorage interface {
	Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error
	Get(ctx context.Context, key string) (StoredObject, error)
	Delete(ctx context.Context, key string) error
}
