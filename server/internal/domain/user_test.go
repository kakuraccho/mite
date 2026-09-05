package domain

import "testing"

func TestUserPairAuthorize(t *testing.T) {
	t.Parallel()
	pair := UserPair{UserID: "user_demo", FamilyID: "family_demo"}
	if err := pair.Authorize(Actor{ID: "user_demo", Role: RoleUser}, RoleUser); err != nil {
		t.Fatalf("Authorize(user) error = %v", err)
	}
	if err := pair.Authorize(Actor{ID: "family_demo", Role: RoleFamily}, RoleUser); err == nil {
		t.Fatal("Authorize(family as user) succeeded")
	}
	if err := pair.Authorize(Actor{ID: "other", Role: RoleUser}, RoleUser); err == nil {
		t.Fatal("Authorize(other user) succeeded")
	}
}
