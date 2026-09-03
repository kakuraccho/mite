package domain

type Role string

const (
	RoleUser   Role = "USER"
	RoleFamily Role = "FAMILY"
)

func (r Role) Valid() bool {
	return r == RoleUser || r == RoleFamily
}

type User struct {
	ID          ID
	Role        Role
	DisplayName string
}

type UserPair struct {
	UserID   ID
	FamilyID ID
}

type Actor struct {
	ID   ID
	Role Role
}

func (a Actor) Validate() error {
	if _, err := NewID(string(a.ID)); err != nil {
		return err
	}
	if !a.Role.Valid() {
		return NewError(CodeUnauthenticated, "認証情報が不正")
	}
	return nil
}

func (p UserPair) Contains(actor Actor) bool {
	switch actor.Role {
	case RoleUser:
		return actor.ID == p.UserID
	case RoleFamily:
		return actor.ID == p.FamilyID
	default:
		return false
	}
}

func (p UserPair) Authorize(actor Actor, allowedRoles ...Role) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	if !p.Contains(actor) {
		return NewError(CodeForbidden, "対象を操作する権限がない")
	}
	for _, allowed := range allowedRoles {
		if actor.Role == allowed {
			return nil
		}
	}
	return NewError(CodeForbidden, "この役割では実行できない")
}
