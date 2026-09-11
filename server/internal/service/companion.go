package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

type CompanionNotifier interface {
	Enabled() bool
	PublicKey() string
	Notify(context.Context, domain.ID, string) error
}

type CompanionServiceOptions struct {
	Now            func() time.Time
	NewID          func(string) (domain.ID, error)
	OnlineAfter    time.Duration
	OfflineAfter   time.Duration
	ReconnectAfter time.Duration
}

type CompanionService struct {
	store          repository.CompanionStore
	notifier       CompanionNotifier
	logger         *slog.Logger
	now            func() time.Time
	newID          func(string) (domain.ID, error)
	onlineAfter    time.Duration
	offlineAfter   time.Duration
	reconnectAfter time.Duration
}

func NewCompanionService(store repository.CompanionStore, notifier CompanionNotifier, logger *slog.Logger, options CompanionServiceOptions) *CompanionService {
	if logger == nil {
		logger = slog.Default()
	}
	if options.Now == nil {
		options.Now = func() time.Time { return time.Now().UTC() }
	}
	if options.NewID == nil {
		options.NewID = newArtifactSupportID
	}
	if options.OnlineAfter <= 0 {
		options.OnlineAfter = time.Minute
	}
	if options.OfflineAfter <= 0 {
		options.OfflineAfter = 90 * time.Second
	}
	if options.ReconnectAfter <= 0 {
		options.ReconnectAfter = 10 * time.Minute
	}
	return &CompanionService{store: store, notifier: notifier, logger: logger, now: options.Now, newID: options.NewID, onlineAfter: options.OnlineAfter, offlineAfter: options.OfflineAfter, reconnectAfter: options.ReconnectAfter}
}

type CompanionStatus struct {
	User     domain.User
	Presence domain.UserPresence
}

func (s *CompanionService) RecordHeartbeat(ctx context.Context, actor domain.Actor) (domain.UserPresence, error) {
	if err := requireRole(actor, domain.RoleUser); err != nil {
		return domain.UserPresence{}, err
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleUser)
	if err != nil {
		return domain.UserPresence{}, err
	}
	now := s.now().UTC()
	var presence domain.UserPresence
	var notify bool
	err = s.store.WithinCompanionTransaction(ctx, func(tx repository.CompanionTx) error {
		stored, found, err := tx.LockUserPresence(ctx, pair.UserID)
		if err != nil {
			return err
		}
		if !found {
			stored, err = tx.CreateUserPresence(ctx, pair.UserID, now)
			if err != nil {
				return err
			}
		} else {
			connectedSince := *stored.ConnectedSince
			epoch := stored.ConnectionEpoch
			if now.Sub(*stored.LastSeenAt) >= s.reconnectAfter {
				connectedSince = now
				epoch++
			}
			stored.ConnectedSince = &connectedSince
			stored.LastSeenAt = &now
			stored.UpdatedAt = &now
			stored.ConnectionEpoch = epoch
			stored, err = tx.UpdateUserPresence(ctx, stored)
			if err != nil {
				return err
			}
		}
		presence = s.withComputedStatus(stored, now)
		if presence.Status != domain.PresenceOnline {
			return nil
		}
		request, found, err := tx.GetPendingSupportRequest(ctx, pair.UserID)
		if err != nil || !found {
			return err
		}
		notify, err = tx.ReservePresenceNotification(ctx, request.ID, presence.ConnectionEpoch, now)
		return err
	})
	if err != nil {
		return domain.UserPresence{}, normalizeRepositoryError(err)
	}
	if notify {
		s.notifyBestEffort(ctx, pair.FamilyID, "ONLINE_WITH_PENDING_REQUEST")
	}
	return presence, nil
}

func (s *CompanionService) GetStatus(ctx context.Context, actor domain.Actor) (CompanionStatus, error) {
	if err := requireRole(actor, domain.RoleFamily); err != nil {
		return CompanionStatus{}, err
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleFamily)
	if err != nil {
		return CompanionStatus{}, err
	}
	user, found, err := s.store.GetUser(ctx, pair.UserID)
	if err != nil {
		return CompanionStatus{}, normalizeRepositoryError(err)
	}
	if !found {
		return CompanionStatus{}, domain.NewError(domain.CodeNotFound, "利用者が見つからない")
	}
	presence, found, err := s.store.GetUserPresence(ctx, pair.UserID)
	if err != nil {
		return CompanionStatus{}, normalizeRepositoryError(err)
	}
	if !found {
		presence = domain.OfflineUserPresence(pair.UserID)
	} else {
		presence = s.withComputedStatus(presence, s.now().UTC())
	}
	return CompanionStatus{User: user, Presence: presence}, nil
}

func (s *CompanionService) VAPIDPublicKey(ctx context.Context, actor domain.Actor) (string, error) {
	if err := requireRole(actor, domain.RoleFamily); err != nil {
		return "", err
	}
	if _, err := s.authorizedPair(ctx, actor, domain.RoleFamily); err != nil {
		return "", err
	}
	if s.notifier == nil || !s.notifier.Enabled() {
		return "", domain.NewError(domain.CodeExternalServiceUnavailable, "Push通知は設定されていない")
	}
	return s.notifier.PublicKey(), nil
}

