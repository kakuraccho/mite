package webpush

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

type Sender struct {
	store      repository.CompanionStore
	client     *http.Client
	logger     *slog.Logger
	publicKey  string
	privateKey *ecdsa.PrivateKey
	subject    string
	now        func() time.Time
}

func NewSender(store repository.CompanionStore, publicKey, privateKey, subject string, logger *slog.Logger, client *http.Client) (*Sender, error) {
	if logger == nil {
		logger = slog.Default()
	}
	sender := &Sender{store: store, logger: logger, publicKey: publicKey, subject: subject, now: func() time.Time { return time.Now().UTC() }}
	if publicKey == "" && privateKey == "" && subject == "" {
		return sender, nil
	}
	privateBytes, err := base64.RawURLEncoding.DecodeString(privateKey)
	if err != nil || len(privateBytes) != 32 {
		return nil, errors.New("WEB_PUSH_VAPID_PRIVATE_KEY must be a 32-byte base64url value")
	}
	d := new(big.Int).SetBytes(privateBytes)
	if d.Sign() <= 0 || d.Cmp(elliptic.P256().Params().N) >= 0 {
		return nil, errors.New("WEB_PUSH_VAPID_PRIVATE_KEY is outside the P-256 range")
	}
	x, y := elliptic.P256().ScalarBaseMult(privateBytes)
	sender.privateKey = &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, D: d}
	expectedPublic := elliptic.Marshal(elliptic.P256(), x, y)
	publicBytes, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil || !bytes.Equal(publicBytes, expectedPublic) {
		return nil, errors.New("WEB_PUSH_VAPID_PUBLIC_KEY does not match the private key")
	}
	if client == nil {
		client = secureHTTPClient()
	}
	sender.client = client
	return sender, nil
}

func (s *Sender) Enabled() bool     { return s != nil && s.privateKey != nil }
func (s *Sender) PublicKey() string { return s.publicKey }

