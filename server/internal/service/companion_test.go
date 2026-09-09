package service

import (
	"context"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

func TestCompanionHeartbeatNotifiesOncePerMeaningfulConnection(t *testing.T) {
	base := time.Date(2026, 9, 10, 1, 0, 0, 0, time.UTC)
	now := base
	store := newFakeCompanionStore(base)
	notifier := &fakeCompanionNotifier{}
	service := NewCompanionService(store, notifier, nil, CompanionServiceOptions{
		Now: func() time.Time { return now }, OnlineAfter: time.Minute,
		OfflineAfter: 90 * time.Second, ReconnectAfter: 10 * time.Minute,
	})
	actor := domain.Actor{ID: store.pair.UserID, Role: domain.RoleUser}

	presence, err := service.RecordHeartbeat(context.Background(), actor)
	if err != nil || presence.Status != domain.PresenceConnecting {
		t.Fatalf("initial heartbeat = %#v, %v", presence, err)
	}
	now = base.Add(time.Minute)
	presence, err = service.RecordHeartbeat(context.Background(), actor)
	if err != nil || presence.Status != domain.PresenceOnline || notifier.count != 1 {
		t.Fatalf("confirmed heartbeat = %#v, notifications=%d, %v", presence, notifier.count, err)
	}
	now = base.Add(2 * time.Minute)
	_, _ = service.RecordHeartbeat(context.Background(), actor)
	if notifier.count != 1 {
		t.Fatalf("same connection sent %d notifications", notifier.count)
	}
	now = base.Add(13 * time.Minute)
	presence, err = service.RecordHeartbeat(context.Background(), actor)
	if err != nil || presence.Status != domain.PresenceConnecting || presence.ConnectionEpoch != 2 {
		t.Fatalf("reconnect heartbeat = %#v, %v", presence, err)
	}
	now = base.Add(14 * time.Minute)
	_, err = service.RecordHeartbeat(context.Background(), actor)
	if err != nil || notifier.count != 2 {
		t.Fatalf("second connection notifications=%d, %v", notifier.count, err)
	}
}

func TestCompanionStatusBecomesOfflineAfterHeartbeatTimeout(t *testing.T) {
	base := time.Date(2026, 9, 10, 1, 0, 0, 0, time.UTC)
	now := base
	store := newFakeCompanionStore(base)
	service := NewCompanionService(store, &fakeCompanionNotifier{}, nil, CompanionServiceOptions{Now: func() time.Time { return now }})
	_, _ = service.RecordHeartbeat(context.Background(), domain.Actor{ID: store.pair.UserID, Role: domain.RoleUser})
	now = base.Add(91 * time.Second)
	status, err := service.GetStatus(context.Background(), domain.Actor{ID: store.pair.FamilyID, Role: domain.RoleFamily})
	if err != nil {
		t.Fatal(err)
	}
	if status.Presence.Status != domain.PresenceOffline {
		t.Fatalf("status = %s", status.Presence.Status)
	}
}

type fakeCompanionStore struct {
	pair          domain.UserPair
	user          domain.User
	presence      *domain.UserPresence
	pending       *domain.SupportRequest
	reservations  map[int64]bool
	subscriptions []domain.PushSubscription
}

func newFakeCompanionStore(now time.Time) *fakeCompanionStore {
	pair := domain.UserPair{UserID: "user_demo", FamilyID: "family_demo"}
	request := domain.SupportRequest{ID: "request_demo", UserID: pair.UserID, FamilyID: pair.FamilyID, InitialScreenshotArtifactID: "artifact_demo", Status: domain.SupportRequestPending, CreatedAt: now, UpdatedAt: now, Revision: 1}
	return &fakeCompanionStore{pair: pair, user: domain.User{ID: pair.UserID, Role: domain.RoleUser, DisplayName: "祖父"}, pending: &request, reservations: map[int64]bool{}}
}

func (s *fakeCompanionStore) WithinCompanionTransaction(_ context.Context, work func(repository.CompanionTx) error) error {
	return work((*fakeCompanionTx)(s))
}
func (s *fakeCompanionStore) GetUserPair(context.Context, domain.ID) (domain.UserPair, bool, error) {
	return s.pair, true, nil
}
func (s *fakeCompanionStore) GetUser(context.Context, domain.ID) (domain.User, bool, error) {
	return s.user, true, nil
}
func (s *fakeCompanionStore) GetUserPresence(context.Context, domain.ID) (domain.UserPresence, bool, error) {
	if s.presence == nil {
		return domain.UserPresence{}, false, nil
	}
	return *s.presence, true, nil
}
func (s *fakeCompanionStore) ListPushSubscriptions(context.Context, domain.ID) ([]domain.PushSubscription, error) {
	return s.subscriptions, nil
}
func (s *fakeCompanionStore) DeletePushSubscriptionByID(context.Context, domain.ID) error { return nil }

type fakeCompanionTx fakeCompanionStore

func (t *fakeCompanionTx) LockUserPresence(context.Context, domain.ID) (domain.UserPresence, bool, error) {
	if t.presence == nil {
		return domain.UserPresence{}, false, nil
	}
	return *t.presence, true, nil
}
func (t *fakeCompanionTx) CreateUserPresence(_ context.Context, userID domain.ID, now time.Time) (domain.UserPresence, error) {
	connected, seen, updated := now, now, now
	presence := domain.UserPresence{UserID: userID, ConnectedSince: &connected, LastSeenAt: &seen, UpdatedAt: &updated, ConnectionEpoch: 1, Revision: 1}
	t.presence = &presence
	return presence, nil
}
func (t *fakeCompanionTx) UpdateUserPresence(_ context.Context, presence domain.UserPresence) (domain.UserPresence, error) {
	presence.Revision++
	t.presence = &presence
	return presence, nil
}
func (t *fakeCompanionTx) GetPendingSupportRequest(context.Context, domain.ID) (domain.SupportRequest, bool, error) {
	if t.pending == nil {
		return domain.SupportRequest{}, false, nil
	}
	return *t.pending, true, nil
}
func (t *fakeCompanionTx) ReservePresenceNotification(_ context.Context, _ domain.ID, epoch int64, _ time.Time) (bool, error) {
	if t.reservations[epoch] {
		return false, nil
	}
	t.reservations[epoch] = true
	return true, nil
}
func (t *fakeCompanionTx) CurrentPresenceEpoch(context.Context, domain.ID) (int64, bool, error) {
	if t.presence == nil {
		return 0, false, nil
	}
	return t.presence.ConnectionEpoch, true, nil
}
func (t *fakeCompanionTx) UpsertPushSubscription(_ context.Context, subscription domain.PushSubscription) (domain.PushSubscription, error) {
	return subscription, nil
}
func (t *fakeCompanionTx) DeletePushSubscription(context.Context, domain.ID, string) (bool, error) {
	return true, nil
}

type fakeCompanionNotifier struct{ count int }

func (n *fakeCompanionNotifier) Enabled() bool     { return true }
func (n *fakeCompanionNotifier) PublicKey() string { return "public" }
func (n *fakeCompanionNotifier) Notify(context.Context, domain.ID, string) error {
	n.count++
	return nil
}