func (s *CompanionService) UpsertPushSubscription(ctx context.Context, actor domain.Actor, endpoint, p256dh, auth string) (domain.PushSubscription, error) {
	if err := requireRole(actor, domain.RoleFamily); err != nil {
		return domain.PushSubscription{}, err
	}
	if s.notifier == nil || !s.notifier.Enabled() {
		return domain.PushSubscription{}, domain.NewError(domain.CodeExternalServiceUnavailable, "Push通知は設定されていない")
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleFamily)
	if err != nil {
		return domain.PushSubscription{}, err
	}
	id, err := s.newID("push")
	if err != nil {
		return domain.PushSubscription{}, internalError("Push購読IDを生成できない", err)
	}
	now := s.now().UTC()
	subscription := domain.PushSubscription{ID: id, FamilyID: pair.FamilyID, Endpoint: endpoint, P256DH: p256dh, Auth: auth, CreatedAt: now, UpdatedAt: now, Revision: 1}
	if err := subscription.Validate(); err != nil {
		return domain.PushSubscription{}, err
	}
	var result domain.PushSubscription
	err = s.store.WithinCompanionTransaction(ctx, func(tx repository.CompanionTx) error {
		var txErr error
		result, txErr = tx.UpsertPushSubscription(ctx, subscription)
		return txErr
	})
	if err != nil {
		return domain.PushSubscription{}, normalizeRepositoryError(err)
	}
	return result, nil
}

func (s *CompanionService) DeletePushSubscription(ctx context.Context, actor domain.Actor, endpoint string) error {
	if err := requireRole(actor, domain.RoleFamily); err != nil {
		return err
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleFamily)
	if err != nil {
		return err
	}
	probe := domain.PushSubscription{ID: "push_probe", FamilyID: pair.FamilyID, Endpoint: endpoint, P256DH: "x", Auth: "x", CreatedAt: s.now().UTC(), UpdatedAt: s.now().UTC(), Revision: 1}
	if err := probe.Validate(); err != nil {
		return err
	}
	err = s.store.WithinCompanionTransaction(ctx, func(tx repository.CompanionTx) error {
		_, err := tx.DeletePushSubscription(ctx, pair.FamilyID, endpoint)
		return err
	})
	if err != nil {
		return normalizeRepositoryError(err)
	}
	return nil
}

func (s *CompanionService) NotifyRequestCreated(ctx context.Context, pair domain.UserPair, requestID domain.ID) {
	if s.notifier == nil || !s.notifier.Enabled() {
		return
	}
	now := s.now().UTC()
	reserved := false
	err := s.store.WithinCompanionTransaction(ctx, func(tx repository.CompanionTx) error {
		epoch, found, err := tx.CurrentPresenceEpoch(ctx, pair.UserID)
		if err != nil {
			return err
		}
		if !found {
			epoch = 0
		}
		reserved, err = tx.ReservePresenceNotification(ctx, requestID, epoch, now)
		return err
	})
	if err != nil {
		s.logger.WarnContext(ctx, "push notification reservation failed", "errorCode", "PUSH_RESERVATION_FAILED")
		return
	}
	if reserved {
		s.notifyBestEffort(ctx, pair.FamilyID, "NEW_SUPPORT_REQUEST")
	}
}

func (s *CompanionService) authorizedPair(ctx context.Context, actor domain.Actor, role domain.Role) (domain.UserPair, error) {
	pair, found, err := s.store.GetUserPair(ctx, actor.ID)
	if err != nil {
		return domain.UserPair{}, normalizeRepositoryError(err)
	}
	if !found {
		return domain.UserPair{}, domain.NewError(domain.CodeForbidden, "支援ペアが見つからない")
	}
	if err := pair.Authorize(actor, role); err != nil {
		return domain.UserPair{}, err
	}
	return pair, nil
}

func (s *CompanionService) withComputedStatus(presence domain.UserPresence, now time.Time) domain.UserPresence {
	if presence.LastSeenAt == nil || now.Sub(*presence.LastSeenAt) > s.offlineAfter {
		presence.Status = domain.PresenceOffline
		return presence
	}
	if presence.ConnectedSince == nil || now.Sub(*presence.ConnectedSince) < s.onlineAfter {
		presence.Status = domain.PresenceConnecting
		return presence
	}
	presence.Status = domain.PresenceOnline
	return presence
}

func (s *CompanionService) notifyBestEffort(ctx context.Context, familyID domain.ID, kind string) {
	if s.notifier == nil || !s.notifier.Enabled() {
		return
	}
	if err := s.notifier.Notify(ctx, familyID, kind); err != nil {
		s.logger.WarnContext(ctx, "push delivery failed", "errorCode", "PUSH_DELIVERY_FAILED")
	}
}

type CompanionEventPublisher struct {
	Events    EventPublisher
	Companion *CompanionService
}

func (p CompanionEventPublisher) Publish(ctx context.Context, event domain.Event) error {
	err := p.Events.Publish(ctx, event)
	if event.Type == domain.EventSupportRequestCreated && p.Companion != nil {
		p.Companion.NotifyRequestCreated(ctx, event.Audience, event.EntityID)
	}
	return err
}