func (s *Sender) Notify(ctx context.Context, familyID domain.ID, kind string) error {
	if !s.Enabled() {
		return errors.New("web push is disabled")
	}
	subscriptions, err := s.store.ListPushSubscriptions(ctx, familyID)
	if err != nil {
		return err
	}
	bodyText := "確認してほしい支援情報があります。"
	if kind == "NEW_SUPPORT_REQUEST" {
		bodyText = "新しい相談があります。"
	} else if kind == "ONLINE_WITH_PENDING_REQUEST" {
		bodyText = "利用者のPCが接続されました。未対応の相談があります。"
	}
	payload := map[string]string{
		"title": "Miteからのお知らせ",
		"body":  bodyText,
		"url":   "/",
		"tag":   fmt.Sprintf("mite-support-%d", s.now().UnixNano()),
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var deliveryErrors []error
	for _, subscription := range subscriptions {
		gone, err := s.send(ctx, subscription, data)
		if gone {
			if deleteErr := s.store.DeletePushSubscriptionByID(ctx, subscription.ID); deleteErr != nil {
				deliveryErrors = append(deliveryErrors, deleteErr)
			}
			continue
		}
		if err != nil {
			deliveryErrors = append(deliveryErrors, err)
		}
	}
	return errors.Join(deliveryErrors...)
}

func (s *Sender) send(ctx context.Context, subscription domain.PushSubscription, payload []byte) (bool, error) {
	endpoint, err := validateEndpoint(subscription.Endpoint)
	if err != nil {
		return false, err
	}
	body, err := encrypt(subscription, payload)
	if err != nil {
		return false, err
	}
	token, err := s.vapidToken(endpoint)
	if err != nil {
		return false, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	request.Header.Set("Authorization", "vapid t="+token+", k="+s.publicKey)
	request.Header.Set("Content-Encoding", "aes128gcm")
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("TTL", "300")
	request.Header.Set("Urgency", "high")
	response, err := s.client.Do(request)
	if err != nil {
		return false, fmt.Errorf("send web push: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
		return true, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false, fmt.Errorf("push service returned HTTP %d", response.StatusCode)
	}
	return false, nil
}

func (s *Sender) vapidToken(endpoint *url.URL) (string, error) {
	header, _ := json.Marshal(map[string]string{"typ": "JWT", "alg": "ES256"})
	claims, _ := json.Marshal(map[string]any{"aud": endpoint.Scheme + "://" + endpoint.Host, "exp": s.now().Add(12 * time.Hour).Unix(), "sub": s.subject})
	unsigned := rawURL(header) + "." + rawURL(claims)
	digest := sha256.Sum256([]byte(unsigned))
	r, ss, err := ecdsa.Sign(rand.Reader, s.privateKey, digest[:])
	if err != nil {
		return "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	ss.FillBytes(signature[32:])
	return unsigned + "." + rawURL(signature), nil
}

func encrypt(subscription domain.PushSubscription, payload []byte) ([]byte, error) {
	recipientBytes, err := base64.RawURLEncoding.DecodeString(subscription.P256DH)
	if err != nil {
		return nil, errors.New("invalid push p256dh key")
	}
	recipient, err := ecdh.P256().NewPublicKey(recipientBytes)
	if err != nil {
		return nil, errors.New("invalid push p256dh key")
	}
	auth, err := base64.RawURLEncoding.DecodeString(subscription.Auth)
	if err != nil || len(auth) != 16 {
		return nil, errors.New("invalid push auth secret")
	}
	ephemeral, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	shared, err := ephemeral.ECDH(recipient)
	if err != nil {
		return nil, err
	}
	keyInfo := append([]byte("WebPush: info\x00"), recipientBytes...)
	keyInfo = append(keyInfo, ephemeral.PublicKey().Bytes()...)
	ikm := hkdfExpand(hkdfExtract(auth, shared), keyInfo, 32)
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	prk := hkdfExtract(salt, ikm)
	cek := hkdfExpand(prk, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := hkdfExpand(prk, []byte("Content-Encoding: nonce\x00"), 12)
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext := append(append([]byte(nil), payload...), 0x02)
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)
	public := ephemeral.PublicKey().Bytes()
	if len(public) > 255 {
		return nil, errors.New("ephemeral push key is too long")
	}
	body := make([]byte, 0, 16+4+1+len(public)+len(ciphertext))
	body = append(body, salt...)
	recordSize := make([]byte, 4)
	binary.BigEndian.PutUint32(recordSize, 4096)
	body = append(body, recordSize...)
	body = append(body, byte(len(public)))
	body = append(body, public...)
	body = append(body, ciphertext...)
	return body, nil
}

func hkdfExtract(salt, input []byte) []byte {
	h := hmac.New(sha256.New, salt)
	_, _ = h.Write(input)
	return h.Sum(nil)
}

func hkdfExpand(prk, info []byte, length int) []byte {
	result := make([]byte, 0, length)
	var previous []byte
	for counter := byte(1); len(result) < length; counter++ {
		h := hmac.New(sha256.New, prk)
		_, _ = h.Write(previous)
		_, _ = h.Write(info)
		_, _ = h.Write([]byte{counter})
		previous = h.Sum(nil)
		result = append(result, previous...)
	}
	return result[:length]
}

func rawURL(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }

func validateEndpoint(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("invalid push endpoint")
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return nil, errors.New("push endpoint must be public")
	}
	if ip := net.ParseIP(host); ip != nil && !publicIP(ip) {
		return nil, errors.New("push endpoint must be public")
	}
	return parsed, nil
}

func publicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast())
}

func secureHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, errors.New("invalid push endpoint address")
			}
			addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(addresses) == 0 {
				return nil, errors.New("push endpoint DNS resolution failed")
			}
			for _, resolved := range addresses {
				if publicIP(resolved.IP) {
					return dialer.DialContext(ctx, network, net.JoinHostPort(resolved.IP.String(), port))
				}
			}
			return nil, errors.New("push endpoint must resolve to a public address")
		},
	}
	return &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("push endpoint redirects are not allowed")
		},
	}
}
