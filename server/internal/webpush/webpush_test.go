package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"testing"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func decryptForTest(ciphertext, key, nonce []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	var gcm cipher.AEAD
	gcm, err = cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, nil)
}

func TestEncryptProducesDecryptableAES128GCMRecord(t *testing.T) {
	recipient, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	subscription := domain.PushSubscription{
		P256DH: base64.RawURLEncoding.EncodeToString(recipient.PublicKey().Bytes()),
		Auth:   base64.RawURLEncoding.EncodeToString(auth),
	}
	payload := []byte(`{"title":"Mite"}`)
	body, err := encrypt(subscription, payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) < 86 || body[20] != 65 {
		t.Fatalf("invalid aes128gcm header: %d bytes", len(body))
	}
	salt := body[:16]
	ephemeralBytes := body[21:86]
	ephemeral, err := ecdh.P256().NewPublicKey(ephemeralBytes)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := recipient.ECDH(ephemeral)
	if err != nil {
		t.Fatal(err)
	}
	info := append([]byte("WebPush: info\x00"), recipient.PublicKey().Bytes()...)
	info = append(info, ephemeralBytes...)
	ikm := hkdfExpand(hkdfExtract(auth, shared), info, 32)
	prk := hkdfExtract(salt, ikm)
	plaintext, err := decryptForTest(body[86:], hkdfExpand(prk, []byte("Content-Encoding: aes128gcm\x00"), 16), hkdfExpand(prk, []byte("Content-Encoding: nonce\x00"), 12))
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext[:len(plaintext)-1]) != string(payload) || plaintext[len(plaintext)-1] != 0x02 {
		t.Fatalf("plaintext = %q", plaintext)
	}
}

func TestValidateEndpointRejectsPrivateAddresses(t *testing.T) {
	for _, endpoint := range []string{"http://push.example/send", "https://localhost/send", "https://127.0.0.1/send", "https://[::1]/send"} {
		if _, err := validateEndpoint(endpoint); err == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	if _, err := validateEndpoint("https://push.example/send"); err != nil {
		t.Fatal(err)
	}
}
