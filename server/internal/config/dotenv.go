package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"
)

// readDotEnv supplies configuration defaults without changing the process environment.
// Values are literal: shell expansion, escapes and inline comments are not interpreted.
func readDotEnv(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("cannot read .env")
	}
	return parseDotEnv(strings.TrimPrefix(string(data), "\uFEFF"))
}

func parseDotEnv(content string) (map[string]string, error) {
	values := make(map[string]string)
	for index, line := range strings.Split(content, "\n") {
		invalid := func() (map[string]string, error) {
			// Neither the line nor its key is safe to include in an error.
			return nil, fmt.Errorf("invalid .env format at line %d", index+1)
		}
		if !utf8.ValidString(line) || strings.ContainsRune(line, '\x00') {
			return invalid()
		}
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !validEnvKey(key) {
			return invalid()
		}
		value = strings.TrimSpace(value)
		if len(value) > 0 && (value[0] == '\'' || value[0] == '"') {
			if len(value) < 2 || strings.IndexByte(value[1:], value[0]) != len(value)-2 {
				return invalid()
			}
			value = value[1 : len(value)-1]
		}
		values[key] = value
	}
	return values, nil
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for index, char := range key {
		if char == '_' || char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' {
			continue
		}
		if index > 0 && char >= '0' && char <= '9' {
			continue
		}
		return false
	}
	return true
}
