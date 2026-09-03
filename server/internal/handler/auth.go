package handler

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/kakuraccho/mite/server/internal/domain"
)

const bearerPrefix = "Bearer "

type Authenticator struct {
	userToken   string
	familyToken string
}

func NewAuthenticator(userToken, familyToken string) Authenticator {
	return Authenticator{userToken: userToken, familyToken: familyToken}
}

func (a Authenticator) Authenticate(header string) (domain.Actor, error) {
	if !strings.HasPrefix(header, bearerPrefix) {
		return domain.Actor{}, domain.NewError(domain.CodeUnauthenticated, "認証が必要")
	}
	token := strings.TrimPrefix(header, bearerPrefix)
	if token == "" || strings.TrimSpace(token) != token {
		return domain.Actor{}, domain.NewError(domain.CodeUnauthenticated, "認証情報が不正")
	}
	if secureEqual(token, a.userToken) {
		return domain.Actor{ID: "user_demo", Role: domain.RoleUser}, nil
	}
	if secureEqual(token, a.familyToken) {
		return domain.Actor{ID: "family_demo", Role: domain.RoleFamily}, nil
	}
	return domain.Actor{}, domain.NewError(domain.CodeUnauthenticated, "認証情報が不正")
}

func (a Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor, err := a.Authenticate(r.Header.Get("Authorization"))
		if err != nil {
			WriteError(w, r, err)
			return
		}
		ctx := context.WithValue(r.Context(), actorContextKey, actor)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func secureEqual(actual, expected string) bool {
	if len(actual) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}
