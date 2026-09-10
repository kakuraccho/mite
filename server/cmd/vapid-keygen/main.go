package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
)

func main() {
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		fmt.Fprintln(os.Stderr, "VAPID key generation failed")
		os.Exit(1)
	}
	encoding := base64.RawURLEncoding
	fmt.Printf("WEB_PUSH_VAPID_PUBLIC_KEY=%s\n", encoding.EncodeToString(key.PublicKey().Bytes()))
	fmt.Printf("WEB_PUSH_VAPID_PRIVATE_KEY=%s\n", encoding.EncodeToString(key.Bytes()))
}
